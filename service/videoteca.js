'use strict';
/* Videoteca: películas y series con aspecto de plataforma de streaming.
 *
 * Fuentes (todas legítimas):
 *  - Internet Archive (archive.org): películas de dominio público, con su API
 *    abierta.  Filas por colección; se filtra el contenido para adultos.
 *  - Carpetas del PC que elige el usuario (solo desde el proceso principal,
 *    con el diálogo de Windows): sus vídeos, con el nombre limpio y, si hay,
 *    la carátula de la carpeta (poster.jpg, folder.jpg…).
 *
 * Reproducción: Internet Archive entrega MP4 (H.264) por HTTPS, que el
 * reproductor abre directamente.  Los archivos del PC se sirven por el proxy
 * local (con rangos); los formatos que el navegador no abre (.mkv, .avi…)
 * pasan por FFmpeg (Modo fluido).  La página nunca recibe rutas del PC.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var proxy = require('./proxy');
var relay = require('./ffmpeg-relay');
var timing = require('./timing');

var IA_SEARCH = 'https://archive.org/advancedsearch.php';
var IA_META = 'https://archive.org/metadata/';
var IA_IMG = 'https://archive.org/services/img/';
var IA_DOWNLOAD = 'https://archive.org/download/';
var IA_TIMEOUT_MS = 15000;
var ROW_SIZE = 24;
var PAGE_SIZE = 60;
var CACHE_MS = 6 * 60 * 60 * 1000;
var MAX_FOLDERS = 10;
var MAX_FILES = 8000;
var MAX_DEPTH = 5;
var UA = 'XuperDesktop (Videoteca)';

var VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|ts|wmv|flv)$/i;
var DIRECT_EXT = /\.(mp4|m4v|mov|webm)$/i;
var POSTER_NAMES = ['poster', 'folder', 'cover', 'portada', 'caratula'];

/* Contenido para adultos: fuera, en la búsqueda y otra vez al recibir los
   resultados (Archive tiene películas de "explotación" mal etiquetadas). */
var IA_EXCLUDE = ' AND NOT subject:(sex OR sexo OR erotic OR erotica OR porn OR pornography OR adult OR adults OR nudity OR nudist OR burlesque OR stag OR sexploitation OR softcore)' +
  ' AND NOT title:(sex OR sexo OR erotic OR erotica OR porn OR nude OR nudist OR naked OR molester OR burlesque OR stag OR sexuellement OR pleasure OR lust)';
var ADULT_RE = /\b(sex|sexo|sexual|sexuell\w*|er[oó]tic\w*|porn\w*|nude|nudist\w*|naked|desnud\w*|softcore|sexploitation|burlesque|stag film|molest\w*|lujuria|lust)\b/i;

/* Filas de la portada: colecciones reales de archive.org (comprobadas). */
var ROWS = [
  { id: 'populares', title: 'Clásicos más vistos', q: 'collection:(feature_films) AND mediatype:(movies) AND year:[1920 TO 1995]' },
  { id: 'espanol', title: 'En español', q: 'collection:(feature_films) AND mediatype:(movies) AND language:(Spanish OR spa)' },
  { id: 'noir', title: 'Cine negro', q: 'collection:(Film_Noir) AND mediatype:(movies)' },
  { id: 'terror', title: 'Terror y ciencia ficción', q: 'collection:(SciFi_Horror) AND mediatype:(movies)' },
  { id: 'comedia', title: 'Comedia clásica', q: 'collection:(Comedy_Films) AND mediatype:(movies)' },
  { id: 'oeste', title: 'Del oeste', q: 'collection:(feature_films) AND mediatype:(movies) AND subject:(western)' },
  { id: 'mudo', title: 'Cine mudo', q: 'collection:(silent_films) AND mediatype:(movies)' },
  { id: 'dibujos', title: 'Dibujos animados clásicos', q: 'collection:(classic_cartoons) AND mediatype:(movies)' }
];

/* ------------------------------------------------------------ almacenamiento */
var memIndex = null;          // { folders: [ruta], favorites: {id: título}, local: {id: título} }
var memCache = {};            // clave -> { at, data }

function dataDir() {
  var base = process.env.XUPER_DATA_DIR;
  if (!base) { return ''; }
  var dir = path.join(base, 'videoteca');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (eDir) { return ''; }
  return dir;
}
function writeJson(file, value) {
  var dir = dataDir();
  if (!dir) { return; }
  var target = path.join(dir, file), tmp = target + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, target); }
  catch (eWrite) { try { fs.unlinkSync(tmp); } catch (eTmp) { /* nada */ } }
}
function readJson(file) {
  var dir = dataDir();
  if (!dir) { return null; }
  try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (eRead) { return null; }
}
function loadIndex() {
  if (memIndex) { return memIndex; }
  var saved = readJson('index.json') || {};
  memIndex = {
    folders: Array.isArray(saved.folders) ? saved.folders : [],
    favorites: saved.favorites && typeof saved.favorites === 'object' ? saved.favorites : {},
    local: saved.local && typeof saved.local === 'object' ? saved.local : {},
    scannedAt: saved.scannedAt || 0
  };
  return memIndex;
}
function saveIndex() { writeJson('index.json', loadIndex()); }

function hashKey(text) { return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16); }
function cleanText(value, max) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 300);
}
function first(value) { return Array.isArray(value) ? value[0] : value; }
function list(value) { return value == null ? [] : (Array.isArray(value) ? value : [value]); }

/* ---------------------------------------------------------- Internet Archive */
function getJson(url, done) {
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctrl) { ctrl.abort(); } }, IA_TIMEOUT_MS);
  fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined })
    .then(function (res) {
      if (!res.ok) { throw new Error('Internet Archive respondió con un error (HTTP ' + res.status + ')'); }
      return res.json();
    })
    .then(function (json) { clearTimeout(timer); done(null, json); },
      function (err) {
        clearTimeout(timer);
        done(new Error(err && err.name === 'AbortError' ? 'Internet Archive tardó demasiado en responder' : (err && err.message) || 'Sin conexión con Internet Archive'));
      });
}

function isAdult(doc) {
  return ADULT_RE.test(String(doc.title || '')) || ADULT_RE.test(list(doc.subject).join(' ')) ||
    ADULT_RE.test(String(first(doc.description) || '').slice(0, 600));
}

/* Géneros de Archive (subject, en inglés y desordenados) -> los nuestros. */
var GENRES = [
  [/horror|terror|monster|zombie|vampire/i, 'Terror'], [/sci-?fi|science fiction|ciencia ficci/i, 'Ciencia ficción'],
  [/noir|crime|gangster|detective|mystery|thriller/i, 'Policial'], [/comed/i, 'Comedia'], [/western|cowboy/i, 'Del oeste'],
  [/drama/i, 'Drama'], [/war\b|guerra|world war/i, 'Bélica'], [/romance|romantic/i, 'Romance'], [/musical|music/i, 'Musical'],
  [/adventure|aventura/i, 'Aventura'], [/cartoon|animat/i, 'Animación'], [/document/i, 'Documental'], [/silent|mudo/i, 'Cine mudo'],
  [/family|children|kids/i, 'Familiar'], [/action|acci[oó]n/i, 'Acción']
];
function genresOf(subjects) {
  var text = list(subjects).join(' ; '), out = [];
  GENRES.forEach(function (g) { if (g[0].test(text) && out.indexOf(g[1]) < 0) { out.push(g[1]); } });
  return out.slice(0, 3);
}

function iaTitle(doc) {
  var id = String(doc.identifier || '');
  var year = parseInt(doc.year, 10) || 0;
  /* "Suddenly (1954)" y similares: el año ya va aparte. */
  var name = cleanText(doc.title, 140).replace(/\s*\((19|20)\d{2}\)\s*$/, '') || id;
  return {
    id: 'vt:ia:' + id, type: 'movie', title: name, year: year, runtime: 0, rating: 0,
    genres: genresOf(doc.subject), overview: cleanText(String(first(doc.description) || '').replace(/https?:\/\/\S+/g, ' '), 600),
    poster: IA_IMG + encodeURIComponent(id), backdrop: IA_IMG + encodeURIComponent(id),
    source: 'archive', sourceName: 'Internet Archive · dominio público'
  };
}

function iaSearch(q, page, rows, done) {
  var url = IA_SEARCH + '?q=' + encodeURIComponent(q + IA_EXCLUDE) +
    '&fl[]=identifier&fl[]=title&fl[]=year&fl[]=subject&fl[]=description&sort[]=downloads+desc' +
    '&rows=' + rows + '&page=' + page + '&output=json';
  var key = 'q|' + url;
  var hit = memCache[key];
  if (hit && Date.now() - hit.at < CACHE_MS) { return done(null, hit.data); }
  getJson(url, function (err, json) {
    if (err) {
      /* Sin conexión: la última copia guardada de esa fila, si la hay. */
      var saved = readJson('cache-' + hashKey(key) + '.json');
      return saved ? done(null, saved) : done(err);
    }
    var docs = (json && json.response && json.response.docs) || [];
    var seen = {}, items = [];
    docs.forEach(function (d) {
      if (!d.identifier || isAdult(d)) { return; }
      var t = iaTitle(d);
      /* La misma película subida dos veces ("McLintock!" / "Mclintock"). */
      var k = t.title.normalize('NFD').replace(/[^a-z0-9]/gi, '').toLowerCase() + '|' + t.year;
      if (seen[k]) { return; }
      seen[k] = true;
      items.push(t);
    });
    var data = { items: items, total: (json.response && json.response.numFound) || items.length };
    memCache[key] = { at: Date.now(), data: data };
    writeJson('cache-' + hashKey(key) + '.json', data);
    done(null, data);
  });
}

/* El mejor MP4 de una ficha: H.264 hasta 720p; si no hay MP4, otro formato por FFmpeg. */
function pickArchiveFile(files) {
  var vids = (files || []).filter(function (f) { return f && f.name && /\.(mp4|m4v|ogv|mpeg|mpg|avi|mkv)$/i.test(f.name); });
  var mp4 = vids.filter(function (f) { return /\.(mp4|m4v)$/i.test(f.name); });
  function height(f) { return parseInt(f.height, 10) || (/512kb/i.test(f.name) ? 240 : 360); }
  mp4.sort(function (a, b) {
    var ha = height(a), hb = height(b);
    var sa = ha <= 720 ? ha : 0, sb = hb <= 720 ? hb : 0;
    return sb - sa || (parseInt(b.size, 10) || 0) - (parseInt(a.size, 10) || 0);
  });
  if (mp4.length) { return { name: mp4[0].name, direct: true, length: parseFloat(mp4[0].length) || 0 }; }
  var other = vids.filter(function (f) { return !/\.ogv$/i.test(f.name); });
  if (other.length) { return { name: other[0].name, direct: false, length: parseFloat(other[0].length) || 0 }; }
  return null;
}

function runtimeMinutes(meta, file) {
  var r = String(meta && meta.runtime || '');
  var hms = /^(\d+):(\d{2}):(\d{2})/.exec(r), mins = /(\d+)\s*min/i.exec(r);
  if (hms) { return parseInt(hms[1], 10) * 60 + parseInt(hms[2], 10); }
  if (mins) { return parseInt(mins[1], 10); }
  if (file && file.length) { return Math.round(file.length / 60); }
  return 0;
}

function iaDetail(identifier, done) {
  var key = 'meta|' + identifier;
  var hit = memCache[key];
  if (hit && Date.now() - hit.at < CACHE_MS) { return done(null, hit.data); }
  getJson(IA_META + encodeURIComponent(identifier), function (err, json) {
    if (err) { return done(err); }
    if (!json || !json.metadata) { return done(new Error('Esta película ya no está en Internet Archive')); }
    var m = json.metadata;
    var doc = { identifier: identifier, title: first(m.title), year: parseInt(String(first(m.year) || first(m.date) || ''), 10) || 0,
      subject: m.subject, description: first(m.description) };
    if (isAdult(doc)) { return done(new Error('Este título no está disponible en la Videoteca')); }
    var t = iaTitle(doc);
    var file = pickArchiveFile(json.files);
    t.runtime = runtimeMinutes(m, file);
    t.language = String(first(m.language) || '').replace(/^spa$/i, 'Español').replace(/^eng$/i, 'Inglés');
    t.playable = !!file;
    var data = { title: t, file: file, server: json.d1 || '', dir: json.dir || '' };
    memCache[key] = { at: Date.now(), data: data };
    done(null, data);
  });
}

/* -------------------------------------------------------- carpetas del PC */
var QUALITY_RE = /\b(2160p|1080p|720p|480p|4k|uhd|hdr|hdrip|brrip|bdrip|bluray|blu-ray|web-?dl|webrip|dvdrip|dvd|hdtv|x26[45]|h\.?26[45]|hevc|aac|ac3|dts|5\.1|latino|castellano|espa[nñ]ol|spanish|dual|subt?(itulado)?s?|vose|extended|remastered|proper|repack|yify|rarbg)\b.*$/i;

/* "The.Matrix.1999.1080p.BluRay.x264.mkv" -> { title: "The Matrix", year: 1999 }
   "Mi.Serie.S01E02.Titulo.mkv" -> serie, temporada 1, episodio 2. */
function parseFileName(fileName) {
  var base = path.basename(fileName).replace(/\.[^.]+$/, '');
  var text = base.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  var ep = /^(.*?)[\s-]*\b[sS](\d{1,2})[\s.]?[eE](\d{1,3})\b(.*)$/.exec(text) || /^(.*?)[\s-]*\b(\d{1,2})x(\d{2,3})\b(.*)$/.exec(text);
  if (ep && ep[1].trim()) {
    var epTitle = ep[4].replace(QUALITY_RE, '').replace(/^[\s-]+|[\s-]+$/g, '');
    return { series: cleanName(ep[1]), season: parseInt(ep[2], 10), episode: parseInt(ep[3], 10), episodeTitle: epTitle };
  }
  var year = 0;
  var y = /^(.*?)[\s(\[]+((?:19|20)\d{2})(?:[)\]\s]|$)/.exec(text);
  if (y && y[1].trim()) { year = parseInt(y[2], 10); text = y[1]; }
  return { title: cleanName(text) || base, year: year };
}
function cleanName(text) {
  return String(text || '').replace(QUALITY_RE, '').replace(/[\[(][^\])]*[\])]/g, ' ').replace(/[\s-]+$/g, '').replace(/\s+/g, ' ').trim();
}

function findPoster(dir, baseNoExt, names) {
  var lower = {};
  names.forEach(function (n) { lower[n.toLowerCase()] = n; });
  var candidates = [baseNoExt + '.jpg', baseNoExt + '.png', baseNoExt + '-poster.jpg'].concat(
    POSTER_NAMES.reduce(function (acc, p) { return acc.concat([p + '.jpg', p + '.jpeg', p + '.png', p + '.webp']); }, []));
  for (var i = 0; i < candidates.length; i++) {
    var real = lower[candidates[i].toLowerCase()];
    if (real) { return path.join(dir, real); }
  }
  return '';
}

/* Recorre las carpetas (hasta MAX_DEPTH niveles) y arma películas y series. */
function scanFolders(folders) {
  var files = [];
  function walk(dir, depth) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) { return; }
    var names;
    try { names = fs.readdirSync(dir); } catch (eDir) { return; }
    names.forEach(function (name) {
      if (files.length >= MAX_FILES || name.charAt(0) === '.' || /^\$|^System Volume Information$/i.test(name)) { return; }
      var full = path.join(dir, name), st;
      try { st = fs.statSync(full); } catch (eSt) { return; }
      if (st.isDirectory()) { return walk(full, depth + 1); }
      if (!VIDEO_EXT.test(name) || /\bsample\b/i.test(name) || st.size < 20 * 1024 * 1024) { return; }
      files.push({ path: full, dir: dir, name: name, names: names, size: st.size, mtime: st.mtimeMs });
    });
  }
  folders.forEach(function (f) { walk(f, 0); });

  var local = {}, seriesMap = {};
  files.forEach(function (f) {
    var info = parseFileName(f.name);
    var poster = findPoster(f.dir, f.name.replace(/\.[^.]+$/, ''), f.names);
    if (info.series) {
      var sKey = info.series.toLowerCase();
      var s = seriesMap[sKey];
      if (!s) {
        s = seriesMap[sKey] = { id: 'vt:local:s' + hashKey(sKey), type: 'series', title: info.series, year: 0, genres: [],
          overview: '', source: 'local', sourceName: 'Mis carpetas', poster: '', addedAt: 0, episodes: [] };
      }
      if (!s.poster) { s.poster = poster || findPoster(path.dirname(f.dir), '', safeList(path.dirname(f.dir))); }
      s.addedAt = Math.max(s.addedAt, f.mtime);
      s.episodes.push({ id: 'vt:local:' + hashKey(f.path), season: info.season, number: info.episode,
        title: info.episodeTitle || ('Episodio ' + info.episode), file: f.path });
      return;
    }
    var id = 'vt:local:' + hashKey(f.path);
    local[id] = { id: id, type: 'movie', title: info.title, year: info.year, genres: [], overview: '', source: 'local',
      sourceName: 'Mis carpetas', poster: poster, file: f.path, addedAt: f.mtime, size: f.size };
  });
  Object.keys(seriesMap).forEach(function (k) {
    var s = seriesMap[k];
    s.episodes.sort(function (a, b) { return a.season - b.season || a.number - b.number; });
    local[s.id] = s;
  });
  return { local: local, files: files.length };
}
function safeList(dir) { try { return fs.readdirSync(dir); } catch (e) { return []; } }

function rescan(done) {
  var idx = loadIndex();
  var t0 = Date.now();
  var result = scanFolders(idx.folders);
  idx.local = result.local;
  idx.scannedAt = Date.now();
  saveIndex();
  timing.log('videoteca: carpetas revisadas en ' + (Date.now() - t0) + 'ms (' + result.files + ' vídeos, ' + Object.keys(result.local).length + ' títulos)');
  if (done) { done(null, { titles: Object.keys(result.local).length, files: result.files }); }
}

/* Solo desde el proceso principal (diálogo de Windows). */
function addFolder(dir, done) {
  var idx = loadIndex();
  var resolved = path.resolve(String(dir || ''));
  try { if (!fs.statSync(resolved).isDirectory()) { throw new Error('x'); } }
  catch (eSt) { return done(new Error('No se pudo abrir la carpeta')); }
  if (idx.folders.some(function (f) { return path.resolve(f) === resolved; })) { return rescan(function (err, r) { done(err, Object.assign({ folder: path.basename(resolved), already: true }, r)); }); }
  if (idx.folders.length >= MAX_FOLDERS) { return done(new Error('Puedes tener hasta ' + MAX_FOLDERS + ' carpetas')); }
  idx.folders.push(resolved);
  rescan(function (err, r) { done(err, Object.assign({ folder: path.basename(resolved) }, r)); });
}

function removeFolder(params, done) {
  var idx = loadIndex();
  var i = Number(params && params.index);
  if (!(i >= 0 && i < idx.folders.length)) { return done(new Error('Esa carpeta ya no está')); }
  idx.folders.splice(i, 1);
  rescan(done);
}

/* Lo que ve la página de un título del PC: sin rutas. */
function localForPage(t) {
  var out = { id: t.id, type: t.type, title: t.title, year: t.year || 0, genres: [], overview: t.overview || '',
    source: 'local', sourceName: t.sourceName, addedAt: t.addedAt || 0, runtime: 0, rating: 0 };
  if (t.poster) { out.poster = proxy.addLocal(t.poster); out.backdrop = out.poster; }
  if (t.type === 'series') {
    out.episodes = (t.episodes || []).map(function (e) { return { id: e.id, season: e.season, number: e.number, title: e.title }; });
    out.overview = out.overview || (out.episodes.length + (out.episodes.length === 1 ? ' episodio' : ' episodios') + ' en tus carpetas');
  } else if (t.size) {
    out.overview = out.overview || 'Archivo de tu PC · ' + (t.size / 1073741824).toFixed(1).replace('.', ',') + ' GB';
  }
  return out;
}

function localTitles() {
  var local = loadIndex().local;
  return Object.keys(local).map(function (k) { return localForPage(local[k]); })
    .sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
}

function findLocalEpisode(id) {
  var local = loadIndex().local;
  if (local[id]) { return { title: local[id], file: local[id].file }; }
  var keys = Object.keys(local);
  for (var i = 0; i < keys.length; i++) {
    var t = local[keys[i]];
    if (t.type !== 'series') { continue; }
    for (var j = 0; j < t.episodes.length; j++) { if (t.episodes[j].id === id) { return { title: t, episode: t.episodes[j], file: t.episodes[j].file }; } }
  }
  return null;
}

/* ------------------------------------------------------------------- API */
function publicSources() {
  var idx = loadIndex();
  return { folders: idx.folders.map(function (f) { return path.basename(f) || f; }), localCount: Object.keys(idx.local).length };
}

function home(params, done) {
  proxy.start(function (perr) {
    if (perr) { return done(perr); }
    var kind = String(params && params.kind || 'all');
    var rows = [], hero = [], errors = [];
    var local = localTitles();
    var favs = favoriteTitles();
    if (kind === 'fav') {
      return done(null, { hero: [], rows: favs.length ? [{ id: 'fav', title: 'Mis favoritos', items: favs, more: false }] : [], sources: publicSources() });
    }
    if (local.length) {
      var movies = local.filter(function (t) { return t.type === 'movie'; });
      var series = local.filter(function (t) { return t.type === 'series'; });
      if (kind !== 'series' && movies.length) { rows.push({ id: 'local-movies', title: 'Películas de mis carpetas', items: movies.slice(0, ROW_SIZE), more: movies.length > ROW_SIZE }); }
      if (kind !== 'movie' && series.length) { rows.push({ id: 'local-series', title: 'Series de mis carpetas', items: series.slice(0, ROW_SIZE), more: series.length > ROW_SIZE }); }
    }
    if (kind === 'series') { return done(null, { hero: [], rows: rows, sources: publicSources() }); }
    var pending = ROWS.length;
    var byId = {};
    ROWS.forEach(function (r) {
      iaSearch(r.q, 1, ROW_SIZE + 8, function (err, data) {
        if (err) { errors.push(err.message); } else { byId[r.id] = data; }
        if (--pending) { return; }
        ROWS.forEach(function (row) {
          var d = byId[row.id];
          if (d && d.items.length) { rows.push({ id: 'ia:' + row.id, title: row.title, items: d.items.slice(0, ROW_SIZE), more: d.total > ROW_SIZE, source: 'archive' }); }
        });
        /* Destacados: los primeros de varias filas, con descripción. */
        ['populares', 'noir', 'terror', 'comedia', 'oeste'].forEach(function (k) {
          var d = byId[k];
          var pick = d && d.items.filter(function (t) { return t.overview && hero.every(function (h) { return h.id !== t.id; }); })[0];
          if (pick) { hero.push(pick); }
        });
        done(null, { hero: hero, rows: rows, sources: publicSources(), error: errors.length === ROWS.length ? errors[0] : '' });
      });
    });
  });
}

function browse(params, done) {
  var row = String(params && params.row || '');
  var page = Math.max(1, parseInt(params && params.page, 10) || 1);
  proxy.start(function (perr) {
    if (perr) { return done(perr); }
    if (row === 'local-movies' || row === 'local-series') {
      var all = localTitles().filter(function (t) { return t.type === (row === 'local-movies' ? 'movie' : 'series'); });
      return done(null, { items: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: all.length, page: page, more: all.length > page * PAGE_SIZE });
    }
    var def = ROWS.filter(function (r) { return 'ia:' + r.id === row; })[0];
    if (!def) { return done(new Error('Esa fila ya no existe')); }
    iaSearch(def.q, page, PAGE_SIZE, function (err, data) {
      if (err) { return done(err); }
      done(null, { items: data.items, total: data.total, page: page, more: data.total > page * PAGE_SIZE });
    });
  });
}

function search(params, done) {
  var q = cleanText(params && params.q, 80);
  if (q.length < 2) { return done(null, { items: [] }); }
  proxy.start(function () {
    var fold = function (s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); };
    var words = fold(q).split(/\s+/);
    var local = localTitles().filter(function (t) { var f = fold(t.title); return words.every(function (w) { return f.indexOf(w) !== -1; }); });
    var safe = q.replace(/["\\():^~*?\[\]{}]/g, ' ').trim();
    iaSearch('mediatype:(movies) AND collection:(feature_films OR Film_Noir OR SciFi_Horror OR Comedy_Films OR silent_films OR classic_cartoons) AND title:(' + safe + ')', 1, 40, function (err, data) {
      done(null, { items: local.slice(0, 40).concat(err ? [] : data.items), error: err ? err.message : '' });
    });
  });
}

function title(params, done) {
  var id = String(params && params.id || '');
  proxy.start(function () {
    if (id.indexOf('vt:ia:') === 0) {
      return iaDetail(id.slice(6), function (err, data) { done(err, err ? null : { title: data.title }); });
    }
    var hit = findLocalEpisode(id);
    if (!hit) { return done(new Error('Este archivo ya no está en tus carpetas')); }
    done(null, { title: localForPage(hit.title) });
  });
}

/* Dirección para el reproductor.  smooth = Modo fluido (FFmpeg). */
function play(params, done) {
  var id = String(params && params.id || '');
  var smooth = params && params.smooth === true;
  proxy.start(function (perr) {
    if (perr) { return done(perr); }
    if (id.indexOf('vt:ia:') === 0) {
      var identifier = id.slice(6);
      return iaDetail(identifier, function (err, data) {
        if (err) { return done(err); }
        if (!data.file) { return done(new Error('Esta película no tiene un vídeo que se pueda reproducir')); }
        var url = IA_DOWNLOAD + encodeURIComponent(identifier) + '/' + data.file.name.split('/').map(encodeURIComponent).join('/');
        timing.log('videoteca: Internet Archive | ' + (data.file.direct && !smooth ? 'directo (MP4)' : 'FFmpeg'));
        if (data.file.direct && !smooth) { return done(null, { url: url, mime: 'video/mp4', duration: data.file.length }); }
        if (!relay.available()) { return done(new Error('Este vídeo necesita FFmpeg (Modo fluido) y no está disponible')); }
        done(null, { url: relay.register({ url: url, headers: { 'User-Agent': UA } }, {}), isRelay: true, duration: data.file.length });
      });
    }
    var hit = findLocalEpisode(id);
    if (!hit || !hit.file) { return done(new Error('Este archivo ya no está en tus carpetas')); }
    if (!fs.existsSync(hit.file)) { return done(new Error('No se encontró el archivo (¿se movió o se desconectó el disco?)')); }
    var direct = DIRECT_EXT.test(hit.file) && !smooth;
    timing.log('videoteca: archivo del PC | ' + (direct ? 'directo' : 'FFmpeg'));
    if (direct) { return done(null, { url: proxy.addLocal(hit.file), mime: /\.webm$/i.test(hit.file) ? 'video/webm' : 'video/mp4' }); }
    if (!relay.available()) { return done(new Error('Este formato necesita FFmpeg (Modo fluido) y no está disponible')); }
    /* Por FFmpeg el reproductor no conoce la duración: se lee del archivo. */
    fileDuration(hit.file, function (seconds) {
      done(null, { url: relay.register({ url: hit.file, headers: {} }, {}), isRelay: true, duration: seconds });
    });
  });
}

/* "Duration: 01:42:13.05" de la salida de FFmpeg (0 si no se puede saber). */
var durationCache = {};
function fileDuration(file, done) {
  if (durationCache[file] !== undefined) { return done(durationCache[file]); }
  var out = '', finished = false, child;
  function finish() {
    if (finished) { return; }
    finished = true;
    var m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(out);
    var seconds = m ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]) : 0;
    durationCache[file] = seconds;
    try { child.kill(); } catch (eKill) { /* ya terminó */ }
    done(seconds);
  }
  try {
    child = require('child_process').spawn(relay.path(), ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
  } catch (eSpawn) { return done(0); }
  child.stderr.on('data', function (d) { out += String(d); if (out.length > 20000) { finish(); } });
  child.on('close', finish);
  child.on('error', finish);
  setTimeout(finish, 8000);
}

/* Favoritos: se guarda una copia del título (Archive puede cambiar). */
function favoriteTitles() {
  var favs = loadIndex().favorites, local = loadIndex().local;
  return Object.keys(favs).map(function (id) {
    if (id.indexOf('vt:local:') === 0) { return local[id] ? localForPage(local[id]) : null; }
    return favs[id];
  }).filter(Boolean);
}
function favorite(params, done) {
  var t = params && params.title;
  var idx = loadIndex();
  if (!t || !/^vt:(ia|local):/.test(String(t.id || ''))) { return done(new Error('Título no válido')); }
  if (params.on) {
    idx.favorites[t.id] = String(t.id).indexOf('vt:ia:') === 0 ? {
      id: t.id, type: 'movie', title: cleanText(t.title, 140), year: parseInt(t.year, 10) || 0, genres: (t.genres || []).slice(0, 3),
      overview: cleanText(t.overview, 600), poster: IA_IMG + encodeURIComponent(t.id.slice(6)), backdrop: IA_IMG + encodeURIComponent(t.id.slice(6)),
      source: 'archive', sourceName: 'Internet Archive · dominio público'
    } : { id: t.id };
  } else {
    delete idx.favorites[t.id];
  }
  saveIndex();
  done(null, { favorites: Object.keys(idx.favorites) });
}
function favorites(params, done) { done(null, { favorites: Object.keys(loadIndex().favorites), sources: publicSources() }); }

module.exports = {
  home: home, browse: browse, search: search, title: title, play: play,
  favorite: favorite, favorites: favorites, removeFolder: removeFolder,
  rescan: function (params, done) { rescan(done); },
  addFolder: addFolder,
  _parseFileName: parseFileName, _pickArchiveFile: pickArchiveFile, _isAdult: isAdult, _scanFolders: scanFolders, _genresOf: genresOf
};
