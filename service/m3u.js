'use strict';
/* "Mis listas": listas M3U que añade el propio usuario (una dirección o un
 * archivo del PC).  La app no trae ninguna lista: solo las reproduce.
 *
 * - Las listas se descargan aquí (sin las restricciones CORS de la página) y
 *   se guardan ya leídas en <datos del usuario>/mylists, así abren al instante
 *   y siguen disponibles si el servidor de la lista se cae.
 * - Mantenimiento: las listas por dirección se actualizan solas una vez al
 *   día; las de un archivo del PC se vuelven a leer cuando el archivo cambia.
 *   Las categorías equivalentes ("Music", "MÚSICA", "Música") son una sola.
 * - "Comprobar canales": prueba cada canal (pocos bytes) y marca los caídos.
 * - Guía de programación: si la lista indica una guía XMLTV (url-tvg) o el
 *   usuario la escribe, se descarga y se guarda solo lo de las próximas horas
 *   para sus canales ("Ahora" y "Después").
 * - Cada canal se reproduce a través del proxy local (HLS reescrito, con las
 *   cabeceras que pida la lista: User-Agent, Referer) o, si es un TS en
 *   directo que el navegador no puede abrir, a través de FFmpeg (Modo fluido).
 * - Logos por HTTP pasan por el proxy (la página es segura y los bloquearía).
 * - Ni direcciones ni cabeceras se escriben en el registro de tiempos.
 */

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var zlib = require('zlib');
var crypto = require('crypto');
var urlmod = require('url');
var StringDecoder = require('string_decoder').StringDecoder;
var dnsx = require('./dnsx');
var proxy = require('./proxy');
var relay = require('./ffmpeg-relay');
var timing = require('./timing');

var MAX_LIST_BYTES = 40 * 1024 * 1024;
var MAX_CHANNELS = 100000;
var MAX_LISTS = 40;
var DOWNLOAD_TIMEOUT_MS = 45000;
var PROBE_TIMEOUT_MS = 12000;
var PROBE_BYTES = 64 * 1024;
var DEFAULT_UA = 'VLC/3.0.21 LibVLC/3.0.21';
var LIST_UA = 'XuperDesktop (lista M3U)';

var AUTO_REFRESH_MS = 24 * 60 * 60 * 1000;   // listas por dirección: una vez al día
var CHECK_CONCURRENCY = 10;
var CHECK_TIMEOUT_MS = 8000;
var CHECK_READ_MS = 3000;
var EPG_MAX_AGE_MS = 12 * 60 * 60 * 1000;
var EPG_PAST_MS = 2 * 60 * 60 * 1000;
var EPG_AHEAD_MS = 36 * 60 * 60 * 1000;
var EPG_MAX_BYTES = 400 * 1024 * 1024;
var EPG_PER_CHANNEL = 60;

/* ------------------------------------------------------------ almacenamiento */
var memIndex = null;          // { lists: [...], favorites: { key: channel }, settings: {...} }
var memChannels = {};         // id -> canales (las 3 últimas listas abiertas)
var memOrder = [];
var memStatus = {};           // id -> { checkedAt, down: { key: 1 } }
var memEpg = {};              // id -> { fetchedAt, p: { key: [[inicio, fin, título], ...] } }

function dataDir() {
  var base = process.env.XUPER_DATA_DIR;
  if (!base) { return ''; }
  var dir = path.join(base, 'mylists');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (eDir) { return ''; }
  return dir;
}

function writeJson(file, value) {
  var dir = dataDir();
  if (!dir) { return; }
  var target = path.join(dir, file);
  var tmp = target + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, target);
  } catch (eWrite) { try { fs.unlinkSync(tmp); } catch (eTmp) { /* nada */ } }
}

function readJson(file) {
  var dir = dataDir();
  if (!dir) { return null; }
  try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (eRead) { return null; }
}

function removeFile(file) {
  var dir = dataDir();
  if (!dir) { return; }
  try { fs.unlinkSync(path.join(dir, file)); } catch (eDel) { /* ya no estaba */ }
}

function loadIndex() {
  if (memIndex) { return memIndex; }
  var saved = readJson('index.json');
  memIndex = {
    lists: saved && Array.isArray(saved.lists) ? saved.lists : [],
    favorites: saved && saved.favorites && typeof saved.favorites === 'object' ? saved.favorites : {},
    settings: saved && saved.settings && typeof saved.settings === 'object' ? saved.settings : {}
  };
  if (memIndex.settings.autoUpdate === undefined) { memIndex.settings.autoUpdate = true; }
  /* La primera carpeta que se use queda como "carpeta por defecto" aparte, para
     que un cambio accidental no la pierda. "Cambiar carpeta" no la sobrescribe. */
  if (!memIndex.settings.defaultSyncFolder && memIndex.settings.syncFolder) {
    memIndex.settings.defaultSyncFolder = memIndex.settings.syncFolder;
  }
  /* Historial de carpetas usadas, para elegirlas o quitarlas desde el menú. */
  if (!Array.isArray(memIndex.settings.folders)) { memIndex.settings.folders = []; }
  [memIndex.settings.defaultSyncFolder, memIndex.settings.syncFolder].forEach(function (d) {
    if (d && memIndex.settings.folders.indexOf(d) === -1) { memIndex.settings.folders.push(d); }
  });
  return memIndex;
}
var MAX_FOLDERS = 12;
function rememberFolder(s, dir) {
  if (!dir) { return; }
  if (!Array.isArray(s.folders)) { s.folders = []; }
  if (s.folders.indexOf(dir) === -1) { s.folders.push(dir); }
  while (s.folders.length > MAX_FOLDERS) {
    var i = 0;
    for (; i < s.folders.length; i++) { if (s.folders[i] !== s.defaultSyncFolder) { break; } }
    if (i >= s.folders.length) { break; }
    s.folders.splice(i, 1);
  }
}
function saveIndex() { writeJson('index.json', loadIndex()); }

function rememberChannels(id, channels) {
  memChannels[id] = channels;
  memOrder = memOrder.filter(function (x) { return x !== id; });
  memOrder.push(id);
  while (memOrder.length > 3) { delete memChannels[memOrder.shift()]; }
}
function storedChannels(id) {
  if (memChannels[id]) { return memChannels[id]; }
  var saved = readJson('list-' + id + '.json');
  if (saved && Array.isArray(saved.channels)) { rememberChannels(id, saved.channels); return saved.channels; }
  return null;
}
function storeChannels(id, channels) {
  rememberChannels(id, channels);
  writeJson('list-' + id + '.json', { channels: channels });
}
function storedStatus(id) {
  if (!memStatus[id]) { memStatus[id] = readJson('status-' + id + '.json') || { checkedAt: 0, down: {} }; }
  return memStatus[id];
}
function storedEpg(id) {
  if (!memEpg[id]) { memEpg[id] = readJson('epg-' + id + '.json') || { fetchedAt: 0, p: {} }; }
  return memEpg[id];
}

function findList(id) {
  var lists = loadIndex().lists;
  for (var i = 0; i < lists.length; i++) { if (lists[i].id === id) { return lists[i]; } }
  return null;
}

/* ------------------------------------------------------------------ lectura */
function cleanText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
}

function foldKey(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isAllCaps(text) { return /[A-ZÁÉÍÓÚÑ]/.test(text) && text === text.toUpperCase(); }

/* Categorías equivalentes con un solo nombre en español (iptv-org y muchas
   listas las escriben en inglés; otras, en mayúsculas o en plural). */
var CATEGORY_ES = {
  'music': 'Música', 'musica': 'Música', 'musicales': 'Música',
  'sport': 'Deportes', 'sports': 'Deportes', 'deporte': 'Deportes', 'deportes': 'Deportes',
  'news': 'Noticias', 'noticia': 'Noticias', 'noticias': 'Noticias',
  'kids': 'Infantil', 'children': 'Infantil', 'infantiles': 'Infantil', 'ninos': 'Infantil', 'infantil': 'Infantil',
  'movies': 'Películas', 'movie': 'Películas', 'peliculas': 'Películas', 'pelicula': 'Películas', 'cine': 'Películas',
  'series': 'Series', 'serie': 'Series',
  'entertainment': 'Entretenimiento', 'entretenimiento': 'Entretenimiento',
  'documentary': 'Documentales', 'documentaries': 'Documentales', 'documental': 'Documentales', 'documentales': 'Documentales',
  'animation': 'Animación', 'animacion': 'Animación', 'cartoons': 'Animación', 'dibujos animados': 'Animación',
  'religious': 'Religioso', 'religion': 'Religioso', 'religiosos': 'Religioso', 'religioso': 'Religioso',
  'comedy': 'Comedia', 'comedia': 'Comedia', 'culture': 'Cultura', 'cultura': 'Cultura', 'general': 'General',
  'outdoor': 'Aire libre', 'aire libre': 'Aire libre', 'legislative': 'Legislativo', 'lifestyle': 'Estilo de vida',
  'science': 'Ciencia', 'ciencia': 'Ciencia', 'family': 'Familia', 'familia': 'Familia',
  'business': 'Negocios', 'negocios': 'Negocios', 'travel': 'Viajes', 'viajes': 'Viajes',
  'classic': 'Clásicos', 'classics': 'Clásicos', 'clasicos': 'Clásicos', 'clasico': 'Clásicos',
  'education': 'Educación', 'educacion': 'Educación', 'educativo': 'Educación', 'educativos': 'Educación',
  'auto': 'Motor', 'cooking': 'Cocina', 'cocina': 'Cocina', 'weather': 'Clima', 'shop': 'Compras', 'relax': 'Relax',
  'anime': 'Anime', 'radio': 'Radio', 'radios': 'Radio', 'telenovelas': 'Telenovelas', 'novelas': 'Telenovelas',
  'undefined': 'Sin categoría', 'null': 'Sin categoría', 'sin categoria': 'Sin categoría', 'uncategorized': 'Sin categoría',
  'other': 'Otros', 'others': 'Otros', 'otros': 'Otros', 'varios': 'Otros'
};

/* "Culture;Music" (iptv-org) -> "Cultura". */
function groupName(raw) {
  var name = cleanText(String(raw || '').split(';')[0], 80);
  if (!name) { return 'Sin categoría'; }
  return CATEGORY_ES[foldKey(name)] || name;
}

/* "México" y "MÉXICO" son la misma categoría: un solo nombre, el que no va
   todo en mayúsculas si lo hay. */
function unifyGroups(channels) {
  var best = {};
  channels.forEach(function (c) {
    var key = foldKey(c.g);
    if (!best[key] || (isAllCaps(best[key]) && !isAllCaps(c.g))) { best[key] = c.g; }
  });
  channels.forEach(function (c) { c.g = best[foldKey(c.g)]; });
}

function attrs(text) {
  var out = {};
  var re = /([A-Za-z0-9_-]+)="([^"]*)"/g, m;
  while ((m = re.exec(text))) { out[m[1].toLowerCase()] = m[2]; }
  return out;
}

/* Coma que separa los atributos del nombre (las comas dentro de comillas no cuentan). */
function splitExtinf(line) {
  var quoted = false;
  for (var i = 8; i < line.length; i++) {
    var c = line.charAt(i);
    if (c === '"') { quoted = !quoted; }
    else if (c === ',' && !quoted) { return [line.slice(8, i), line.slice(i + 1)]; }
  }
  return [line.slice(8), ''];
}

function hashKey(text) { return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16); }

function isYoutube(u) { return /^https?:\/\/([a-z0-9-]+\.)?(youtube\.com|youtu\.be)\//i.test(u); }

function decodeURIComponentSafe(text) {
  try { return decodeURIComponent(text); } catch (eDec) { return text; }
}

function parse(text) {
  text = String(text || '').replace(/^﻿/, '');
  var lines = text.split(/\r\n|\r|\n/);
  var channels = [], seen = {}, skipped = 0, epgUrl = '';
  var cur = null, opts = {}, extgrp = '';
  for (var i = 0; i < lines.length && channels.length < MAX_CHANNELS; i++) {
    var line = lines[i].trim();
    if (!line) { continue; }
    if (line.indexOf('#EXTM3U') === 0) {
      /* Guía de programación indicada por la lista (puede traer varias, separadas por comas). */
      var head = attrs(line);
      var guide = String(head['url-tvg'] || head['x-tvg-url'] || head['tvg-url'] || '').split(',')[0].trim();
      if (!epgUrl && /^https?:\/\//i.test(guide)) { epgUrl = guide.slice(0, 1000); }
      continue;
    }
    if (line.indexOf('#EXTINF') === 0) {
      var parts = splitExtinf(line);
      var a = attrs(parts[0]);
      cur = {
        n: cleanText(parts[1] || a['tvg-name'] || '', 120),
        g: a['group-title'] || '',
        l: String(a['tvg-logo'] || a.logo || '').trim(),
        id: cleanText(a['tvg-id'] || '', 80)
      };
      continue;
    }
    if (line.indexOf('#EXTGRP:') === 0) { extgrp = line.slice(8); continue; }
    if (line.indexOf('#EXTVLCOPT:') === 0) {
      var opt = line.slice(11);
      var eq = opt.indexOf('=');
      if (eq > 0) {
        var k = opt.slice(0, eq).trim().toLowerCase(), v = opt.slice(eq + 1).trim();
        if (k === 'http-user-agent') { opts.ua = v; }
        else if (k === 'http-referrer' || k === 'http-referer') { opts.ref = v; }
      }
      continue;
    }
    if (line.charAt(0) === '#') { continue; }

    /* Dirección del canal; formato Kodi: url|User-Agent=...&Referer=... */
    var address = line, pipe = line.indexOf('|');
    if (pipe > 0) {
      address = line.slice(0, pipe).trim();
      line.slice(pipe + 1).split('&').forEach(function (pair) {
        var p = pair.indexOf('=');
        if (p <= 0) { return; }
        var hk = decodeURIComponentSafe(pair.slice(0, p)).trim().toLowerCase();
        var hv = decodeURIComponentSafe(pair.slice(p + 1)).trim();
        if (hk === 'user-agent') { opts.ua = hv; }
        else if (hk === 'referer' || hk === 'referrer') { opts.ref = hv; }
      });
    }
    if (!/^https?:\/\//i.test(address)) { skipped++; cur = null; opts = {}; extgrp = ''; continue; }
    if (seen[address]) { cur = null; opts = {}; extgrp = ''; continue; }
    seen[address] = true;
    var ch = cur || { n: '', g: '', l: '', id: '' };
    if (!ch.n) {
      try { ch.n = urlmod.parse(address).hostname || 'Canal'; } catch (eHost) { ch.n = 'Canal'; }
    }
    var item = { k: hashKey(address), n: ch.n, g: groupName(ch.g || extgrp), u: address };
    if (/^https?:\/\//i.test(ch.l)) { item.l = ch.l.slice(0, 600); }
    if (ch.id) { item.id = ch.id; }
    if (opts.ua) { item.ua = cleanText(opts.ua, 300); }
    if (opts.ref) { item.ref = cleanText(opts.ref, 600); }
    if (isYoutube(address)) { item.yt = 1; }
    channels.push(item);
    cur = null; opts = {}; extgrp = '';
  }
  unifyGroups(channels);
  return { channels: channels, skipped: skipped, isM3u: /^\s*#EXTM3U/i.test(text), epgUrl: epgUrl };
}

/* Lista en formato JSON. No hay un estandar unico, asi que aceptamos las formas
   mas comunes: un array de canales, o un objeto con channels/items/streams, y
   los nombres de campo habituales (name/title, url/link/stream_url, etc.). */
function firstField(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = obj[keys[i]];
    if (v !== undefined && v !== null && v !== '') { return v; }
  }
  return '';
}
function parseJson(text) {
  var data = JSON.parse(text.replace(/^﻿/, ''));
  var arr = Array.isArray(data) ? data
    : (data && (data.channels || data.items || data.streams || data.playlist || data.entries)) || [];
  if (!Array.isArray(arr)) { arr = []; }
  var channels = [], seen = {}, skipped = 0;
  for (var i = 0; i < arr.length && channels.length < MAX_CHANNELS; i++) {
    var o = arr[i];
    if (!o || typeof o !== 'object') { skipped++; continue; }
    var url = String(firstField(o, ['url', 'link', 'stream', 'stream_url', 'streamUrl', 'source', 'address', 'u', 'file'])).trim();
    if (!/^https?:\/\//i.test(url)) { skipped++; continue; }
    if (seen[url]) { continue; }
    seen[url] = true;
    var name = cleanText(firstField(o, ['name', 'title', 'tvg_name', 'tvg-name', 'tvgName', 'channel', 'n']), 120);
    if (!name) { try { name = urlmod.parse(url).hostname || 'Canal'; } catch (eH) { name = 'Canal'; } }
    var group = firstField(o, ['group', 'group_title', 'group-title', 'groupTitle', 'category', 'categoryName', 'genre', 'g']);
    var logo = String(firstField(o, ['logo', 'tvg_logo', 'tvg-logo', 'tvgLogo', 'icon', 'image', 'img', 'l'])).trim();
    var item = { k: hashKey(url), n: name, g: groupName(group || ''), u: url };
    if (/^https?:\/\//i.test(logo)) { item.l = logo.slice(0, 600); }
    var id = cleanText(firstField(o, ['tvg_id', 'tvg-id', 'tvgId', 'epg_id', 'epg-id', 'epgId']), 80);
    if (id) { item.id = id; }
    var ua = firstField(o, ['user_agent', 'user-agent', 'userAgent', 'http_user_agent', 'ua']);
    if (ua) { item.ua = cleanText(ua, 300); }
    var ref = firstField(o, ['referer', 'referrer', 'http_referrer', 'ref']);
    if (ref) { item.ref = cleanText(ref, 600); }
    if (isYoutube(url)) { item.yt = 1; }
    channels.push(item);
  }
  unifyGroups(channels);
  var epg = data && !Array.isArray(data) ? String(firstField(data, ['url-tvg', 'epg', 'epgUrl', 'epg_url']) || '') : '';
  return { channels: channels, skipped: skipped, isM3u: false, isJson: true,
    epgUrl: /^https?:\/\//i.test(epg) ? epg.slice(0, 1000) : '' };
}

/* Detecta el formato: JSON (empieza por { o [) o M3U (texto). Si parece JSON
   pero no se puede leer como tal, se intenta como M3U. */
function parseList(text) {
  var head = String(text || '').replace(/^﻿/, '').replace(/^\s+/, '').charAt(0);
  if (head === '{' || head === '[') {
    try { return parseJson(text); } catch (eJson) { /* no era JSON valido: probamos M3U */ }
  }
  return parse(text);
}

function groupCount(channels) {
  var g = {};
  channels.forEach(function (c) { g[c.g] = 1; });
  return Object.keys(g).length;
}

/* ---------------------------------------------------------------- descargas */
function request(target, headers, onResponse, onError, timeoutMs) {
  var parsed = urlmod.parse(target);
  var secure = parsed.protocol === 'https:';
  var options = {
    protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port || (secure ? 443 : 80),
    path: parsed.path || '/', method: 'GET', headers: headers
  };
  var finished = false;
  function fail(err) { if (!finished) { finished = true; onError(err); } }
  dnsx.prepare(options, function (perr, prepared) {
    if (perr) { prepared = options; }
    var req;
    try {
      req = (secure ? https : http).request(prepared, function (res) {
        if (finished) { res.resume(); return; }
        finished = true;
        onResponse(res, req);
      });
    } catch (eReq) { return fail(eReq); }
    req.setTimeout(timeoutMs, function () { try { req.abort(); } catch (eAbort) { /* nada */ } fail(new Error('El servidor tardó demasiado en responder')); });
    req.on('error', fail);
    req.end();
  });
}

/* Respuesta ya descomprimida: por cabecera o, si el servidor no lo dice, por
   los dos primeros bytes (las guías .xml.gz suelen llegar así). */
function decodedBody(res, onData, onEnd, onError) {
  var enc = String(res.headers['content-encoding'] || '').toLowerCase();
  var inflater = null, decided = false;
  function feed(chunk) {
    if (!decided) {
      decided = true;
      if (enc === 'gzip' || (chunk.length > 1 && chunk[0] === 0x1f && chunk[1] === 0x8b)) { inflater = zlib.createGunzip(); }
      else if (enc === 'deflate') { inflater = zlib.createInflate(); }
      if (inflater) {
        inflater.on('data', onData);
        inflater.on('end', onEnd);
        inflater.on('error', onError);
      }
    }
    if (inflater) { inflater.write(chunk); } else { onData(chunk); }
  }
  res.on('data', feed);
  res.on('end', function () { if (inflater) { inflater.end(); } else { onEnd(); } });
  res.on('error', onError);
}

function download(target, done, hops) {
  hops = hops || 0;
  request(target, { 'User-Agent': LIST_UA, Accept: '*/*', 'Accept-Encoding': 'gzip, deflate' }, function (res, req) {
    var status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location && hops < 6) {
      res.resume();
      return download(urlmod.resolve(target, res.headers.location), done, hops + 1);
    }
    if (status !== 200) { res.resume(); return done(new Error('El servidor de la lista respondió con un error (HTTP ' + status + ')')); }
    var parts = [], size = 0, over = false;
    decodedBody(res, function (chunk) {
      if (over) { return; }
      size += chunk.length;
      if (size > MAX_LIST_BYTES) { over = true; try { req.abort(); } catch (eA) { /* nada */ } return done(new Error('La lista es demasiado grande (más de 40 MB)')); }
      parts.push(chunk);
    }, function () {
      if (!over) { over = true; done(null, Buffer.concat(parts).toString('utf8')); }
    }, function (err) { if (!over) { over = true; done(err); } });
  }, function (err) { done(err); }, DOWNLOAD_TIMEOUT_MS);
}

/* ------------------------------------------------------------------- listas */
var refreshing = {};          // id -> true mientras se actualiza
var checks = {};              // id -> trabajo de "Comprobar canales"
var epgJobs = {};             // id -> true mientras se descarga la guía
var maintainQueue = [];
var maintainBusy = false;

function publicList(meta) {
  var job = checks[meta.id];
  return {
    id: meta.id, name: meta.name, source: meta.source, count: meta.count || 0, groups: meta.groups || 0,
    addedAt: meta.addedAt || 0, updatedAt: meta.updatedAt || 0,
    /* La dirección se muestra al usuario (es suya); el archivo, solo su nombre. */
    url: meta.source === 'url' ? meta.url : '', file: meta.source === 'file' ? path.basename(meta.file || '') : '',
    error: meta.error || '',
    refreshing: !!refreshing[meta.id],
    checkedAt: meta.checkedAt || 0, down: meta.down || 0,
    checking: job && job.running ? { done: job.done, total: job.total, down: job.downCount } : null,
    epg: !!(meta.epgCustom || meta.epgUrl), epgUrl: meta.epgCustom || meta.epgUrl || '', epgCustom: meta.epgCustom || '',
    epgAt: meta.epgAt || 0, epgMatched: meta.epgMatched || 0, epgError: meta.epgError || '', epgLoading: !!epgJobs[meta.id]
  };
}

function publicSettings() {
  var s = loadIndex().settings;
  var def = s.defaultSyncFolder || '';
  return {
    autoUpdate: !!s.autoUpdate,
    syncFolder: s.syncFolder ? path.basename(s.syncFolder) : '',
    defaultFolder: def ? path.basename(def) : '',
    atDefault: !!def && s.syncFolder === def,
    /* Carpetas usadas: el menú las lista para cambiar a ellas o quitarlas.
       Solo se envían los nombres (no las rutas completas); las acciones usan
       el índice, que el servicio resuelve contra la ruta real. */
    folders: (s.folders || []).map(function (p, i) {
      return { index: i, name: path.basename(p), current: p === s.syncFolder, isDefault: !!def && p === def };
    })
  };
}

function index(done) {
  var idx = loadIndex();
  maintain();
  done(null, { lists: idx.lists.map(publicList), favorites: Object.keys(idx.favorites), settings: publicSettings() });
}

/* Carpeta de sincronización (solo el proceso principal la ve completa). */
function syncFolder() { return loadIndex().settings.syncFolder || ''; }
function setSyncFolder(dir) {
  var s = loadIndex().settings;
  s.syncFolder = String(dir || '');
  /* Si aún no hay carpeta por defecto, la primera que se elige lo es. */
  if (s.syncFolder && !s.defaultSyncFolder) { s.defaultSyncFolder = s.syncFolder; }
  rememberFolder(s, s.syncFolder);
  saveIndex();
}

/* Importa, o vuelve a leer, cada .m3u/.m3u8 de la carpeta (sin subcarpetas). */
function syncFromFolder(dir, done) {
  fs.readdir(dir, function (err, names) {
    if (err) { return done(new Error('No se pudo abrir la carpeta (¿se movió o se borró?)')); }
    var files = names.filter(function (n) { return /\.(m3u8?|json)$/i.test(n); }).sort().slice(0, MAX_LISTS);
    if (!files.length) {
      var def = loadIndex().settings.defaultSyncFolder || '';
      var hint = (def && def !== dir) ? ' Tus listas guardadas siguen ahí; usa "Volver a la carpeta por defecto" para regresar a la de siempre.' : '';
      return done(new Error('La carpeta no tiene archivos .m3u, .m3u8 ni .json.' + hint));
    }
    var summary = { folder: path.basename(dir), added: 0, updated: 0, errors: [], lists: [] };
    var known = {};
    loadIndex().lists.forEach(function (l) { if (l.source === 'file') { known[path.resolve(l.file)] = true; } });
    (function next(i) {
      if (i >= files.length) { return done(null, summary); }
      var file = path.join(dir, files[i]);
      var wasKnown = !!known[path.resolve(file)];
      addFile(file, '', function (aerr, data) {
        if (aerr) { summary.errors.push(files[i] + ': ' + (aerr.message || 'error')); }
        else {
          if (wasKnown) { summary.updated++; } else { summary.added++; }
          if (data && data.list) { summary.lists.push(data.list); }
        }
        next(i + 1);
      });
    })(0);
  });
}

function settings(params, done) {
  var idx = loadIndex();
  if (params && params.autoUpdate !== undefined) { idx.settings.autoUpdate = !!params.autoUpdate; saveIndex(); }
  /* "Volver a la carpeta por defecto": restaura la carpeta fija recordada. */
  if (params && params.restoreDefault) {
    if (!idx.settings.defaultSyncFolder) { return done(new Error('Todavía no hay una carpeta por defecto guardada.')); }
    idx.settings.syncFolder = idx.settings.defaultSyncFolder;
    saveIndex();
  }
  /* Cambiar a una carpeta de la lista (por índice). */
  if (params && params.useFolder !== undefined) {
    var folders = idx.settings.folders || [];
    var ui = parseInt(params.useFolder, 10);
    if (ui >= 0 && ui < folders.length) { idx.settings.syncFolder = folders[ui]; saveIndex(); }
    else { return done(new Error('Esa carpeta ya no está en la lista.')); }
  }
  /* Quitar una carpeta de la lista (no toca archivos). La por defecto no se quita. */
  if (params && params.removeFolder !== undefined) {
    var list = idx.settings.folders || [];
    var ri = parseInt(params.removeFolder, 10);
    if (ri < 0 || ri >= list.length) { return done(new Error('Esa carpeta ya no está en la lista.')); }
    if (list[ri] === idx.settings.defaultSyncFolder) { return done(new Error('La carpeta por defecto no se puede quitar de la lista.')); }
    var removed = list.splice(ri, 1)[0];
    if (idx.settings.syncFolder === removed) { idx.settings.syncFolder = idx.settings.defaultSyncFolder || (list[0] || ''); }
    saveIndex();
  }
  if (idx.settings.autoUpdate) { maintain(); }
  done(null, { settings: publicSettings() });
}

/* Mantenimiento en segundo plano, una tarea cada vez: listas por dirección
   de más de un día y guías de más de 12 horas. */
function maintain() {
  var idx = loadIndex();
  if (!idx.settings.autoUpdate) { return; }
  var now = Date.now();
  idx.lists.forEach(function (meta) {
    if (meta.source === 'url' && now - (meta.updatedAt || 0) > AUTO_REFRESH_MS) { queueTask('refresh', meta.id); }
    else if ((meta.epgCustom || meta.epgUrl) && now - (meta.epgAt || 0) > EPG_MAX_AGE_MS && !meta.epgError) { queueTask('epg', meta.id); }
  });
}
function queueTask(kind, id) {
  for (var i = 0; i < maintainQueue.length; i++) { if (maintainQueue[i].kind === kind && maintainQueue[i].id === id) { return; } }
  if ((kind === 'refresh' && refreshing[id]) || (kind === 'epg' && epgJobs[id])) { return; }
  maintainQueue.push({ kind: kind, id: id });
  runQueue();
}
function runQueue() {
  if (maintainBusy || !maintainQueue.length) { return; }
  var task = maintainQueue.shift();
  if (!findList(task.id)) { return runQueue(); }
  maintainBusy = true;
  var next = function () { maintainBusy = false; setTimeout(runQueue, 500); };
  timing.log('mis listas: mantenimiento automático (' + (task.kind === 'refresh' ? 'actualizar lista' : 'guía de programación') + ')');
  if (task.kind === 'refresh') { refresh({ id: task.id, auto: true }, next); }
  else { epgUpdate({ id: task.id }, next); }
}

function defaultName(target) {
  try {
    var p = urlmod.parse(target);
    var base = path.basename(p.pathname || '').replace(/\.(m3u8?|json|txt)$/i, '');
    return cleanText((p.hostname || 'Lista') + (base && base !== '/' ? ' · ' + base : ''), 60);
  } catch (eName) { return 'Lista M3U'; }
}

function acceptParsed(result) {
  if (!result.channels.length) {
    if (result.isJson) { return new Error('El archivo JSON no tiene canales con una dirección http/https válida.'); }
    return new Error(result.isM3u ? 'La lista no tiene canales que se puedan reproducir (solo se admiten direcciones http/https)'
      : 'Ese enlace no es una lista M3U ni JSON válida');
  }
  return null;
}

function saveNewList(meta, result, done) {
  var idx = loadIndex();
  if (idx.lists.length >= MAX_LISTS) { return done(new Error('Has llegado al máximo de ' + MAX_LISTS + ' listas. Quita alguna antes de añadir otra.')); }
  var channels = result.channels;
  meta.id = crypto.randomBytes(6).toString('hex');
  meta.count = channels.length;
  meta.groups = groupCount(channels);
  meta.addedAt = meta.updatedAt = Date.now();
  if (result.epgUrl) { meta.epgUrl = result.epgUrl; }
  storeChannels(meta.id, channels);
  idx.lists.push(meta);
  saveIndex();
  timing.log('mis listas: lista añadida (' + channels.length + ' canales, ' + meta.groups + ' categorías' + (meta.epgUrl ? ', con guía' : '') + ')');
  if (meta.epgUrl) { queueTask('epg', meta.id); }
  done(null, { list: publicList(meta) });
}

/* Cuenta Xtream Codes: HOST + usuario + contraseña escritos por separado.
   Es la misma lista que el enlace "get.php", solo que armamos nosotros la
   dirección para quien tiene los tres datos sueltos. Pedimos type=m3u_plus
   para que la lista llegue con categorías (type=m3u las trae todas juntas). */
function buildXtreamUrl(host, user, pass) {
  host = String(host || '').trim();
  user = String(user || '').trim();
  pass = String(pass || '').trim();
  if (!host) { throw new Error('Escribe la dirección del servidor (HOST), por ejemplo http://servidor.com:8080'); }
  if (!user || !pass) { throw new Error('Escribe el usuario y la contraseña de la cuenta.'); }
  if (host.indexOf('://') === -1) { host = 'http://' + host; }
  var parsed;
  try { parsed = new URL(host); } catch (e) { throw new Error('La dirección del servidor (HOST) no es válida.'); }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new Error('La dirección del servidor (HOST) no es válida.');
  }
  /* Nos quedamos solo con protocolo + servidor + puerto; si pegó de más
     (/get.php, /c, /player_api.php…) lo descartamos. */
  var base = parsed.protocol + '//' + parsed.host;
  return base + '/get.php?username=' + encodeURIComponent(user) +
    '&password=' + encodeURIComponent(pass) + '&type=m3u_plus';
}

function add(params, done) {
  var target;
  if (params && (params.host || params.user || params.pass)) {
    try { target = buildXtreamUrl(params.host, params.user, params.pass); }
    catch (eBuild) { return done(eBuild); }
  } else {
    target = String(params && params.url || '').trim();
  }
  if (!/^https?:\/\/[^\s]+$/i.test(target)) { return done(new Error('Escribe una dirección que empiece por http:// o https://')); }
  var lists = loadIndex().lists;
  for (var i = 0; i < lists.length; i++) {
    if (lists[i].source === 'url' && lists[i].url === target) { return done(new Error('Esa lista ya está añadida: "' + lists[i].name + '"')); }
  }
  download(target, function (err, text) {
    if (err) { return done(err); }
    var result = parseList(text);
    var bad = acceptParsed(result);
    if (bad) { return done(bad); }
    saveNewList({ name: cleanText(params.name, 60) || defaultName(target), source: 'url', url: target }, result, done);
  });
}

function readFileList(file, done) {
  fs.stat(file, function (err, st) {
    if (err) { return done(new Error('No se pudo leer el archivo (¿se movió o se borró?)')); }
    if (st.size > MAX_LIST_BYTES) { return done(new Error('El archivo es demasiado grande (más de 40 MB)')); }
    fs.readFile(file, 'utf8', function (rerr, text) { done(rerr ? new Error('No se pudo leer el archivo') : null, text, st.mtimeMs); });
  });
}

/* Solo desde el proceso principal (diálogo de Windows o la carpeta de
   sincronización): la página no puede pedir rutas. */
function addFile(file, name, done) {
  var lists = loadIndex().lists;
  for (var i = 0; i < lists.length; i++) {
    if (lists[i].source === 'file' && path.resolve(lists[i].file) === path.resolve(file)) {
      /* Ya está: sincronizar es volver a leerla. */
      return refresh({ id: lists[i].id }, done);
    }
  }
  readFileList(file, function (err, text, mtime) {
    if (err) { return done(err); }
    var result = parseList(text);
    var bad = acceptParsed(result);
    if (bad) { return done(bad); }
    var base = path.basename(file).replace(/\.(m3u8?|json|txt)$/i, '');
    saveNewList({ name: cleanText(name, 60) || cleanText(base, 60) || 'Lista', source: 'file', file: file, fileMtime: mtime || 0 }, result, done);
  });
}

function refresh(params, done) {
  var meta = findList(String(params && params.id || ''));
  if (!meta) { return done(new Error('La lista ya no existe')); }
  if (refreshing[meta.id]) { return done(null, { list: publicList(meta), busy: true }); }
  refreshing[meta.id] = true;
  function finish(err, text, mtime) {
    delete refreshing[meta.id];
    var verb = meta.source === 'file' ? 'sincronizar' : 'actualizar';
    if (err) {
      meta.error = err.message || 'error';
      if (params.auto) { meta.updatedAt = Date.now(); }   // no reintentar en bucle: mañana otra vez
      saveIndex();
      return done(new Error('No se pudo ' + verb + ': ' + meta.error + '. Se mantiene la copia guardada.'));
    }
    var result = parseList(text);
    var bad = acceptParsed(result);
    if (bad) {
      meta.error = bad.message;
      if (params.auto) { meta.updatedAt = Date.now(); }
      saveIndex();
      return done(new Error('No se pudo ' + verb + ': ' + bad.message + '. Se mantiene la copia guardada.'));
    }
    storeChannels(meta.id, result.channels);
    meta.count = result.channels.length;
    meta.groups = groupCount(result.channels);
    meta.updatedAt = Date.now();
    if (mtime) { meta.fileMtime = mtime; }
    var guideChanged = (result.epgUrl || '') !== (meta.epgUrl || '');
    meta.epgUrl = result.epgUrl || '';
    meta.error = '';
    saveIndex();
    if ((meta.epgCustom || meta.epgUrl) && (guideChanged || Date.now() - (meta.epgAt || 0) > EPG_MAX_AGE_MS)) { queueTask('epg', meta.id); }
    done(null, { list: publicList(meta) });
  }
  if (meta.source === 'file') { readFileList(meta.file, finish); } else { download(meta.url, finish); }
}

function remove(params, done) {
  var idx = loadIndex();
  var id = String(params && params.id || '');
  idx.lists = idx.lists.filter(function (l) { return l.id !== id; });
  /* Sus favoritos se van con ella. */
  Object.keys(idx.favorites).forEach(function (k) { if (idx.favorites[k].list === id) { delete idx.favorites[k]; } });
  if (checks[id]) { checks[id].stop = true; }
  delete memChannels[id];
  delete memStatus[id];
  delete memEpg[id];
  ['list-', 'status-', 'epg-'].forEach(function (prefix) { removeFile(prefix + id + '.json'); });
  saveIndex();
  done(null, { ok: true });
}

/* Renombrar y, opcionalmente, indicar la guía de programación (XMLTV). */
function rename(params, done) {
  var meta = findList(String(params && params.id || ''));
  var name = cleanText(params && params.name, 60);
  if (!meta) { return done(new Error('La lista ya no existe')); }
  if (!name) { return done(new Error('Escribe un nombre')); }
  if (params.epg !== undefined) {
    var guide = String(params.epg || '').trim();
    if (guide && !/^https?:\/\/\S+$/i.test(guide)) { return done(new Error('La guía debe ser una dirección que empiece por http:// o https://')); }
    if (guide !== (meta.epgCustom || '')) {
      meta.epgCustom = guide.slice(0, 1000);
      meta.epgError = '';
      meta.epgAt = 0;
      if (meta.epgCustom || meta.epgUrl) { queueTask('epg', meta.id); }
      else { delete memEpg[meta.id]; removeFile('epg-' + meta.id + '.json'); meta.epgMatched = 0; }
    }
  }
  meta.name = name;
  saveIndex();
  done(null, { list: publicList(meta) });
}

/* ---------------------------------------------------- canales para la página */
function epgNow(listId, key, now) {
  if (!listId) { return null; }
  var progs = storedEpg(listId).p[key];
  if (!progs || !progs.length) { return null; }
  for (var i = 0; i < progs.length; i++) {
    var p = progs[i];
    if (p[0] <= now && now < p[1]) {
      var nx = progs[i + 1];
      return { t: p[2], s: p[0], e: p[1], nt: nx ? nx[2] : '', ns: nx ? nx[0] : 0 };
    }
    if (p[0] > now) { return { t: '', s: 0, e: 0, nt: p[2], ns: p[0] }; }
  }
  return null;
}

/* Logos por HTTP: a través del proxy (la página es segura). */
function forPage(c, listId, now) {
  var out = { k: c.k, n: c.n, g: groupName(c.g), u: c.u };
  if (c.l) { out.l = /^https:/i.test(c.l) ? c.l : proxy.addRadio(c.l); }
  if (c.ua) { out.ua = c.ua; }
  if (c.ref) { out.ref = c.ref; }
  if (c.yt) { out.yt = 1; }
  if (listId) {
    if (storedStatus(listId).down[c.k]) { out.d = 1; }
    var guide = epgNow(listId, c.k, now);
    if (guide) { out.e = guide; }
  }
  return out;
}

/* Un archivo del PC que cambió desde la última lectura se vuelve a leer. */
function syncFileIfChanged(meta, done) {
  if (meta.source !== 'file') { return done(); }
  fs.stat(meta.file, function (err, st) {
    if (err || !st || Math.floor(st.mtimeMs) === Math.floor(meta.fileMtime || 0)) { return done(); }
    timing.log('mis listas: el archivo de una lista cambió; se sincroniza');
    refresh({ id: meta.id }, function () { done(); });
  });
}

function channels(params, done) {
  var id = String(params && params.id || '');
  proxy.start(function (perr) {
    if (perr) { return done(perr); }
    var now = Date.now();
    if (id === 'fav') {
      var favs = loadIndex().favorites;
      return done(null, { channels: Object.keys(favs).map(function (k) {
        var out = forPage(favs[k], favs[k].list, now);
        out.list = favs[k].list;
        return out;
      }) });
    }
    var meta = findList(id);
    if (!meta) { return done(new Error('La lista ya no existe')); }
    syncFileIfChanged(meta, function () {
      var list = storedChannels(id);
      if (list) { return done(null, { list: publicList(meta), channels: list.map(function (c) { return forPage(c, id, now); }) }); }
      /* Sin copia guardada (borrada a mano): se descarga de nuevo. */
      refresh({ id: id }, function (err) {
        if (err) { return done(err); }
        var again = storedChannels(id) || [];
        done(null, { list: publicList(findList(id) || meta), channels: again.map(function (c) { return forPage(c, id, now); }) });
      });
    });
  });
}

/* Solo "Ahora / Después" de unos canales (la página lo pide cada pocos minutos). */
function guideNow(params, done) {
  var id = String(params && params.id || '');
  var keys = Array.isArray(params && params.keys) ? params.keys.slice(0, 3000) : [];
  var favs = loadIndex().favorites;
  var now = Date.now(), out = {};
  keys.forEach(function (k) {
    k = String(k);
    var listId = id === 'fav' ? (favs[k] && favs[k].list) : id;
    var g = epgNow(listId, k, now);
    if (g) { out[k] = g; }
  });
  done(null, { guide: out });
}

function favorite(params, done) {
  var c = params && params.channel;
  var idx = loadIndex();
  if (!c || !c.k || !/^https?:\/\//i.test(String(c.u || ''))) { return done(new Error('Canal no válido')); }
  var key = String(c.k).replace(/[^a-f0-9]/g, '').slice(0, 16);
  if (params.on) {
    var listId = String(c.list || '').replace(/[^a-f0-9]/g, '').slice(0, 20);
    var saved = { k: key, n: cleanText(c.n, 120), g: cleanText(c.g, 80), u: String(c.u).slice(0, 2000), list: listId };
    /* El logo se guarda con su dirección original, no la del proxy (cambia cada vez). */
    var logo = originalLogo(listId, key) || (/^https:\/\//i.test(String(c.l || '')) ? String(c.l) : '');
    if (logo) { saved.l = logo.slice(0, 600); }
    if (c.ua) { saved.ua = cleanText(c.ua, 300); }
    if (c.ref) { saved.ref = cleanText(c.ref, 600); }
    if (c.yt) { saved.yt = 1; }
    idx.favorites[key] = saved;
  } else {
    delete idx.favorites[key];
  }
  saveIndex();
  done(null, { favorites: Object.keys(idx.favorites) });
}

/* El logo original (sin proxy) de un canal guardado, para los favoritos. */
function originalLogo(listId, key) {
  var list = storedChannels(listId) || [];
  for (var i = 0; i < list.length; i++) { if (list[i].k === key) { return list[i].l || ''; } }
  return '';
}

/* --------------------------------------------------------- comprobar canales */
function channelHeaders(c) {
  var headers = { 'User-Agent': c.ua || DEFAULT_UA, Accept: '*/*' };
  if (c.ref) { headers.Referer = c.ref; }
  return headers;
}

/* Vivo = responde sin error y no es una página web.  Lee unos pocos bytes. */
function checkOne(c, cb, hops) {
  hops = hops || 0;
  if (c.yt) { return cb(true); }
  var target = c.u, settled = false;
  function settle(alive) { if (!settled) { settled = true; cb(alive); } }
  request(target, channelHeaders(c), function (res, req) {
    var status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location && hops < 4) {
      res.resume();
      return checkOne({ u: urlmod.resolve(target, res.headers.location), ua: c.ua, ref: c.ref }, settle, hops + 1);
    }
    if (status >= 400) { res.resume(); return settle(false); }
    var parts = [], size = 0;
    var timer = setTimeout(finish, CHECK_READ_MS);
    function finish() {
      clearTimeout(timer);
      try { req.abort(); } catch (eAbort) { /* nada */ }
      var kind = kindOf({ type: String(res.headers['content-type'] || '').toLowerCase(), head: Buffer.concat(parts) });
      settle(kind !== 'html' && (size > 0 || status === 200));
    }
    res.on('data', function (chunk) { parts.push(chunk); size += chunk.length; if (size >= 4096) { finish(); } });
    res.on('end', finish);
    res.on('error', finish);
  }, function () { settle(false); }, CHECK_TIMEOUT_MS);
}

function checkStatusOf(id) {
  var meta = findList(id);
  var job = checks[id];
  return {
    running: !!(job && job.running), done: job ? job.done : 0, total: job ? job.total : 0,
    down: job ? job.downCount : (meta && meta.down) || 0, checkedAt: (meta && meta.checkedAt) || 0
  };
}

function checkStart(params, done) {
  var id = String(params && params.id || '');
  var meta = findList(id);
  if (!meta) { return done(new Error('La lista ya no existe')); }
  if (checks[id] && checks[id].running) { return done(null, checkStatusOf(id)); }
  var list = (storedChannels(id) || []).slice();
  var job = checks[id] = { total: list.length, done: 0, downCount: 0, down: {}, running: true, stop: false, at: Date.now() };
  var next = 0, active = 0;
  timing.log('mis listas: comprobando ' + list.length + ' canales');
  function finish() {
    if (!job.running) { return; }
    job.running = false;
    if (job.stop) { return; }
    var status = { checkedAt: Date.now(), down: job.down };
    memStatus[id] = status;
    writeJson('status-' + id + '.json', status);
    var m = findList(id);
    if (m) { m.checkedAt = status.checkedAt; m.down = job.downCount; saveIndex(); }
    timing.log('mis listas: comprobación terminada en ' + Math.round((Date.now() - job.at) / 1000) + ' s (' +
      job.downCount + ' sin señal de ' + job.total + ')');
  }
  function pump() {
    if (job.stop) { if (active === 0) { finish(); } return; }
    if (job.done >= job.total) { return finish(); }
    while (active < CHECK_CONCURRENCY && next < list.length) {
      (function (c) {
        active++;
        checkOne(c, function (alive) {
          active--;
          job.done++;
          if (!alive) { job.down[c.k] = 1; job.downCount++; }
          pump();
        });
      })(list[next++]);
    }
  }
  pump();
  done(null, checkStatusOf(id));
}

function checkStatus(params, done) { done(null, checkStatusOf(String(params && params.id || ''))); }

function checkStop(params, done) {
  var id = String(params && params.id || '');
  if (checks[id] && checks[id].running) { checks[id].stop = true; checks[id].running = false; }
  done(null, checkStatusOf(id));
}

/* --------------------------------------------------- guía de programación */
function codePoint(n) {
  try { return String.fromCodePoint(n); } catch (eCp) { return ''; }
}
function decodeXml(text) {
  return String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, function (all, hex) { return codePoint(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function (all, dec) { return codePoint(parseInt(dec, 10)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/* "20261113140000 +0000" -> milisegundos UTC. */
function xmltvTime(text) {
  var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-])?(\d{2})?(\d{2})?/.exec(String(text || '').trim());
  if (!m) { return 0; }
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) { t -= (m[7] === '-' ? -1 : 1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) * 60000; }
  return t;
}

/* Nombre comparable: sin tildes, sin "(720p)", "HD", "[Geo]"… */
function nameKey(text) {
  return foldKey(text).replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\+/g, ' plus ').replace(/\b(hd|fhd|uhd|sd|4k|hevc|h265|1080p|720p|480p|live|en vivo|tv)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

/* Lee una guía XMLTV por partes (pueden ser cientos de MB) y entrega cada
   <channel> y cada <programme> sin guardar el archivo entero en memoria. */
function streamXmltv(target, onChannel, onProgramme, done, hops) {
  hops = hops || 0;
  request(target, { 'User-Agent': LIST_UA, Accept: '*/*', 'Accept-Encoding': 'gzip, deflate' }, function (res, req) {
    var status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location && hops < 6) {
      res.resume();
      return streamXmltv(urlmod.resolve(target, res.headers.location), onChannel, onProgramme, done, hops + 1);
    }
    if (status !== 200) { res.resume(); return done(new Error('El servidor de la guía respondió con un error (HTTP ' + status + ')')); }
    var decoder = new StringDecoder('utf8');
    var buf = '', raw = 0, finished = false, sawXml = false;
    function end(err) { if (!finished) { finished = true; done(err); } }
    function drain() {
      var pos = 0;
      for (;;) {
        var ci = buf.indexOf('<channel', pos), pi = buf.indexOf('<programme', pos);
        var i = ci < 0 ? pi : (pi < 0 ? ci : Math.min(ci, pi));
        if (i < 0) { pos = Math.max(pos, buf.length - 12); break; }
        var prog = i === pi;
        var close = prog ? '</programme>' : '</channel>';
        var j = buf.indexOf(close, i);
        var selfClose = buf.indexOf('/>', i);
        var tagEnd = buf.indexOf('>', i);
        if (tagEnd > 0 && selfClose === tagEnd - 1 && (j < 0 || selfClose < j)) { pos = tagEnd + 1; continue; }
        if (j < 0) { pos = i; break; }
        var block = buf.slice(i, j + close.length);
        pos = j + close.length;
        sawXml = true;
        if (prog) { onProgramme(block); } else { onChannel(block); }
      }
      buf = buf.slice(pos);
      if (buf.length > 4 * 1024 * 1024) { buf = ''; }   // algo que no es XMLTV: no acumular
    }
    decodedBody(res, function (chunk) {
      if (finished) { return; }
      raw += chunk.length;
      if (raw > EPG_MAX_BYTES) { try { req.abort(); } catch (eA) { /* nada */ } return end(new Error('La guía es demasiado grande')); }
      buf += decoder.write(chunk);
      drain();
    }, function () {
      buf += decoder.end();
      drain();
      end(sawXml ? null : new Error('Esa dirección no es una guía XMLTV'));
    }, function (err) { end(err); });
  }, function (err) { done(err); }, 60000);
}

function epgUpdate(params, done) {
  var id = String(params && params.id || '');
  var meta = findList(id);
  if (!meta) { return done(new Error('La lista ya no existe')); }
  var guideUrl = meta.epgCustom || meta.epgUrl;
  if (!guideUrl) { return done(new Error('Esta lista no indica una guía de programación')); }
  /* Ya se está descargando (p. ej. la tarea automática): esperar a esa. */
  if (epgJobs[id]) { epgJobs[id].push(done); return; }
  var waiters = epgJobs[id] = [done];
  done = function (err, data) { waiters.forEach(function (cb) { try { cb(err, data); } catch (eCb) { /* nada */ } }); };
  var list = storedChannels(id) || [];
  var byId = {}, byName = {};
  list.forEach(function (c) {
    if (c.id) { (byId[c.id.toLowerCase()] = byId[c.id.toLowerCase()] || []).push(c.k); }
    var nk = nameKey(c.n);
    if (nk) { (byName[nk] = byName[nk] || []).push(c.k); }
  });
  var xmlToKeys = {};
  var progs = {};
  var from = Date.now() - EPG_PAST_MS, to = Date.now() + EPG_AHEAD_MS;
  var t0 = Date.now(), seenProgrammes = 0;
  function keysFor(xmlId) {
    if (xmlToKeys[xmlId]) { return xmlToKeys[xmlId]; }
    return byId[String(xmlId).toLowerCase()] || null;
  }
  streamXmltv(guideUrl, function (block) {
    var idm = /\bid="([^"]*)"/.exec(block);
    if (!idm) { return; }
    var xmlId = decodeXml(idm[1]);
    var keys = (byId[xmlId.toLowerCase()] || []).slice();
    var re = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g, m;
    while ((m = re.exec(block))) {
      var hit = byName[nameKey(decodeXml(m[1]))];
      if (hit) { hit.forEach(function (k) { if (keys.indexOf(k) < 0) { keys.push(k); } }); }
    }
    if (keys.length) { xmlToKeys[xmlId] = keys; }
  }, function (block) {
    seenProgrammes++;
    var open = block.slice(0, block.indexOf('>') + 1);
    var chm = /\bchannel="([^"]*)"/.exec(open);
    if (!chm) { return; }
    var keys = keysFor(decodeXml(chm[1]));
    if (!keys) { return; }
    var sm = /\bstart="([^"]*)"/.exec(open), em = /\bstop="([^"]*)"/.exec(open);
    var s = xmltvTime(sm && sm[1]), e = xmltvTime(em && em[1]);
    if (!s || (e && e < from) || s > to) { return; }
    var tm = /<title[^>]*>([\s\S]*?)<\/title>/.exec(block);
    var title = cleanText(decodeXml(tm ? tm[1] : ''), 140);
    if (!title) { return; }
    keys.forEach(function (k) { (progs[k] = progs[k] || []).push([s, e || s + 30 * 60000, title]); });
  }, function (err) {
    delete epgJobs[id];
    var m2 = findList(id);
    if (!m2) { return done(new Error('La lista ya no existe')); }
    if (err) {
      m2.epgError = err.message || 'error';
      m2.epgAt = Date.now();
      saveIndex();
      timing.log('mis listas: guía no disponible: ' + timing.safeError(err));
      return done(new Error('No se pudo cargar la guía: ' + m2.epgError));
    }
    var matched = 0;
    Object.keys(progs).forEach(function (k) {
      var arr = progs[k].sort(function (a, b) { return a[0] - b[0]; });
      /* Sin repetidos (varias fuentes del mismo canal) y como mucho EPG_PER_CHANNEL. */
      var clean = [];
      arr.forEach(function (p) { if (!clean.length || clean[clean.length - 1][0] !== p[0]) { clean.push(p); } });
      progs[k] = clean.slice(0, EPG_PER_CHANNEL);
      matched++;
    });
    var saved = { fetchedAt: Date.now(), p: progs };
    memEpg[id] = saved;
    writeJson('epg-' + id + '.json', saved);
    m2.epgAt = saved.fetchedAt;
    m2.epgMatched = matched;
    m2.epgError = matched ? '' : 'La guía no tiene programas para los canales de esta lista';
    saveIndex();
    timing.log('mis listas: guía cargada en ' + Math.round((Date.now() - t0) / 1000) + ' s (' + seenProgrammes +
      ' programas leídos, ' + matched + ' canales con guía de ' + list.length + ')');
    done(null, { list: publicList(m2) });
  });
}

/* -------------------------------------------------------------- reproducción */
function probe(target, headers, done, hops) {
  hops = hops || 0;
  request(target, headers, function (res, req) {
    var status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location && hops < 6) {
      res.resume();
      return probe(urlmod.resolve(target, res.headers.location), headers, done, hops + 1);
    }
    if (status >= 400) {
      res.resume();
      return done(new Error(status === 403 || status === 401 ? 'El canal rechazó la conexión (HTTP ' + status + '). Puede que solo funcione en su país o que haya caducado.'
        : 'El canal no respondió correctamente (HTTP ' + status + '). Puede que ya no exista.'));
    }
    var type = String(res.headers['content-type'] || '').toLowerCase();
    var parts = [], size = 0, settled = false;
    function settle() {
      if (settled) { return; }
      settled = true;
      try { req.abort(); } catch (eAbort) { /* nada */ }
      var head = Buffer.concat(parts);
      done(null, { url: target, type: type, head: head });
    }
    res.on('data', function (chunk) { parts.push(chunk); size += chunk.length; if (size >= PROBE_BYTES) { settle(); } });
    res.on('end', settle);
    res.on('error', settle);
    /* Un TS en directo no termina nunca: con los primeros bytes basta. */
    setTimeout(settle, 4000);
  }, function (err) { done(err); }, PROBE_TIMEOUT_MS);
}

function kindOf(info) {
  var head = info.head || Buffer.alloc(0);
  var text = head.slice(0, 64).toString('utf8').replace(/^﻿/, '').trim();
  if (/^#EXTM3U/i.test(text) || /mpegurl/.test(info.type)) { return 'hls'; }
  if (head.length >= 8 && head.slice(4, 8).toString('latin1') === 'ftyp') { return 'mp4'; }
  if (head.length >= 189 && head[0] === 0x47 && head[188] === 0x47) { return 'ts'; }
  if (/mp2t|mpeg-?ts|video\/mpeg/.test(info.type)) { return 'ts'; }
  if (/video\/mp4/.test(info.type)) { return 'mp4'; }
  if (/text\/html/.test(info.type) || /^<(!doctype|html)/i.test(text)) { return 'html'; }
  if (/^(audio|video)\//.test(info.type) || /octet-stream/.test(info.type)) { return 'ts'; }
  return '';
}

function play(params, done) {
  var target = String(params && params.u || '').trim();
  var name = cleanText(params && params.n, 80) || 'canal';
  if (!/^https?:\/\//i.test(target)) { return done(new Error('Este canal no tiene una dirección válida')); }
  if (isYoutube(target)) { return done(new Error('Los canales de YouTube se abren en su propia ventana.')); }
  var headers = { 'User-Agent': cleanText(params.ua, 300) || DEFAULT_UA, Accept: '*/*' };
  if (params.ref) { headers.Referer = cleanText(params.ref, 600); }
  var t0 = Date.now();
  proxy.start(function (perr) {
    if (perr) { return done(perr); }
    probe(target, headers, function (err, info) {
      if (err) {
        timing.log('mis listas: ' + name + ' | sin respuesta: ' + timing.safeError(err));
        return done(err.message && /HTTP|canal/.test(err.message) ? err : new Error('No se pudo conectar con el canal: ' + timing.safeError(err)));
      }
      var kind = kindOf(info);
      timing.log('mis listas: ' + name + ' | formato ' + (kind || 'desconocido') + ' | listo en ' + (Date.now() - t0) + 'ms');
      if (kind === 'html') { return done(new Error('Ese enlace abre una página web, no un vídeo. El canal no se puede reproducir.')); }
      if (kind === 'hls' || kind === 'mp4') {
        var token = proxy.add(info.url, headers, 0, '', []);
        if (kind === 'hls') { proxy.markHls(token); }
        proxy.label(token, 'mis listas ' + name);
        return done(null, { kind: kind, proxyPath: proxy.baseUrl() + '/media/' + token + '/stream.' + (kind === 'hls' ? 'm3u8' : 'mp4'), isHls: kind === 'hls' });
      }
      if (!relay.available()) {
        return done(new Error('Este canal usa un formato que necesita FFmpeg (Modo fluido) y no está disponible.'));
      }
      var relayUrl = relay.register({ url: info.url, headers: headers }, { hw: params.fluidHw !== 'off' });
      done(null, { kind: 'ts', proxyPath: relayUrl, isHls: false, isRelay: true });
    });
  });
}

module.exports = {
  parse: parse,
  index: index,
  settings: settings,
  add: add,
  addFile: addFile,
  syncFolder: syncFolder,
  setSyncFolder: setSyncFolder,
  syncFromFolder: syncFromFolder,
  isYoutube: isYoutube,
  refresh: refresh,
  remove: remove,
  rename: rename,
  channels: channels,
  guideNow: guideNow,
  favorite: favorite,
  originalLogo: originalLogo,
  checkStart: checkStart,
  checkStatus: checkStatus,
  checkStop: checkStop,
  epgUpdate: epgUpdate,
  play: play,
  _kindOf: kindOf,
  _buildXtreamUrl: buildXtreamUrl,
  _parseJson: parseJson,
  _parseList: parseList,
  _xmltvTime: xmltvTime,
  _nameKey: nameKey,
  _groupName: groupName
};
