/*
 * XuperTV webOS service: portal catalog + playback resolver.
 *
 * Why a service: the Magis portal sends no Access-Control-Allow-Origin and
 * rejects OPTIONS, so a packaged web app cannot POST to it directly. Node
 * services are not bound by the page's CORS rules, so the encrypted protocol
 * runs here and the app receives plain JSON through Luna.
 */
'use strict';

var Service = require('webos-service');
var pkg = require('./package.json');
var magis = require('./magis');
var proxy = require('./proxy');
var relay = require('./ffmpeg-relay');
var mediaDuration = require('./media-duration');
var dnsx = require('./dnsx');
var timing = require('./timing');
var netdiag = require('./netdiag');
var urlmod = require('url');

try {
  var httpsMod = require('https');
  var httpMod = require('http');
  if (httpsMod.globalAgent) { httpsMod.globalAgent.maxSockets = 32; }
  if (httpMod.globalAgent) { httpMod.globalAgent.maxSockets = 32; }
} catch (eAgent) { /* ignore */ }

var service = new Service(pkg.name);

/* Prevent unexpected network errors or aborts from terminating the service */
process.on('uncaughtException', function (err) {
  console.error('[xuper-service] uncaughtException:', (err && err.stack) || err);
});

/* Intercept process.exit so idle timers in webos-service do not kill the proxy */
try {
  process.exit = function (code) {
    console.log('[xuper-service] blocked process.exit(' + code + ') to keep streaming alive');
  };
} catch (eExit) { /* ignore */ }

/* Prolong idleTimeout to 24h and create a persistent activity */
if (service.activityManager) {
  try {
    service.activityManager.idleTimeout = 86400;
    service.activityManager.create('keepAlive', function (act) {
      console.log('[xuper-service] persistent activity created');
    });
  } catch (eAct) {
    console.log('[xuper-service] activityManager init note: ' + (eAct && eAct.message));
  }
}

function fail(message, err, code) {
  message.respond({
    returnValue: false,
    errorText: (err && err.message) || err || 'error',
    errorCode: code || (err && err.portalCode) || 1
  });
}

function respond(message, err, payload) {
  if (err) { return fail(message, err); }
  var out = payload || {};
  out.returnValue = true;
  message.respond(out);
}

service.register('ping', function (message) {
  message.respond({
    returnValue: true,
    service: pkg.name,
    version: pkg.version,
    portalHosts: magis.constants.ROOT_CODES ? 'magis' : 'none',
    proxyPort: proxy.port(),
    relayAvailable: relay.available(),
    ffmpegPath: relay.path(),
    relayPort: relay.port()
  });
});

/* keepAlive subscription keeps the Luna bus connection alive so the service never terminates */
service.register('keepAlive', function (message) {
  message.respond({
    returnValue: true,
    subscribed: !!message.isSubscription
  });
});

/* heartbeat method for periodic pings */
service.register('heartbeat', function (message) {
  message.respond({
    returnValue: true,
    alive: true,
    proxyPort: proxy.port(),
    timestamp: Date.now()
  });
});

/* Desktop uses the private IPC dispatcher for account credentials, never URL queries. */
service.register('accountLogin', function (message) {
  var credentials = message.payload || {};
  magis.loginAccount(credentials, function (err, result) { respond(message, err, result); });
  credentials.password = ''; credentials.userName = '';
});
/* Never returns the session itself: only whether there is one and its name. */
service.register('accountStatus', function (message) {
  var status = magis.accountStatus();
  status.returnValue = true;
  message.respond(status);
});
service.register('accountLogout', function (message) {
  magis.logoutAccount(function (err, result) { respond(message, err, result); });
});

/* home({root}) -> { items:[...] } for one portal root */
service.register('home', function (message) {
  var root = (message.payload && message.payload.root) || 'movies';
  magis.home(root, function (err, data) { respond(message, err, data); });
});

/* search({value, pageNum, pageSize}) -> { items:[...], total } */
service.register('search', function (message) {
  var p = message.payload || {};
  var value = p.value || '';
  magis.search(value, { pageNum: p.pageNum, pageSize: p.pageSize }, function (err, data) { respond(message, err, data); });
});

/* detail({contentId}) -> { item, episodes, seasons } */
service.register('detail', function (message) {
  var id = message.payload && message.payload.contentId;
  var title = message.payload && message.payload.title;
  magis.detail(id, function (err, data) { respond(message, err, data); }, { title: title });
});

/* audioInfo({contentId, movie}) -> { audio: "por,spa,eng", subs: "es,en" }.
 * Only language codes: no playable URL, license or headers reach the page. */
service.register('audioInfo', function (message) {
  var payload = message.payload || {};
  magis.audioInfo(payload.contentId, { movie: payload.movie === true }, function (err, langs) {
    respond(message, err, { audio: (langs && langs.audio) || '', subs: (langs && langs.subs) || '' });
  });
});

service.register('mediaDuration', function (message) {
  mediaDuration.get(message.payload && message.payload.durationId, function (err, data) {
    respond(message, err, data);
  });
});

/* Subtitle files live on a CDN without CORS headers, so the page cannot read
 * them directly.  Rewrite every subtitle URL to a loopback proxy URL. */
function attachSubtitles(payload) {
  if (!payload || !payload.subtitles || !payload.subtitles.length) { return payload; }
  payload.subtitles = payload.subtitles.map(function (sub) {
    return {
      lang: sub.lang,
      format: sub.format,
      url: proxy.addSubtitle(sub.url)
    };
  });
  return payload;
}

/* resolve({contentId, seriesContentId, playbackMode, trackIndex}) */
function resolveStream(message, forceRelay) {
  var payload = message.payload || {};
  var options = { trackIndex: payload.trackIndex, preferHeight: payload.preferHeight };
  var tResolve = Date.now();
  magis.resolve(payload.contentId, payload.seriesContentId, options, function (err, stream) {
    if (err) { return fail(message, err); }
    if (!stream || !/^https?:\/\//i.test(stream.url || '')) {
      return fail(message, new Error('El portal no devolvió un enlace de vídeo válido'));
    }
    stream.duration = mediaDuration.seconds(stream.duration) || mediaDuration.seconds(payload.duration);
    stream.durationId = mediaDuration.register(stream);

    var isHevc = /hevc|h\.?265/i.test(stream.codec || '') || /hevc|h\.?265/i.test(stream.mime || '');
    /* 1.4.2 renamed the UI modes to direct/relay; accept both spellings so an
       older app build and the current one both reach the relay. */
    var useSmoothMode = forceRelay || payload.forceRelay === true || payload.forceRelay === 'true' ||
      payload.playbackMode === 'smooth' || payload.playbackMode === 'relay';
    /* When smooth mode (Modo Fluido) is requested by the user, always route via
       the on-device FFmpeg relay so the native player receives clean fragmented MP4. */
    if (useSmoothMode && !relay.available()) {
      return fail(message, new Error('Modo Fluido no disponible: no se encuentra el ejecutable de FFmpeg para Windows'));
    }

    /* Keep the proven Fluent path single-hop: FFmpeg consumes the resolved
       portal stream itself and emits fragmented MP4 on :8787.  Sending the
       same stream through proxy -> FFmpeg adds a second local HTTP consumer;
       on webOS it can leave both waiting for the other side and the player
       remains permanently at "Conectando…".  The proxy is still started for
       subtitle URLs only. */
    if (useSmoothMode) {
      /* Ajustes del Modo fluido: aceleración por hardware (por defecto sí) y
         altura máxima (0 = original, 720, 480). */
      var relayUrl = relay.register(stream, { hevc: isHevc, audio: Number(payload.audioTrack) || 0,
        hw: payload.fluidHw !== 'off', height: Number(payload.fluidHeight) || 0 });
      console.log('[xuper-service] routing stream via direct ffmpeg relay: ' + relayUrl);
      timing.log('película/serie contenido=' + payload.contentId + ' | modo fluido (FFmpeg) | enlace listo a los ' +
        (Date.now() - tResolve) + 'ms de pedirlo');
      if (timing.enabled && process.env.XUPER_PROBE_SERVERS === '1') {
        var probeSmooth = [stream.url].concat(stream.backupUrls || []);
        setTimeout(function () { proxy.probeServers(probeSmooth, stream.headers, 'contenido=' + payload.contentId); }, 25000);
      }
      stream.proxyPath = relayUrl;
      stream.mime = 'video/mp4';
      stream.isRelay = true;
      stream.isHls = false;
      proxy.start(function (perr) {
        if (perr) { return fail(message, perr); }
        // Byte access only for measuring the duration (playback stays on FFmpeg).
        var measureToken = proxy.add(stream.url, stream.headers, stream.duration, '');
        mediaDuration.attachReader(stream.durationId, proxy.rangeReader(measureToken));
        respond(message, null, attachSubtitles(stream));
      });
      return;
    }

    var streamHost = (urlmod.parse(stream.url || '').hostname) || '';
    var tDns = Date.now();
    dnsx.resolve(streamHost, function (dnsErr, dnsRes) {
      var resolvedIp = (dnsRes && dnsRes.ips && dnsRes.ips[0]) || '';
      timing.log('película/serie contenido=' + payload.contentId + ' | dns=' + (Date.now() - tDns) + 'ms' +
        (dnsErr ? ' (falló: ' + timing.safeError(dnsErr) + ')' : '') +
        ' | enlace listo para el reproductor a los ' + (Date.now() - tResolve) + 'ms de pedirlo');

      proxy.start(function (perr, port) {
        if (perr) { return fail(message, perr); }
        var token = proxy.add(stream.url, stream.headers, stream.duration, resolvedIp);
        proxy.label(token, 'película/serie contenido=' + payload.contentId, stream.mime === 'video/mp4' ? 'mp4' : 'ts');
        /* Opt-in only: the probe opens an extra CDN connection during playback,
           and this CDN resets connections when a client opens several. */
        if (timing.enabled && process.env.XUPER_PROBE_SERVERS === '1') {
          var probeList = [stream.url].concat(stream.backupUrls || []);
          setTimeout(function () { proxy.probeServers(probeList, stream.headers, 'contenido=' + payload.contentId); }, 25000);
        }
        var extension = stream.mime === 'video/mp4' ? 'mp4' : 'ts';
        if (extension === 'mp4') {
          /* MP4 in Directo: the player reads the duration from the file's own
             index.  Measuring it separately opened more CDN connections (two
             1 MB range reads, then FFmpeg) while the index was downloading;
             this CDN then cut the playback connection and left its resume
             unanswered for ~12 s (measured 12/11/2026: first picture after
             30 s or never, against ~5 s without the measurement). */
          delete stream.durationId;
        } else {
          mediaDuration.attachReader(stream.durationId, proxy.rangeReader(token));
        }
        stream.proxyPath = proxy.baseUrl() + '/media/' + token + '/stream.' + extension;
        stream.isHls = false;
        attachSubtitles(stream);
        respond(message, null, stream);
      });
    });
  });
}
service.register('resolve', function (message) { resolveStream(message, false); });
/* Separate Luna method: avoids older webOS bridges dropping custom boolean
   fields from a resolve payload. */
service.register('resolveSmooth', function (message) { resolveStream(message, true); });

/* Radio en vivo (Radio Browser): emisoras por país y aviso de escucha. */
var radio = require('./radio');
try { radio.setVersion(require('../package.json').version); } catch (eVer) { /* sin versión */ }
service.register('radioStations', function (message) {
  radio.stations(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('radioClick', function (message) {
  radio.click(message.payload || {}, function (err, data) { respond(message, err, data); });
});

/* Mis listas (M3U del usuario).  Añadir un archivo del PC no está aquí: lo
   hace el proceso principal con el diálogo de Windows (la página nunca
   envía rutas de archivos). */
var m3u = require('./m3u');
service.register('myListsIndex', function (message) {
  m3u.index(function (err, data) { respond(message, err, data); });
});
service.register('myListsAdd', function (message) {
  m3u.add(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('myListsRefresh', function (message) {
  m3u.refresh(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('myListsRemove', function (message) {
  m3u.remove(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('myListsRename', function (message) {
  m3u.rename(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('myListsChannels', function (message) {
  m3u.channels(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('myListsFavorite', function (message) {
  m3u.favorite(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('myListsSettings', function (message) {
  m3u.settings(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('myListsCheck', function (message) {
  m3u.checkStart(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('myListsCheckStatus', function (message) {
  m3u.checkStatus(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('myListsCheckStop', function (message) {
  m3u.checkStop(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('myListsEpg', function (message) {
  m3u.epgUpdate(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('myListsGuide', function (message) {
  m3u.guideNow(message.payload || {}, function (err, data) { respond(message, err, data); });
});
service.register('myListsPlay', function (message) {
  m3u.play(message.payload || {}, function (err, data) { respond(message, err, data); });
});

/* Videoteca: catálogo y reproducción de la API configurada en lamovie-api.json.
   Los enlaces temporales del servidor se resuelven dentro del servicio. */
var videoteca = require('./videoteca-api');
['home', 'browse', 'search', 'title', 'play', 'favorite', 'favorites'].forEach(function (name) {
  service.register('videoteca' + name.charAt(0).toUpperCase() + name.slice(1), function (message) {
    videoteca[name](message.payload || {}, function (err, data) { respond(message, err, data); });
  });
});

/* relayInfo() -> qué acelera el Modo fluido en este equipo (Diagnóstico). */
service.register('relayInfo', function (message) {
  if (!relay.available()) { return respond(message, null, { available: false }); }
  relay.info(function (info) {
    info.available = true;
    respond(message, null, info);
  });
});

/* mediaInfo({contentId, seriesContentId}) -> { audio, subtitles, tracks }
 * Audio languages and subtitle files for the in-player dialog.  It runs
 * before playback and returns no playable URL, license or headers. */
service.register('mediaInfo', function (message) {
  var payload = message.payload || {};
  magis.mediaInfo(payload.contentId, payload.seriesContentId, function (err, info) {
    if (err) { return fail(message, err); }
    proxy.start(function (perr) {
      if (perr) { return fail(message, perr); }
      respond(message, null, attachSubtitles(info));
    });
  });
});

service.register('liveChannels', function (message) {
  var payload = message.payload || {};
  var opts = payload.background === true ? { priority: 'background' } : null;
  magis.getLiveChannels(payload.columnId, payload.pageNum, payload.pageSize, opts, function (err, channels, hasMore) {
    if (err) { return fail(message, err); }
    respond(message, null, {
      channels: channels || [],
      pageNum: Math.max(1, parseInt(payload.pageNum, 10) || 1),
      hasMore: !!hasMore
    });
  });
});

service.register('liveCategories', function (message) {
  magis.getLiveCategories(function (err, categories) {
    if (err) { return fail(message, err); }
    respond(message, null, { categories: categories || [] });
  });
});

service.register('fetchM3u', function (message) {
  var payload = message.payload || {};
  if (!payload.url) { return fail(message, new Error('url requerida')); }
  magis.fetchM3u(payload.url, function (err, channels) {
    if (err) { return fail(message, err); }
    respond(message, null, { channels: channels || [] });
  });
});

service.register('resolveLive', function (message) {
  var payload = message.payload || {};
  if (payload.streamUrl) {
    return respond(message, null, { url: payload.streamUrl, proxyPath: payload.streamUrl, isHls: true });
  }
  if (!payload.channelCode) { return fail(message, new Error('channelCode requerido')); }
  var tLive = Date.now();
  magis.resolveLive(payload.channelCode, function (err, stream) {
    if (err) { return fail(message, err); }
    var streamHost = (urlmod.parse(stream.url || '').hostname) || '';
    var tDns = Date.now();
    dnsx.resolve(streamHost, function (dnsErr, dnsRes) {
      var resolvedIp = (dnsRes && dnsRes.ips && dnsRes.ips[0]) || '';
      timing.log('vivo canal=' + payload.channelCode + ' | dns=' + (Date.now() - tDns) + 'ms' +
        (dnsErr ? ' (falló: ' + timing.safeError(dnsErr) + ')' : '') +
        ' | enlace listo para el reproductor a los ' + (Date.now() - tLive) + 'ms de pedirlo');
      proxy.start(function (perr) {
        if (perr) { return fail(message, perr); }
        var token = proxy.add(stream.url, stream.headers, 0, resolvedIp, stream.backupUrls);
        proxy.label(token, 'vivo canal=' + payload.channelCode);
        /* Paso 7: si el CDN rechaza la licencia, el siguiente intento la renueva. */
        proxy.onReject(token, function (status) { magis.invalidateLive(payload.channelCode, status); });
        stream.proxyPath = proxy.baseUrl() + '/media/' + token + '/stream.m3u8';
        stream.isHls = true;
        respond(message, null, stream);
      });
    });
  });
});

/* abortMedia(): immediately kills all upstream sockets and buffers in proxy & relay */
service.register('abortMedia', function (message) {
  try { relay.stop(); } catch (eRelay) { /* ignore */ }
  try {
    proxy.killActiveStreams();
  } catch (eKill) { /* ignore */ }
  message.respond({ returnValue: true });
});

/* prewarm(): start the anonymous session so the first home call is fast */
service.register('prewarm', function (message) {
  magis.ensureSession(function (err) {
    if (err) { return fail(message, err); }
    message.respond({ returnValue: true, sn: magis.session.sn, userId: magis.session.userId });
  });
});

/* netdiag(): read-only report used by "Diagnóstico de red".
 * It resolves the portal/CDN hostnames with the TV resolver and with DoH,
 * then tests TCP/TLS, so a blocked DNS can be told apart from a dead server. */
service.register('netdiag', function (message) {
  var payload = message.payload || {};
  var hosts = [];
  var constants = magis.constants || {};
  if (constants.HOSTS && constants.HOSTS.length) {
    hosts = constants.HOSTS.slice(0);
  }
  /* CDN hosts seen recently are the ones that actually serve the video.  Stale
     entries would make an old, already-changed CDN look like a network fault. */
  var cached = dnsx.summary();
  for (var i = 0; i < cached.length; i++) {
    if (cached[i] && cached[i].host && cached[i].ageMs < 120000 && hosts.indexOf(cached[i].host) === -1) {
      hosts.push(cached[i].host);
    }
  }
  if (payload.hosts && payload.hosts.length) {
    hosts = payload.hosts.concat(hosts);
  }
  /* The page reports its real viewport so a cropped UI can be diagnosed from
     a photo of this screen (720p / 2K / 4K sets differ). */
  var screen = null;
  if (Number(payload.screenW) > 0 && Number(payload.screenH) > 0) {
    screen = {
      w: Number(payload.screenW),
      h: Number(payload.screenH),
      scale: Number(payload.screenScale) || 0,
      panelW: Number(payload.panelW) || 0,
      panelH: Number(payload.panelH) || 0
    };
  }
  var reportData = null;
  var layersData = null;
  var settled = false;

  function finish() {
    if (settled || !reportData || !layersData) { return; }
    settled = true;
    reportData.version = pkg.version;
    reportData.layers = layersData;
    /* Codec info forwarded from the browser page */
    reportData.codec = {
      h264: payload.codecH264 || '',
      hevc: payload.codecHEVC || '',
      hls:  payload.codecHLS  || ''
    };
    respond(message, null, reportData);
  }

  /* 1. Run DNS and host reachability check */
  netdiag.run({ hosts: hosts, screen: screen }, function (err, report) {
    reportData = (err || !report) ? { verdict: 'incompleto', hosts: [], providers: [] } : report;
    finish();
  });

  /* 2. Run session and layer check in parallel with 9s deadline */
  var layerTimer = setTimeout(function () {
    if (!layersData) {
      var s = magis.session || {};
      layersData = {
        portal:  { ok: false, error: 'tiempo agotado' },
        session: { userId: s.userId ? '✓' : '?', token: s.userToken ? '✓' : '?', ready: !!s.ready, error: 'tiempo agotado' }
      };
      finish();
    }
  }, 9000);

  magis.ensureSession(function (sessErr) {
    var sess = magis.session || {};
    var portalHost = (magis.constants && magis.constants.HOSTS && magis.constants.HOSTS[0]) || '';
    var portalUrl  = portalHost ? ('https://' + portalHost + '/api/portalCore/v8/active') : '';
    var layerOpts = {
      portalUrl:   portalUrl,
      session:     { userId: sess.userId || '', userToken: sess.userToken || '', ready: !!sess.ready, error: sessErr ? (sessErr.message || 'error') : '' },
      liveUrl:     payload.liveUrl  || '',
      liveHeaders: payload.liveHeaders || {},
      vodUrl:      payload.vodUrl   || '',
      vodHeaders:  payload.vodHeaders  || {}
    };

    netdiag.runLayers(layerOpts, function (lerr, layers) {
      clearTimeout(layerTimer);
      layersData = layers || {};
      finish();
    });
  });
});

console.log('[xuper-service] started ' + pkg.name + ' v' + pkg.version);
