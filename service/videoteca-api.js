'use strict';
/* Videoteca API adapter. Media links are resolved on demand and kept out of
 * the renderer. Movie and series endpoints were verified against the API. */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var proxy = require('./proxy');
var relay = require('./ffmpeg-relay');
var timing = require('./timing');
var config = require('./lamovie-api.json');
var BASE = config.base_url;
var PREFIX = 'vt:lamovie:';
var TTL = 15 * 60 * 1000;
var memory = {}, inFlight = {}, titles = {}, favoritesMap = {}, pages = {}, loadedDir = null;

function text(value, max) {
  return String(value == null ? '' : value).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, max || 600);
}
function folder() {
  var dir = process.env.XUPER_DATA_DIR ? path.join(process.env.XUPER_DATA_DIR, 'videoteca', 'lamovie') : '';
  if (loadedDir !== dir) {
    loadedDir = dir; memory = {}; titles = {}; favoritesMap = {}; pages = {};
    if (dir) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return ''; }
      try { titles = JSON.parse(fs.readFileSync(path.join(dir, 'titles.json'), 'utf8')); } catch (eRead) { /* new library */ }
      try { favoritesMap = JSON.parse(fs.readFileSync(path.join(dir, 'favorites.json'), 'utf8')); } catch (eFav) { /* no favorites */ }
    }
  }
  return dir;
}
function save(name, data) {
  var dir = folder();
  if (!dir) { return; }
  var file = path.join(dir, name + '.json'), tmp = file + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file); } catch (e) { /* read-only profile */ }
}
function apiUrl(value) {
  var u = new URL(value, BASE);
  if (u.origin !== new URL(BASE).origin || u.username || u.password || u.protocol !== 'https:') {
    throw new Error('La API devolvió una dirección no válida');
  }
  return u.href;
}
function image(value) {
  try {
    var u = new URL(String(value || ''));
    if (u.protocol === 'https:') { return u.href; }
    if (u.protocol === 'http:') { return proxy.addRadio(u.href); }
  } catch (e) { /* optional artwork */ }
  return '';
}
function directMediaUrl(value) {
  var u = new URL(value);
  var allowed = (config.direct_media_hosts || []).some(function (host) {
    return u.hostname === host || u.hostname.endsWith('.' + host);
  });
  if (!allowed || u.protocol !== 'https:' || u.username || u.password || u.port) {
    throw new Error('Dirección de vídeo directo no permitida');
  }
  return u.href;
}
function normalize(d) {
  if (!d || !/^[a-zA-Z0-9_-]+$/.test(String(d.slug || '')) || !d.title) { return null; }
  var genres = d.genres_tmdb || d.tmdb_genres || d.genres || [];
  if (!Array.isArray(genres)) { genres = [genres]; }
  var t = {
    id: PREFIX + (d.post_id || d.slug), slug: d.slug, postId: d.post_id || null,
    type: d.type === 'episode' ? 'episode' : (d.type === 'tvshows' || d.type === 'series' || Array.isArray(d.temporadas) || /\/serie\//.test(d.url || '') ? 'series' : 'movie'),
    title: text(d.title, 160), year: parseInt(d.year, 10) || 0,
    runtime: Math.round(parseFloat(d.runtime) || 0), rating: Number(d.tmdb_rating || d.rating) || 0,
    genres: genres.map(function (g) { return text(g && g.name || g, 50); }).filter(Boolean),
    overview: text(d.overview_tmdb || d.tmdb_overview || d.overview || d.description, 1800),
    poster: image(d.poster_tmdb || d.tmdb_poster || d.image), backdrop: image(d.backdrop),
    source: 'lamovie', sourceName: 'LaMovie', quality: text(d.quality, 80),
    cast: Array.isArray(d.cast) ? d.cast.map(function (p) { return text(p.name || p, 80); }).slice(0, 12) : []
  };
  if (d.episodePath) { t.episodePath = d.episodePath; t.parentId = d.parentId; t.season = d.season; t.number = d.number; }
  if (t.type === 'series' && Array.isArray(d.temporadas)) {
    t.episodes = [];
    d.temporadas.forEach(function (season) {
      var seasonNumber = Number(season.season_number);
      if (!Number.isInteger(seasonNumber) || seasonNumber < 0 || !Array.isArray(season.episodios)) { return; }
      season.episodios.forEach(function (ep) {
        var number = Number(ep.episode_number);
        if (!Number.isInteger(number) || number < 1 || !/^\d+$/.test(String(ep.post_id))) { return; }
        var episode = {
          id: PREFIX + ep.post_id, postId: ep.post_id, slug: t.slug, type: 'episode', parentId: t.id,
          season: seasonNumber, number: number, title: text(ep.name || 'Episodio ' + number, 180),
          runtime: t.runtime, year: t.year, genres: t.genres, poster: image(ep.still) || t.poster,
          backdrop: t.backdrop, overview: text(ep.overview, 1800), source: 'lamovie',
          episodePath: '/serie/' + encodeURIComponent(t.slug) + '/' + seasonNumber + '/' + number
        };
        titles[episode.id] = episode;
        t.episodes.push({ id: episode.id, season: seasonNumber, number: number, title: episode.title });
      });
    });
    t.episodes.sort(function (a, b) { return a.season - b.season || a.number - b.number; });
  }
  if (d.embeds && Array.isArray(d.embeds.video)) {
    t.servers = d.embeds.video.map(function (v, i) {
      return { index: i, name: text(v.name || v.server || 'Servidor ' + (i + 1), 60),
        language: text(v.language, 50), quality: text(v.quality, 50) };
    });
    t.playable = t.servers.length > 0;
  }
  titles[t.id] = t;
  return t;
}
function request(value, done, fresh) {
  folder();
  var url;
  try { url = apiUrl(value); } catch (error) { return done(error); }
  var key = crypto.createHash('sha256').update(url).digest('hex');
  var hit = memory[key];
  if (!hit && loadedDir) {
    try { hit = JSON.parse(fs.readFileSync(path.join(loadedDir, key + '.json'), 'utf8')); } catch (e) { /* uncached */ }
  }
  if (!fresh && hit && Date.now() - hit.at < TTL) { return done(null, hit.data, false); }
  if (inFlight[key]) { inFlight[key].push(done); return; }
  inFlight[key] = [done];
  function finish(err, data, stale) {
    var callbacks = inFlight[key] || []; delete inFlight[key];
    callbacks.forEach(function (cb) { cb(err, data, !!stale); });
  }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 20000);
  fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'XuperDesktop Videoteca inspection' } })
    .then(function (res) {
      if (!res.ok) {
        var error = new Error(res.status === 429 ? 'La fuente está limitando las consultas. Espera un momento y reintenta.' :
          'La fuente de Videoteca respondió HTTP ' + res.status);
        throw error;
      }
      return res.text();
    }).then(function (body) {
      if (body.length > 8 * 1024 * 1024) { throw new Error('La respuesta de Videoteca es demasiado grande'); }
      var data = JSON.parse(body);
      clearTimeout(timer);
      memory[key] = { at: Date.now(), data: data };
      var keys = Object.keys(memory); if (keys.length > 100) { delete memory[keys[0]]; }
      if (!fresh) { save(key, memory[key]); }
      finish(null, data, false);
    }).catch(function (err) {
      clearTimeout(timer);
      if (!fresh && hit && hit.data) { return finish(null, hit.data, true); }
      finish(new Error(err.name === 'AbortError' ? 'La fuente de Videoteca tarda en responder. Puedes reintentar.' : err.message));
    });
}
/* Drop a cached answer that turned out to be wrong, so the next call asks
 * the source again instead of repeating the same error for 15 minutes. */
function forget(value) {
  folder();
  var key;
  try { key = crypto.createHash('sha256').update(apiUrl(value)).digest('hex'); } catch (e) { return; }
  delete memory[key];
  if (loadedDir) { try { fs.unlinkSync(path.join(loadedDir, key + '.json')); } catch (eDel) { /* not cached */ } }
}
function pageData(json) {
  var raw = json && (json.items || json.results);
  if (!Array.isArray(raw)) { throw new Error('La fuente devolvió un catálogo con formato inesperado'); }
  var seen = {};
  var items = raw.map(normalize).filter(function (t) {
    if (!t || seen[t.id]) { return false; } seen[t.id] = true; return true;
  });
  var next = null;
  if (json.next_page_url) { next = apiUrl(json.next_page_url); }
  return { items: items, total: Number(json.total_results) || items.length, page: Number(json.page) || 1, more: !!next, next: next };
}
function catalog(page, done, kind) {
  folder();
  var key = (kind === 'series' ? 'series:' : 'movie:');
  var u = new URL(kind === 'series' ? config.series_catalog_path : config.catalog_path, BASE); u.searchParams.set('page', String(page));
  var target = pages[key + page] || u.href;
  request(target, function (err, data, stale) {
    if (err) { return done(err); }
    try {
      var result = pageData(data);
      if (result.next === target) { result.next = null; result.more = false; }
      if (result.next) { pages[key + (page + 1)] = result.next; }
      result.stale = stale; save('titles', titles); done(null, result);
    }
    catch (e) { done(e); }
  });
}
function sources(total) { return { folders: [], localCount: 0, name: 'LaMovie', total: total || 0, moviesOnly: false }; }
function home(params, done) {
  folder();
  if (params && params.kind === 'fav') {
    var fav = Object.keys(favoritesMap).map(function (id) { return titles[id] || favoritesMap[id]; }).filter(Boolean);
    return done(null, { hero: [], rows: fav.length ? [{ id: 'fav', title: 'Tus favoritos', items: fav }] : [], sources: sources() });
  }
  catalog(1, function (err, data) {
    if (err) { return done(err); }
    var seriesOnly = params && params.kind === 'series';
    var rows = [{ id: seriesOnly ? 'series' : 'catalog', title: seriesOnly ? 'Series' : 'Películas', items: data.items, more: data.more }];
    var groups = {};
    data.items.forEach(function (t) { t.genres.forEach(function (g) { (groups[g] || (groups[g] = [])).push(t); }); });
    Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length; }).slice(0, 5).forEach(function (g) {
      if (groups[g].length >= 3) { rows.push({ id: 'genre:' + g, title: g, items: groups[g], more: false }); }
    });
    var hero = data.items.filter(function (t) { return t.backdrop && t.overview; }).slice(0, 5);
    var result = { hero: hero, rows: rows, sources: sources(data.total),
      error: data.stale ? 'La fuente no responde. Estás viendo el último catálogo guardado.' : '', updatedAt: Date.now() };
    if (params && params.kind === 'all') {
      return catalog(1, function (seriesError, seriesData) {
        if (seriesError) { result.error = 'No se pudieron cargar las series. Puedes reintentar desde Series.'; }
        else {
          result.rows.splice(1, 0, { id: 'series', title: 'Series', items: seriesData.items, more: seriesData.more });
          result.sources.total += seriesData.total;
        }
        done(null, result);
      }, 'series');
    }
    done(null, result);
  }, params && params.kind);
}
function browse(params, done) { catalog(Math.max(1, Math.min(10000, parseInt(params && params.page, 10) || 1)), done, params && params.row === 'series' ? 'series' : 'movie'); }
function search(params, done) {
  var q = text(params && params.q, 100);
  if (q.length < 2) { return done(null, { items: [] }); }
  var u = new URL(config.search_path, BASE); u.searchParams.set('q', q); u.searchParams.set('page', String(Math.max(1, Number(params.page) || 1)));
  request(u.href, function (err, json, stale) {
    if (err) { return done(err); }
    try { var result = pageData(json); result.error = stale ? 'Resultados guardados; la fuente no responde.' : ''; save('titles', titles); done(null, result); }
    catch (e) { done(e); }
  });
}
function detail(id, done, fresh) {
  folder();
  var t = titles[id] || favoritesMap[id];
  if (!t || id.indexOf(PREFIX) !== 0 || !/^[\w-]+$/.test(t.slug)) { return done(new Error('Este título ya no está en el catálogo. Búscalo de nuevo en Videoteca.')); }
  var endpoint = t.type === 'episode' ? t.episodePath : (t.type === 'series' ? '/serie/' : '/pelicula/') + encodeURIComponent(t.slug);
  request(endpoint, function (err, json, stale) {
    if (err) { return done(err); }
    if (t.type === 'episode' && (json.serie_slug !== t.slug || Number(json.season) !== t.season || Number(json.episode) !== t.number)) {
      forget(endpoint);
      return done(new Error('La fuente devolvió un capítulo diferente al seleccionado'));
    }
    var full = normalize(t.type === 'episode' ? Object.assign({}, json, { slug: t.slug, type: 'episode',
      runtime: t.runtime, genres: t.genres, image: t.poster, backdrop: t.backdrop,
      episodePath: t.episodePath, parentId: t.parentId, season: t.season, number: t.number }) : json);
    if (!full || full.id !== id) { forget(endpoint); return done(new Error('La fuente devolvió una ficha diferente a la película seleccionada')); }
    save('titles', titles);
    done(null, full, json, stale);
  }, fresh);
}
function title(params, done) {
  detail(String(params && params.id || ''), function (err, t, json, stale) {
    if (err) { return done(err); }
    done(null, { title: t, related: [], stale: stale });
  });
}
/* A master playlist that answers 200 does not prove the video plays: a server
 * can deliver both playlists and then reject every segment (Voe through the
 * API proxy answered HTTP 400 to segments on 13/11/2026). Check the chain
 * master -> media playlist -> first segment before handing it to the player,
 * so a broken server is skipped and the next one is tried. */
var MEDIA_UA = { 'User-Agent': 'XuperDesktop Videoteca inspection' };
function mediaFetch(url, extraHeaders) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 10000);
  return fetch(url, { signal: ctrl.signal, headers: Object.assign({}, MEDIA_UA, extraHeaders || {}) })
    .then(function (res) {
      if (!res.ok) {
        if (res.body) { res.body.cancel().catch(function () {}); }
        var rejection = new Error('La petición al servidor de vídeo respondió HTTP ' + res.status + '.');
        rejection.status = res.status;
        throw rejection;
      }
      return res;
    }).finally(function () { clearTimeout(timer); });
}
function readPlaylist(url) {
  return mediaFetch(url).then(function (res) {
    return res.text();
  }).then(function (body) {
    if (body.length > 4 * 1024 * 1024) { throw new Error('La lista de vídeo es demasiado grande.'); }
    if (!/^\s*#EXTM3U/.test(body)) { throw new Error('La fuente no entregó una lista de vídeo válida. Prueba otro servidor.'); }
    return body;
  });
}
function firstUri(body, base) {
  var lines = body.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === '#') { continue; }
    var u = new URL(line, base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') { throw new Error('La lista de vídeo contiene una dirección no válida.'); }
    return u.href;
  }
  return '';
}
function checkPlaylist(url, done) {
  readPlaylist(url).then(function (master) {
    if (!/#EXT-X-STREAM-INF/i.test(master)) { return { body: master, url: url }; }
    var variant = firstUri(master, url);
    if (!variant) { throw new Error('La lista de vídeo no tiene calidades. Prueba otro servidor.'); }
    return readPlaylist(variant).then(function (body) { return { body: body, url: variant }; });
  }).then(function (media) {
    var segment = firstUri(media.body, media.url);
    if (!segment) { throw new Error('La lista de vídeo está vacía. Prueba otro servidor.'); }
    return mediaFetch(segment, { Range: 'bytes=0-1023' }).then(function (res) {
      if (res.body) { res.body.cancel().catch(function () {}); }
    });
  }).then(function () { done(null); }, function (err) {
    if (err.status) { return done(err); }
    done(new Error(err.name === 'AbortError' ? 'El servidor de vídeo tarda en responder. Reintenta en un momento.' : err.message));
  });
}
/* Servers that failed for a title are tried last for a while: Flyboys spent
 * ~6 s on every play asking Voe (403 through the proxy) before LaMovie. */
var BAD_SERVER_MS = 30 * 60 * 1000;
var badServers = {};
function serverIsBad(id, index) {
  var at = badServers[id] && badServers[id][index];
  return !!at && Date.now() - at < BAD_SERVER_MS;
}
function markServer(id, index, bad) {
  if (bad) { (badServers[id] || (badServers[id] = {}))[index] = Date.now(); }
  else if (badServers[id]) { delete badServers[id][index]; }
}
function play(params, done) {
  var finished = false, failures = [], deadline;
  var id = String(params && params.id || '');
  var trace = timing.trace('videoteca', id.replace(PREFIX, ''));
  var callback = done;
  done = function (error, result) {
    if (finished) { return; }
    finished = true; clearTimeout(deadline);
    trace.end(error ? 'ERROR ' + timing.safeError(error) : 'servidor ' + result.serverName);
    callback(error, result);
  };
  deadline = setTimeout(function () {
    done(new Error('No se pudo abrir un servidor de esta película a tiempo. Reintenta o prueba otro título.'));
  }, 50000);
  /* The title page already loaded this ficha (cached for 15 min): asking for
     it again only delayed playback by 1-3 s. The signed video link comes from
     the resolver, which is always asked fresh below. */
  detail(id, function (err, t, raw) {
    if (finished) { return; }
    if (err) { return done(err); }
    trace.mark('ficha');
    var index = Math.max(0, parseInt(params.serverIndex, 10) || 0);
    var servers = raw.embeds && raw.embeds.video || [];
    var order = [index].concat(servers.map(function (server, i) { return i; }).filter(function (i) { return i !== index; }))
      .filter(function (i) { return servers[i] && servers[i].stream_url; });
    var good = order.filter(function (i) { return !serverIsBad(id, i); });
    order = good.concat(order.filter(function (i) { return good.indexOf(i) === -1; })).slice(0, 3);
    if (!order.length) { return done(new Error('Esta película no tiene un servidor disponible. Prueba con otra película.')); }
    function tryServer() {
    if (finished) { return; }
    if (!order.length) {
      return done(new Error('Ningún servidor disponible pudo abrir esta película. ' + failures.join(' ')));
    }
    var selectedIndex = order.shift(), server = servers[selectedIndex];
    var serverName = text(server.name || server.server || 'Servidor', 60);
    function failed(error) {
      markServer(id, selectedIndex, true);
      trace.mark(serverName, 'falló: ' + (error.status ? 'HTTP ' + error.status : timing.safeError(error)));
      failures.push(serverName + ': ' +
        (error.status ? 'HTTP ' + error.status + '.' : text(error.message, 180)));
      tryServer();
    }
    var resolver;
    try { resolver = apiUrl(server.stream_url); } catch (e) { return failed(e); }
    function resolveMedia(renewed) {
      request(resolver, function (error, resolved) {
        if (finished) { return; }
        if (error) { return failed(error); }
        trace.mark('resolvedor ' + serverName);
        var variants = Array.isArray(resolved.qualities) ? resolved.qualities : [];
        var candidates = [], rejection;
        function candidate(value, direct) {
          if (!value) { return; }
          try {
            var url = direct ? directMediaUrl(value) : apiUrl(value);
            if (!direct && new URL(url).pathname !== '/streamproxy') { return; }
            if (candidates.indexOf(url) === -1) { candidates.push(url); }
          } catch (invalid) { /* ignore untrusted media URLs */ }
        }
        variants.forEach(function (v) { if (v) { candidate(v.url, true); } });
        var hls = resolved.videos && resolved.videos.hls;
        if (Array.isArray(hls)) { hls.forEach(function (url) { candidate(url, true); }); }
        variants.forEach(function (v) { if (v) { candidate(v.proxy_url, false); } });
        function tryMedia() {
        if (finished) { return; }
        if (!candidates.length) {
          if (rejection && !renewed && !order.length && (rejection.status === 401 || rejection.status === 403)) {
            return resolveMedia(true);
          }
          return failed(rejection || new Error('El servidor no entregó un enlace reproducible permitido.'));
        }
        var media = candidates.shift();
        var headers = { 'User-Agent': 'XuperDesktop Videoteca inspection' };
        /* Modo fluido is not offered for Videoteca (H.264/AAC plays directly);
           kept only for an explicit smooth request, checked at the source. */
        if (params.smooth) {
          return checkPlaylist(media, function (mediaError) {
            if (finished) { return; }
            if (mediaError) { rejection = mediaError; return tryMedia(); }
            if (!relay.available()) { return done(new Error('El modo fluido necesita FFmpeg')); }
            markServer(id, selectedIndex, false);
            done(null, { url: relay.register({ url: media, headers: headers }, {}), isRelay: true, duration: t.runtime * 60, serverIndex: selectedIndex, serverName: serverName });
          });
        }
        proxy.start(function (perr) {
          if (finished) { return; }
          if (perr) { return done(perr); }
          var token = proxy.add(media, headers, t.runtime * 60, '', []);
          proxy.markHls(token);
          proxy.label(token, 'videoteca ' + t.title);
          var local = proxy.baseUrl() + '/media/' + token + '/stream.m3u8';
          /* One check, through the local proxy: the path the player really
             uses (playlist -> quality playlist -> first segment). A direct
             fetch() check is not enough: Voe answered 200 to fetch() and 403
             to the proxy (13/11/2026), and checking both cost ~1.4 s more. */
          checkPlaylist(local, function (localError) {
            if (finished) { return; }
            if (localError) { rejection = localError; return tryMedia(); }
            trace.mark('comprobación ' + serverName);
            markServer(id, selectedIndex, false);
            done(null, { url: local, proxyPath: local, isHls: true, mime: 'application/vnd.apple.mpegurl', duration: t.runtime * 60, serverIndex: selectedIndex, serverName: serverName });
          });
        });
        }
        tryMedia();
      }, true);
    }
    resolveMedia(false);
    }
    tryServer();
  });
}
function favorite(params, done) {
  folder();
  var id = String(params && params.title && params.title.id || '');
  if (id.indexOf(PREFIX) !== 0 || (params.on && !titles[id])) { return done(new Error('Película no válida')); }
  if (params.on) { favoritesMap[id] = titles[id]; } else { delete favoritesMap[id]; }
  save('favorites', favoritesMap);
  done(null, { favorites: Object.keys(favoritesMap) });
}
function favorites(params, done) { folder(); done(null, { favorites: Object.keys(favoritesMap), sources: sources() }); }
module.exports = { home: home, browse: browse, search: search, title: title, play: play,
  favorite: favorite, favorites: favorites, _normalize: normalize, _pageData: pageData, _apiUrl: apiUrl,
  _resetServerMemory: function () { badServers = {}; } };
