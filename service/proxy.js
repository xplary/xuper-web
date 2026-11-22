/*
 * Loopback media proxy for the webOS port.
 *
 * The CDN only serves a title with two headers (Content-Auth and
 * Content-License) that an HTML5 <video> element cannot set. This tiny server
 * listens on 127.0.0.1 and replays the request with those headers, so the app
 * can use a plain URL. Range requests are forwarded verbatim.
 *
 * The tokens live in memory only and expire with the service process.
 */
'use strict';

var http = require('http');
var https = require('https');
var crypto = require('crypto');
var urlmod = require('url');
var tsIndexer = require('./ts-indexer');
var tsAudio = require('./ts-audio');
var tsSeek = require('./ts-seek');
var tsDuration = require('./ts-duration');

/* ?a=<n>: audio stream chosen for Directo (0 = first one in the file). */
function audioParam(reqUrl) {
  var m = /[?&]a=(\d{1,2})(?:&|$)/.exec(String(reqUrl || ''));
  return m ? parseInt(m[1], 10) : 0;
}
/* ?s=<n>: segment of the instant-seek list (see ts-seek.js). */
function segmentParam(reqUrl) {
  var m = /[?&]s=(\d{1,6})(?:&|$)/.exec(String(reqUrl || ''));
  return m ? parseInt(m[1], 10) : -1;
}
function rangeStart(rangeHeader) {
  var m = /bytes=(\d+)-/.exec(String(rangeHeader || ''));
  return m ? parseInt(m[1], 10) : 0;
}
var dnsx = require('./dnsx');
var timing = require('./timing');

var MAX_TOKENS = 6;
var tokens = {};      // token -> { url, headers, at }
var order = [];
/* Subtitle files are small text downloads that must not disturb the active
 * media stream, so they get their own token table and route. */
var subtitleTokens = {};
var subtitleOrder = [];
var MAX_SUBTITLES = 12;
var server = null;
var port = 0;

/* 8 sockets per host: the main connection + 3 parallel index parts + the
   duration reader must not queue behind each other (it was 4). */
var httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 15000 });
var httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 15000, rejectUnauthorized: true });

var activeToken = null;
var activeUpstreams = [];

/* Keep virtual HLS ranges on MPEG-TS packet boundaries.  The CDN already
 * supports Range and the proxy keeps its required headers private. */
var TS_PACKET_BYTES = 188;
var HLS_SEGMENT_SECONDS = 10;

function destroyConnection(c) {
  if (!c) { return; }
  /* Destroying the CDN response emits 'aborted' at once: without this mark the
     stream took its own shutdown for a CDN cut and asked the CDN to resume. */
  c.closing = true;
  if (c.up) {
    try { c.up.unpipe(); } catch (e1) { /* ignore */ }
    try { if (typeof c.up.destroy === 'function') c.up.destroy(); } catch (e2) { /* ignore */ }
    try { if (c.up.socket) c.up.socket.destroy(); } catch (e3) { /* ignore */ }
    c.up = null;
  }
  try { if (c.upstream) c.upstream.abort(); } catch (e4) { /* ignore */ }
  try { if (c.upstream && c.upstream.socket) c.upstream.socket.destroy(); } catch (e5) { /* ignore */ }
  try { if (c.res && !c.res.finished) c.res.destroy(); } catch (e6) { /* ignore */ }
  c.upstream = null;
  c.res = null;
  c.req = null;
}

/* Drop only the CDN side of a connection and keep the player's response open,
   so the same request can be retried (another CDN or the same one again).
   cleanup() would also destroy the response the retry has to write into. */
function detachUpstream(c) {
  var idx = activeUpstreams.indexOf(c);
  if (idx !== -1) { activeUpstreams.splice(idx, 1); }
  c.res = null;
  c.req = null;
  destroyConnection(c);
}

function killActiveStreams() {
  while (activeUpstreams.length > 0) {
    var c = activeUpstreams.shift();
    destroyConnection(c);
  }
}

function remember(token, entry) {
  tokens[token] = entry;
  order.push(token);
  while (order.length > MAX_TOKENS) {
    var old = order.shift();
    if (old) { delete tokens[old]; }
  }
}

function isCacheFlyIp(ip) {
  if (!ip) { return false; }
  return /^66\.225\./.test(ip) || /^205\.234\./.test(ip) || /^167\.99\./.test(ip);
}

function resolveHostIp(entry, cb) {
  if (!entry) { return cb(''); }
  if (entry.resolvedIp && dnsx.isIpv4(entry.resolvedIp)) {
    return cb(entry.resolvedIp);
  }
  var parsed = urlmod.parse(entry.url || '');
  var host = parsed.hostname;
  if (!host || dnsx.isIpv4(host)) {
    entry.resolvedIp = host || '';
    return cb(entry.resolvedIp);
  }
  var hit = dnsx.cached(host);
  if (hit && hit.ips && hit.ips.length) {
    entry.resolvedIp = dnsx.dial(host, hit.ips);
    return cb(entry.resolvedIp);
  }
  dnsx.resolve(host, function (err, res) {
    if (!err && res && res.ips && res.ips.length) {
      entry.resolvedIp = dnsx.dial(host, res.ips);
    } else {
      entry.resolvedIp = host;
    }
    cb(entry.resolvedIp);
  });
}

/* Diagnóstico de tiempos: nombre legible de cada enlace y cuántas respuestas
   del CDN se han registrado ya (solo las primeras, para no inundar el log). */
var timingLabels = {};
function label(token, text, format) {
  if (format && tokens[token]) { tokens[token].format = String(format); }
  if (!timing.enabled || !token) { return; }
  timingLabels[token] = { text: String(text || ''), logged: 0 };
}

/* Aviso único cuando el CDN rechaza (401/403) un enlace: permite renovar la
   licencia del canal en el siguiente intento. */
function onReject(token, fn) {
  var entry = tokens[token];
  if (entry && typeof fn === 'function') { entry.onReject = fn; }
}

/* Mis listas: muchas señales HLS no terminan en ".m3u8" (…/live?id=7,
   text/plain…).  Así marcadas, su lista se reescribe igual que las demás y
   no se confunden con un TS de película (lista virtual por rangos). */
function markHls(token) {
  if (tokens[token]) { tokens[token].hlsSource = true; }
}

function add(target, headers, duration, resolvedIp, backupUrls) {
  var token = crypto.randomBytes(12).toString('hex');
  var entry = {
    url: target,
    backupUrls: Array.isArray(backupUrls) ? backupUrls : [],
    backupIndex: 0,
    headers: headers || {},
    duration: Number(duration) || 0,
    contentLength: 0,
    lengthWaiters: null,
    resolvedIp: resolvedIp || '',
    at: Date.now()
  };
  remember(token, entry);

  var parsed = urlmod.parse(target || '');
  if (parsed.hostname && !dnsx.isIpv4(parsed.hostname) && !entry.resolvedIp) {
    var hit = dnsx.cached(parsed.hostname);
    if (hit && hit.ips && hit.ips.length) {
      entry.resolvedIp = dnsx.dial(parsed.hostname, hit.ips);
    }
    dnsx.resolve(parsed.hostname, function (err, res) {
      if (!err && res && res.ips && res.ips.length) {
        entry.resolvedIp = dnsx.dial(parsed.hostname, res.ips);
      }
    });
  }

  return token;
}

/* Registers a subtitle URL and returns a loopback URL the page can XHR.
 * The page cannot read the CDN directly (no Access-Control-Allow-Origin). */
function addSubtitle(target) {
  var token = crypto.randomBytes(12).toString('hex');
  subtitleTokens[token] = { url: target, at: Date.now() };
  subtitleOrder.push(token);
  while (subtitleOrder.length > MAX_SUBTITLES) {
    var old = subtitleOrder.shift();
    if (old) { delete subtitleTokens[old]; }
  }
  return baseUrl() + '/sub/' + token + '.srt';
}

function sendSubtitle(req, res, entry) {
  resolveHostIp(entry, function (ip) {
    var parsed = urlmod.parse(entry.url || '');
    var secure = parsed.protocol === 'https:';
    var host = parsed.hostname;
    var connectHost = ip || host;
    var defaultPort = secure ? 443 : 80;
    var port = parsed.port || defaultPort;
    var servername = host;
    var options = {
      hostname: connectHost,
      host: connectHost,
      servername: servername,
      rejectUnauthorized: true,
      port: port,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Ranger/4.9.4-17294ac0',
        'Accept': '*/*',
        Host: parsed.host || (host + (port !== defaultPort ? ':' + port : ''))
      },
      agent: secure ? httpsAgent : httpAgent
    };
    var failed = false;
    var upstream = (secure ? https : http).request(options, function (up) {
      var parts = [];
      up.on('data', function (chunk) { parts.push(chunk); });
      up.on('end', function () {
        if (failed) { return; }
        var body = Buffer.concat(parts);
        var ok = up.statusCode >= 200 && up.statusCode < 300;
        res.writeHead(ok ? 200 : 502, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': body.length,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'private, max-age=300'
        });
        res.end(body);
      });
    });
    upstream.setTimeout(20000, function () { try { upstream.abort(); } catch (eAbort) { /* ignore */ } });
    upstream.on('error', function () {
      if (failed) { return; }
      failed = true;
      try {
        res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('subtitle upstream error');
      } catch (e502) { /* ignore */ }
    });
    upstream.end();
  });
}

function mediaRequest(entry, method, extraHeaders, resolvedIp) {
  var parsed = urlmod.parse(entry.url || '');
  var host = parsed.hostname;
  var connectHost = resolvedIp || entry.resolvedIp;
  if (!connectHost && host) {
    var hit = dnsx.cached(host);
    if (hit && hit.ips && hit.ips.length) {
      connectHost = dnsx.dial(host, hit.ips);
      entry.resolvedIp = connectHost;
    }
  }
  if (!connectHost) {
    connectHost = host;
  }

  var secure = parsed.protocol === 'https:';

  /* In restrictive jurisdictions (e.g. Chile), carriers inspect unencrypted port 80
     Host headers to block streams. VOD CDNs on CacheFly support HTTPS on port 443,
     which encrypts the entire connection and circumvents DPI. */
  var isCacheFly = isCacheFlyIp(connectHost) || /swzablvpm|kyalbhxgw|m3x8o50te|qnrgmzpcw|faolmbghu/i.test(host || '');
  if (isCacheFly) {
    secure = true;
  }

  var headers = {};
  var k;
  for (k in entry.headers) {
    if (Object.prototype.hasOwnProperty.call(entry.headers, k)) { headers[k] = entry.headers[k]; }
  }
  for (k in extraHeaders || {}) {
    if (Object.prototype.hasOwnProperty.call(extraHeaders, k)) { headers[k] = extraHeaders[k]; }
  }

  var defaultPort = secure ? 443 : 80;
  var port = (secure && parsed.port === '80') ? 443 : (parsed.port || defaultPort);
  headers.Host = parsed.host || (host + (port !== defaultPort ? ':' + port : ''));

  var servername = host;
  if (isCacheFly) {
    servername = 'cachefly.net';
  }

  return {
    secure: secure,
    options: {
      hostname: connectHost,
      host: connectHost,
      servername: servername,
      rejectUnauthorized: true,
      port: port,
      path: parsed.path,
      method: method,
      headers: headers,
      agent: secure ? httpsAgent : httpAgent
    }
  };
}

/* Total size of the file (one tiny range request).  Retried: a single
 * ECONNRESET here (89 ms, measured 12/11/2026 - e.g. a kept-alive socket the
 * CDN had already closed) left a TS title without its seek plan, and the
 * progressive fallback took 41 s to show a picture. */
var SOURCE_LENGTH_TRIES = 3;
function sourceLength(entry, done) {
  if (entry.contentLength > 0) { return done(null, entry.contentLength); }
  if (entry.lengthWaiters) { entry.lengthWaiters.push(done); return; }
  entry.lengthWaiters = [done];
  var tries = 0;
  function settle(err, length) {
    var waiters = entry.lengthWaiters || [];
    entry.lengthWaiters = null;
    if (!err && length > 0) { entry.contentLength = length; }
    for (var i = 0; i < waiters.length; i++) { waiters[i](err, length); }
  }
  function attempt() {
    tries++;
    resolveHostIp(entry, function (ip) {
      var answered = false;
      function failed(err) {
        if (answered) { return; }
        answered = true;
        if (tries < SOURCE_LENGTH_TRIES) { return setTimeout(attempt, 250 * tries); }
        settle(err);
      }
      var requestInfo = mediaRequest(entry, 'GET', { Range: 'bytes=0-0' }, ip);
      var req = (requestInfo.secure ? https : http).request(requestInfo.options, function (up) {
        var match = /\/(\d+)$/.exec(String(up.headers['content-range'] || ''));
        var length = match ? parseInt(match[1], 10) : parseInt(up.headers['content-length'], 10);
        up.resume();
        if (!(length > 0)) { return failed(new Error('el CDN no informó el tamaño (HTTP ' + up.statusCode + ')')); }
        if (answered) { return; }
        answered = true;
        settle(null, length);
      });
      req.setTimeout(15000, function () { try { req.abort(); } catch (eAbort) {} });
      req.on('error', failed);
      req.end();
    });
  }
  attempt();
}

/* A byte range, complete.  The real CDN cuts connections after ~1 MB, which
 * left the 1 MB head/tail reads of the TS seek plan incomplete.  A cut read
 * continues from its last byte (up to RANGE_READ_RETRIES times). */
var RANGE_READ_RETRIES = 4;

/* Does this CDN answer really start at byte `from`?  A server may ignore Range
 * and answer 200 with the whole file, or answer 206 for another position: its
 * bytes must then not be used as if they were the requested ones.  A 200 is
 * only the requested data when the request started at byte 0. */
function rangeHonored(up, from) {
  if (up.statusCode === 206) {
    var m = /bytes\s+(\d+)-/i.exec(String(up.headers['content-range'] || ''));
    return !!m && parseInt(m[1], 10) === from;
  }
  return up.statusCode === 200 && from === 0;
}

/* First byte an answer really carries: the start of its Content-Range (206),
 * 0 for a whole file (200), -1 when unknown. */
function answerStart(up) {
  if (up.statusCode === 206) {
    var m = /bytes\s+(\d+)-/i.exec(String(up.headers['content-range'] || ''));
    return m ? parseInt(m[1], 10) : -1;
  }
  return up.statusCode === 200 ? 0 : -1;
}

/* A resume answered from an earlier byte (seen on live segments: the CDN
 * restarts the segment) still holds the wanted bytes after a prefix that was
 * already delivered.  That prefix is skipped when it is small; a bigger one
 * would be downloaded only to be thrown away. */
var RESUME_SKIP_MAX = Number(process.env.XUPER_RESUME_SKIP_MAX) || 8 * 1024 * 1024;

/* A CDN connection that stays open without sending anything is given up after
 * this long (only counted while the proxy is actually reading from it). */
var BODY_IDLE_MS = Number(process.env.XUPER_BODY_IDLE_MS) || 25000;

function readRange(entry, start, end, done) {
  var parts = [], got = 0, tries = 0, finished = false;
  var wanted = end - start + 1;
  function finish(err) {
    if (finished) { return; }
    finished = true;
    done(err || null, Buffer.concat(parts));
  }
  function attempt() {
    tries++;
    var from = start + got;
    resolveHostIp(entry, function (ip) {
      var info = mediaRequest(entry, 'GET', { Range: 'bytes=' + from + '-' + end }, ip);
      var settled = false;
      function next(err) {
        if (settled || finished) { return; }
        settled = true;
        if (got >= wanted) { return finish(null); }
        if (tries <= RANGE_READ_RETRIES) { return setTimeout(attempt, 150 * tries); }
        finish(err || new Error('rango incompleto (' + got + ' de ' + wanted + ' bytes)'));
      }
      var req = (info.secure ? https : http).request(info.options, function (up) {
        if (!(up.statusCode >= 200 && up.statusCode < 300)) { up.resume(); settled = true; return finish(new Error('rango rechazado (HTTP ' + up.statusCode + ')')); }
        if (!rangeHonored(up, from)) {
          // Not the requested bytes (Range ignored or another position): drop
          // the answer instead of reading a whole file that is of no use.
          settled = true;
          try { up.destroy(); } catch (eDrop) { /* ignore */ }
          return finish(new Error('el CDN no respetó el rango pedido desde el byte ' + from + ' (HTTP ' + up.statusCode + ')'));
        }
        up.on('data', function (c) {
          if (finished) { return; }
          var room = wanted - got;
          if (c.length > room) { c = c.subarray(0, room); }
          if (c.length) { parts.push(c); got += c.length; }
        });
        up.on('end', function () { next(null); });
        up.on('aborted', function () { next(new Error('cortada')); });
        up.on('error', function (e) { next(e); });
        up.on('close', function () { next(new Error('cerrada')); });
      });
      req.setTimeout(25000, function () { try { req.abort(); } catch (eAbort) {} });
      req.on('error', function (err) { next(err); });
      req.end();
    });
  }
  attempt();
}

/* Instant-seek plan: file size + duration from the first and last video
 * timestamps.  Calls back with null when the file does not allow it (other
 * codec, no timestamps...); the progressive indexer is used then. */
function seekPlan(entry, done) {
  if (entry.seekPlan !== undefined) { return done(entry.seekPlan); }
  if (entry.seekPlanWaiters) { entry.seekPlanWaiters.push(done); return; }
  entry.seekPlanWaiters = [done];
  var tPlan = Date.now();
  function settle(planned, reason) {
    entry.seekPlan = planned;
    entry.seekPlanReason = reason || '';
    if (!planned && (seekLog() || timing.enabled)) {
      console.log('[salto] sin plan de saltos tras ' + (Date.now() - tPlan) + ' ms: ' + (reason || 'motivo desconocido'));
    }
    var waiters = entry.seekPlanWaiters || [];
    entry.seekPlanWaiters = null;
    for (var i = 0; i < waiters.length; i++) { waiters[i](planned); }
  }
  function step(name) { if (seekLog()) { console.log('[salto] plan: ' + name + ' a los ' + (Date.now() - tPlan) + ' ms'); } }
  function buildPlan(length, duration, video, pts0) {
    var segments = tsSeek.plan(length, duration);
    var total = 0;
    for (var s = 0; s < segments.length; s++) { total += segments[s].duration; }
    var planned = { length: length, duration: duration, pid: video.pid, type: video.type,
      segments: segments, pts0: pts0, cuts: {}, anchors: [[0, 0], [length, total]] };
    settle(planned);
    buildTimeMap(entry, planned);
  }
  sourceLength(entry, function (err, length) {
    if (err) { return settle(null, 'no se obtuvo el tamaño (' + timing.safeError(err) + ')'); }
    if (!(length > TS_PACKET_BYTES * 20000)) { return settle(null, 'tamaño demasiado pequeño (' + length + ')'); }
    step('tamaño ' + length + ' bytes');
    /* Experimental fast path (XUPER_FAST_TS_PLAN=1 only): plan from the
       portal's duration without reading the tail.  Measured 12/11/2026 with
       Spider-Man, 2 runs each: the list was ready 1.5 s sooner, but the first
       picture came at ~10.5 s instead of ~5.7 s (fragLoadError/
       fragParsingError on the first segment), because the portal duration
       does not match the stream timestamps exactly.  Off by default. */
    if (entry.duration > 30 && process.env.XUPER_FAST_TS_PLAN === '1') {
      return readRange(entry, 0, Math.min(length, PLAN_HEAD_BYTES) - 1, function (eh, head) {
        if (eh || !head) { return settle(null, 'falló la lectura del principio (' + timing.safeError(eh) + ')'); }
        var video = tsDuration.videoInfo(head);
        var pts0 = video.pid >= 0 ? tsDuration.startPts(head, video.pid) : null;
        if (video.pid < 0 || !tsSeek.supported(video.type) || head[0] !== 0x47 || pts0 === null) {
          return settle(null, 'el principio no permite el plan rápido (pista ' + video.pid + ', tipo 0x' +
            (video.type >= 0 ? video.type.toString(16) : '?') + ')');
        }
        step('plan rápido con la duración del portal (' + Math.round(entry.duration) + ' s, principio ' + head.length + ' bytes)');
        buildPlan(length, entry.duration, video, pts0);
      });
    }
    readRange(entry, 0, Math.min(length, tsDuration.HEAD_BYTES) - 1, function (e1, head) {
      if (e1 || !head) { return settle(null, 'falló la lectura del principio (' + timing.safeError(e1) + ')'); }
      step('principio leído (' + head.length + ' bytes)');
      var video = tsDuration.videoInfo(head);
      if (video.pid < 0) { return settle(null, 'no se encontró la pista de vídeo en el principio'); }
      if (!tsSeek.supported(video.type)) { return settle(null, 'tipo de vídeo no admitido (0x' + video.type.toString(16) + ')'); }
      if (head[0] !== 0x47) { return settle(null, 'el principio no empieza con un paquete TS'); }
      var tailStart = Math.max(0, length - tsDuration.TAIL_BYTES);
      readRange(entry, tailStart, length - 1, function (e2, tail) {
        if (e2 || !tail) { step('falló la lectura del final (' + timing.safeError(e2) + ')'); } else { step('final leído (' + tail.length + ' bytes)'); }
        var duration = !e2 && tail ? tsDuration.fromBuffers(head, tail) : 0;
        if (!duration) { duration = entry.duration > 30 ? entry.duration : 0; }
        if (!duration) { return settle(null, 'no se pudo calcular la duración (final ' + (e2 ? 'no leído' : 'sin marcas de tiempo') + ', duración del portal ' + (entry.duration || 0) + ' s)'); }
        var pts0 = tsDuration.startPts(head, video.pid);
        if (pts0 === null) { return settle(null, 'sin marca de tiempo inicial del vídeo'); }
        var segments = tsSeek.plan(length, duration);
        var total = 0;
        for (var s = 0; s < segments.length; s++) { total += segments[s].duration; }
        var planned = { length: length, duration: duration, pid: video.pid, type: video.type,
          segments: segments, pts0: pts0, cuts: {}, anchors: [[0, 0], [length, total]] };
        settle(planned);
        buildTimeMap(entry, planned);
      });
    });
  });
}

/* ---- Byte -> second map ------------------------------------------------
   A video does not weigh the same every second: spreading the segments by
   bytes made a jump land 30-70 s before the requested second and hls.js had
   to fetch 3-4 segments.  The map (planned.anchors, sorted by byte) starts
   with 40 small samples spread over the title and learns one more point with
   every jump. */
/* Head bytes read for the fast TS seek plan (PAT/PMT + first video PTS). */
var PLAN_HEAD_BYTES = TS_PACKET_BYTES * 2800;   // ~512 KB
/* One map read at a time: the real CDN resets connections when the same
   client opens several at once (measured 12/11/2026). */
var MAP_SAMPLES = 40, MAP_PARALLEL = 1, MAP_BYTES = 64 * 1024;
var START_EARLY_S = 4;     /* aim this much before the segment start */
var START_MIN_S = 9;       /* accepted: first picture 9 s ... 1 s before it */
var START_MAX_S = 1;
var PROBE_LIMIT = 512 * 1024;
var MAX_AIM_TRIES = 4;
function seekLog() { return process.env.XUPER_SEEK_LOG === '1'; }

function estimateByte(anchors, t, length) {
  if (anchors.length < 2) { return 0; }
  var lo = anchors[0], hi = anchors[anchors.length - 1];
  for (var i = 0; i + 1 < anchors.length; i++) {
    if (anchors[i][1] <= t && t <= anchors[i + 1][1]) { lo = anchors[i]; hi = anchors[i + 1]; break; }
  }
  var span = hi[1] - lo[1];
  var at = span > 0.001 ? lo[0] + (t - lo[1]) / span * (hi[0] - lo[0]) : lo[0];
  at = Math.max(0, Math.min(length - TS_PACKET_BYTES, at));
  return Math.floor(at / TS_PACKET_BYTES) * TS_PACKET_BYTES;
}

function addAnchor(anchors, byte, secs) {
  var i = 0;
  while (i < anchors.length && anchors[i][0] < byte) { i++; }
  if (i < anchors.length && anchors[i][0] === byte) { return; }
  var beforeOk = i === 0 || anchors[i - 1][1] < secs;
  var afterOk = i >= anchors.length || anchors[i][1] > secs;
  if (beforeOk && afterOk) { anchors.splice(i, 0, [byte, secs]); }
}

function buildTimeMap(entry, planned) {
  var t0 = Date.now(), next = 1, running = 0, got = 0;
  function pump() {
    while (running < MAP_PARALLEL && next < MAP_SAMPLES) {
      if (entry.seekPlan !== planned) { return; }
      var at = Math.floor(planned.length / MAP_SAMPLES * next / TS_PACKET_BYTES) * TS_PACKET_BYTES;
      next++; running++;
      (function (at) {
        readRange(entry, at, at + MAP_BYTES - 1, function (err, buf) {
          running--;
          var hit = !err && buf ? tsDuration.firstVideoPts(buf, planned.pid) : null;
          if (hit) { addAnchor(planned.anchors, at + hit.pos, tsDuration.secondsSince(hit.pts, planned.pts0)); got++; }
          if (next >= MAP_SAMPLES && running === 0) {
            if (seekLog()) { console.log('[salto] mapa listo: ' + got + ' muestras en ' + (Date.now() - t0) + ' ms'); }
            return;
          }
          pump();
        });
      })(at);
    }
  }
  pump();
}

function sendVirtualHls(req, res, token, entry) {
  if (entry.seekPlan === undefined && process.env.XUPER_PROGRESSIVE_INDEX !== '1') {
    var tPlan = Date.now();
    return seekPlan(entry, function () {
      if (timing.enabled && timingLabels[token] && !entry.planLogged) {
        entry.planLogged = true;
        timing.log('cdn ' + timingLabels[token].text + ' | TS: lista HLS virtual lista en ' + (Date.now() - tPlan) + 'ms' +
          (entry.seekPlan ? ' (' + entry.seekPlan.segments.length + ' tramos, saltos inmediatos)' : ' (sin plan: índice progresivo)'));
      }
      sendVirtualHls(req, res, token, entry);
    });
  }
  if (entry.seekPlan) { return sendPlannedHls(req, res, entry.seekPlan); }
  sourceLength(entry, function (err, length) {
    if (err) {
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('no se pudo crear el manifiesto HLS');
      return;
    }
    if (!entry.indexer) { entry.indexer = tsIndexer.create(length, function (start, end, cb) { readRange(entry, start, end, cb); }); entry.indexer.start(); }
    var indexer = entry.indexer;
    if (!indexer.segments.length && !indexer.complete) { indexer.when(function () { sendVirtualHls(req, res, token, entry); }); return; }
    var audio = audioParam(req.url);
    var lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:4',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-TARGETDURATION:' + HLS_SEGMENT_SECONDS,
      '#EXT-X-MEDIA-SEQUENCE:0'
    ];
    for (var i = 0; i < indexer.segments.length; i++) {
      var segment = indexer.segments[i];
      lines.push('#EXTINF:' + segment.duration.toFixed(3) + ',');
      lines.push('#EXT-X-BYTERANGE:' + (segment.end - segment.start + 1) + '@' + segment.start);
      lines.push(audio > 0 ? 'stream.ts?a=' + audio : 'stream.ts');
    }
    if (indexer.complete) { lines.push('#EXT-X-ENDLIST'); }
    var body = lines.join('\n') + '\n';
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  });
}

/* The whole list at once: every part of the title can be reached at start. */
function sendPlannedHls(req, res, planned) {
  var audio = audioParam(req.url);
  var lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:' + Math.ceil(tsSeek.SEGMENT_SECONDS * 2.5),
    '#EXT-X-MEDIA-SEQUENCE:0'
  ];
  for (var i = 0; i < planned.segments.length; i++) {
    lines.push('#EXTINF:' + planned.segments[i].duration.toFixed(3) + ',');
    lines.push('stream.ts?s=' + i + (audio > 0 ? '&a=' + audio : ''));
  }
  lines.push('#EXT-X-ENDLIST');
  var body = lines.join('\n') + '\n';
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* One segment of the planned list, cut on keyframes while it downloads.
   After a jump (segment not known yet) the real second at the chosen byte is
   checked; if it is off, the byte is recomputed with the map and asked again,
   so the segment holds the second hls.js expects. */
function forwardSegment(req, res, entry, token, index) {
  var planned = entry.seekPlan;
  var seg = planned.segments[index];
  if (!seg) {
    res.writeHead(416, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('segmento fuera de rango');
    return;
  }
  if (activeToken !== token) { killActiveStreams(); activeToken = token; }
  var hasNext = index + 1 < planned.segments.length;
  var segT = 0;
  for (var k = 0; k < index; k++) { segT += planned.segments[k].duration; }
  var nextT = segT + seg.duration;
  var known = index === 0 ? 0 : planned.cuts[index];
  var knownEnd = planned.cuts[index + 1];
  var exact = known !== undefined;
  var aim = Math.max(0, segT - START_EARLY_S);
  var begin = exact ? known : estimateByte(planned.anchors, aim, planned.length);
  var t0 = Date.now(), tries = 0;
  var connRecord = { upstream: null, res: res, req: req, up: null };
  activeUpstreams.push(connRecord);
  var cleaned = false;
  function cleanup() {
    if (cleaned) { return; }
    cleaned = true;
    var idx = activeUpstreams.indexOf(connRecord);
    if (idx !== -1) { activeUpstreams.splice(idx, 1); }
    destroyConnection(connRecord);
  }
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);
  function fail(text) {
    try {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(text);
      } else { res.end(); }
    } catch (eErr) { cleanup(); }
  }

  function attempt() {
    tries++;
    var upper = !hasNext ? -1 : (knownEnd !== undefined ? knownEnd : estimateByte(planned.anchors, nextT, planned.length));
    /* A start past this segment's estimated end (long GOP): the segment then
       runs to the keyframe after that start. */
    if (upper >= 0 && begin >= upper) { upper = begin + TS_PACKET_BYTES; }
    var last = upper < 0 ? planned.length - 1 : Math.min(planned.length - 1, upper + tsSeek.LOOKAHEAD_BYTES);
    resolveHostIp(entry, function (ip) {
      if (cleaned || res.finished) { return; }
      var info = mediaRequest(entry, 'GET', { Range: 'bytes=' + begin + '-' + last }, ip);
      var upstream = (info.secure ? https : http).request(info.options, function (up) {
        connRecord.up = up;
        upstream.setTimeout(0);
        if (!(up.statusCode >= 200 && up.statusCode < 300)) { up.resume(); fail('segmento rechazado'); return; }
        if (!rangeHonored(up, begin)) {
          // The CDN answered with other bytes than the ones of this segment.
          try { up.destroy(); } catch (eDrop) { /* ignore */ }
          fail('el CDN no respetó el rango del segmento');
          return;
        }
        if (exact || tries > MAX_AIM_TRIES) { return deliver(up, upper, null); }
        /* Read up to the first picture to learn which second is here. */
        var parts = [], size = 0, decided = false;
        function decide(hit) {
          if (decided) { return; }
          decided = true;
          up.removeListener('data', onData);
          up.removeListener('end', onEnd);
          up.pause();
          var prefix = Buffer.concat(parts);
          if (!hit) { return deliver(up, upper, prefix); }
          var secs = tsDuration.secondsSince(hit.pts, planned.pts0);
          addAnchor(planned.anchors, begin + hit.pos, secs);
          var err = secs - segT;
          if (seekLog()) {
            console.log('[salto] tramo ' + index + ' intento ' + tries + ': pedido ' + segT.toFixed(1) + 's, en el byte hay ' +
              secs.toFixed(1) + 's (' + (err >= 0 ? '+' : '') + err.toFixed(1) + 's) a los ' + (Date.now() - t0) + ' ms, mapa ' + planned.anchors.length + ' puntos');
          }
          if (err <= -START_MAX_S && err >= -START_MIN_S) { return deliver(up, upper, prefix); }
          var again = estimateByte(planned.anchors, aim, planned.length);
          if (again === begin) { return deliver(up, upper, prefix); }
          try { up.destroy(); } catch (eStop) { /* ignore */ }
          begin = again;
          attempt();
        }
        function onData(c) {
          parts.push(c); size += c.length;
          var hit = tsDuration.firstVideoPts(Buffer.concat(parts), planned.pid);
          if (hit || size >= PROBE_LIMIT) { decide(hit); }
        }
        function onEnd() { decide(null); }
        up.on('data', onData);
        up.on('end', onEnd);
      });
      connRecord.upstream = upstream;
      upstream.setTimeout(25000, function () { try { upstream.abort(); } catch (eAbort) { /* ignore */ } });
      upstream.on('error', function () { fail('segmento no disponible'); });
      upstream.end();
    });
  }

  function deliver(up, upper, prefix) {
    if (cleaned) { try { up.destroy(); } catch (e0) { /* ignore */ } return; }
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'private, max-age=120',
      'Connection': 'keep-alive'
    });
    var cutter = tsSeek.createCutter({
      begin: begin, lower: begin, exact: exact,
      upper: upper, pid: planned.pid, type: planned.type,
      onStart: function (at) { if (planned.cuts[index] === undefined) { planned.cuts[index] = at; } },
      onCut: function (cut) {
        if (hasNext && planned.cuts[index + 1] === undefined) { planned.cuts[index + 1] = cut; }
        if (seekLog()) { console.log('[salto] tramo ' + index + ' ' + (exact ? 'seguido' : 'tras salto') + ' listo en ' + (Date.now() - t0) + ' ms (' + tries + ' intentos)'); }
        /* Stop downloading as soon as the segment is complete. */
        setImmediate(function () {
          try { up.unpipe(cutter); } catch (eUnpipe) { /* ignore */ }
          try { up.destroy(); } catch (eStop) { /* ignore */ }
          try { cutter.end(); } catch (eEnd) { /* ignore */ }
        });
      }
    });
    up.on('error', function () { try { cutter.end(); } catch (eEnd) { cleanup(); } });
    var audioIndex = audioParam(req.url);
    if (audioIndex > 0) {
      if (!entry.tsAudioState) { entry.tsAudioState = {}; }
      cutter.pipe(tsAudio.createRewriter(audioIndex, begin, entry.tsAudioState)).pipe(res);
    } else {
      cutter.pipe(res);
    }
    if (prefix && prefix.length) { cutter.write(prefix); }
    up.pipe(cutter);
  }

  attempt();
}

/* Modern webOS HLS players strictly resolve a playlist's relative segment,
 * key and nested-playlist URLs against the loopback manifest URL.  Those
 * child requests must keep the portal's authorization headers too.  Rewrite
 * every URI to an opaque local route and proxy it with the parent token. */
function base64Url(value) {
  return new Buffer(String(value), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  var raw = String(value).replace(/-/g, '+').replace(/_/g, '/');
  while (raw.length % 4) { raw += '='; }
  return new Buffer(raw, 'base64').toString('utf8');
}

var manifestSecret = crypto.randomBytes(32);
function manifestSignature(token, encoded) {
  return crypto.createHmac('sha256', manifestSecret).update(token + '/' + encoded).digest('hex');
}
function hlsChildUrl(token, manifestUrl, reference) {
  if (!reference || reference.indexOf('data:') === 0) { return reference; }
  var encoded = base64Url(urlmod.resolve(manifestUrl, reference));
  return baseUrl() + '/hls/' + token + '/' + encoded + '?sig=' + manifestSignature(token, encoded);
}

/* Algunos canales en vivo numeran mal su lista: al recargarla, el contador
   (#EXT-X-MEDIA-SEQUENCE) salta 2 mientras los trozos solo avanzan 1.
   hls.js 1.7 lo trata como error fatal ("media sequence mismatch") y la
   imagen se congela a los ~30 s. Se recuerda qu\u00E9 n\u00FAmero tuvo cada trozo y el
   contador se recalcula a partir de los ya conocidos. */
var liveSeqStates = {};
var liveSeqKeys = [];
function segmentKey(uri) { return String(uri).split('?')[0]; }
function fixLiveSequence(lines, key) {
  var seqAt = -1, seq = 0, uris = [], isLive = true;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) { continue; }
    if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) { seqAt = i; seq = parseInt(line.slice(22), 10) || 0; }
    else if (line.indexOf('#EXT-X-ENDLIST') === 0) { isLive = false; }
    else if (line.indexOf('#EXT-X-PLAYLIST-TYPE:VOD') === 0) { isLive = false; }
    else if (line.indexOf('#EXT-X-DISCONTINUITY') === 0) { /* fine: own sequence */ }
    else if (line.charAt(0) !== '#') { uris.push(segmentKey(line)); }
  }
  if (!isLive || seqAt < 0 || !uris.length) { return; }
  var st = liveSeqStates[key];
  if (!st) {
    st = liveSeqStates[key] = { map: {}, order: [], max: -1 };
    liveSeqKeys.push(key);
    while (liveSeqKeys.length > 40) { delete liveSeqStates[liveSeqKeys.shift()]; }
  }
  var start = seq;
  var known = false;
  for (var k = 0; k < uris.length; k++) {
    if (st.map[uris[k]] !== undefined) { start = st.map[uris[k]] - k; known = true; break; }
  }
  /* Sin trozos en com\u00FAn (salto grande): seguir despu\u00E9s del \u00FAltimo n\u00FAmero dado. */
  if (!known && st.max >= 0 && start <= st.max) { start = st.max + 1; }
  for (var n = 0; n < uris.length; n++) {
    if (st.map[uris[n]] === undefined) { st.order.push(uris[n]); }
    st.map[uris[n]] = start + n;
    if (start + n > st.max) { st.max = start + n; }
  }
  while (st.order.length > 300) { delete st.map[st.order.shift()]; }
  if (start !== seq) { lines[seqAt] = '#EXT-X-MEDIA-SEQUENCE:' + start; }
}

function rewriteHlsManifest(body, token, manifestUrl) {
  var lines = String(body || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  try { fixLiveSequence(lines, token + '|' + segmentKey(manifestUrl)); } catch (eSeq) { /* keep the original */ }
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) { continue; }
    if (line.charAt(0) !== '#') {
      lines[i] = hlsChildUrl(token, manifestUrl, line);
    } else if (line.indexOf('URI=') !== -1) {
      lines[i] = line.replace(/URI=("|')([^"']+)\1/g, function (all, quote, reference) {
        return 'URI=' + quote + hlsChildUrl(token, manifestUrl, reference) + quote;
      });
    }
  }
  return lines.join('\n');
}

/* El CDN de vídeo corta descargas largas a los pocos MB.  Antes el proxy
 * terminaba la respuesta incompleta y el reproductor tardaba en pedir el resto
 * (primera imagen ~20 s).  Ahora, si la conexión se corta antes de entregar
 * Content-Length bytes, se pide al CDN el resto (Range desde el último byte)
 * y se sigue escribiendo en la MISMA respuesta: el reproductor no nota el corte.
 * Como mucho MAX_RESUMES cortes SEGUIDOS sin progreso: el contador vuelve a
 * cero cuando una conexión reanudada entrega al menos RESUME_PROGRESS bytes, así
 * una película larga con cortes cada pocos MB se sigue reanudando. */
var MAX_RESUMES = 4;
var RESUME_PROGRESS = 1024 * 1024;
var RESUME_ANSWER_MS = Number(process.env.XUPER_RESUME_ANSWER_MS) || 6000;

/* Índice MP4 grande (medido: moov de 13,3 MB a ~8,7 Mbit/s = 12,8 s antes de
 * la primera imagen, con una línea de 38 Mbit/s).  El CDN limita la velocidad
 * POR CONEXIÓN, así que el proxy pide el resto del índice en PARALLEL_PARTS
 * trozos a la vez y los entrega al reproductor en orden. */
var PARALLEL_MIN_INDEX = 2 * 1024 * 1024;
var PARALLEL_PARTS = 3;
var PARALLEL_MAIN_HEAD = 512 * 1024;   // la conexión principal sigue con el primer tramo
var SEG_MAX_RETRIES = 4;

/* Memoria del índice: los bytes iniciales (hasta el final del moov) de los
 * últimos HEAD_CACHE_MAX títulos.  Reintentar, cambiar de audio o volver a
 * abrir el mismo título ya no vuelve a descargar 13 MB antes de la imagen. */
var HEAD_CACHE_MAX = 2;
var HEAD_CACHE_MAX_BYTES = 32 * 1024 * 1024;
var HEAD_CACHE_TTL_MS = 10 * 60 * 1000;
var headCache = [];
function headCacheKey(url) { return String(url || '').split('?')[0]; }
function headCacheGet(url) {
  var key = headCacheKey(url);
  for (var i = 0; i < headCache.length; i++) {
    if (headCache[i].key === key) {
      if (Date.now() - headCache[i].at > HEAD_CACHE_TTL_MS) { headCache.splice(i, 1); return null; }
      return headCache[i];
    }
  }
  return null;
}
function headCachePut(url, total, buf) {
  if (!url || !total || !buf || buf.length > HEAD_CACHE_MAX_BYTES) { return; }
  var key = headCacheKey(url);
  headCache = headCache.filter(function (c) { return c.key !== key; });
  headCache.push({ key: key, total: total, buf: buf, at: Date.now() });
  while (headCache.length > HEAD_CACHE_MAX) { headCache.shift(); }
}

/* up: first CDN response, or null when the start comes from the head cache
 * (then `pre` = { expected, base, cached: Buffer already written }). */
function pipeResumable(up, res, req, entry, ip, connRecord, token, cleanup, pre) {
  var expected, status, base = 0, total = 0, contentType;
  if (up) {
    expected = Number(up.headers['content-length']) || 0;
    status = up.statusCode || 200;
    var cr = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(String(up.headers['content-range'] || ''));
    if (status === 206 && cr) { base = parseInt(cr[1], 10); total = parseInt(cr[3], 10); }
    if (status === 200) { total = expected; }
    contentType = String(up.headers['content-type'] || '');
  } else {
    expected = pre.expected; status = 206; base = pre.base; total = pre.total; contentType = 'video/mp4';
  }
  var canResume = expected > 0 && (status === 200 || (status === 206 && total > 0)) && req.method !== 'HEAD';
  var label = timing.enabled && timingLabels[token] ? timingLabels[token].text : '';
  var sent = 0, resumes = 0, totalResumes = 0, sentAtResume = 0, current = null, done = false, tStart = Date.now();
  var parallel = null;
  var capture = null;   // head bytes being collected for the cache

  /* Top-level MP4 box headers (type, size, offset) are read as bytes pass by:
     needed to know where the index ends.  Nothing of the media is logged. */
  var isMp4 = /mp4/i.test(contentType) || /\.mp4(\?|$)/i.test(entry.url || '');
  var boxScan = (up && base === 0 && isMp4) ? { next: 0, hdr: Buffer.alloc(0), found: [], moovEnd: 0, moovLogged: false, done: false } : null;
  function mb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'; }
  function reportBoxes() {
    if (!label) { return; }
    var parts = boxScan.found.map(function (b) { return b.type + ' ' + mb(b.size) + ' en ' + mb(b.start); });
    var moovFirst = boxScan.found.some(function (b) { return b.type === 'moov'; });
    timing.log('cdn ' + label + ' | estructura MP4: ' + parts.join(' · ') +
      (moovFirst ? ' | índice (moov) al principio' : ' | índice (moov) NO está antes del vídeo: el reproductor debe ir a buscarlo al final'));
  }
  function onMoovFound(moovEnd) {
    boxScan.moovEnd = moovEnd;
    if (moovEnd <= HEAD_CACHE_MAX_BYTES && total > 0) { capture = { end: moovEnd, parts: [], size: 0 }; }
    planParallel(moovEnd);
  }
  function scanBoxes(chunk, pos) {
    var s = boxScan, end = pos + chunk.length;
    while (!s.done) {
      var have = s.hdr.length;
      var at = s.next + have;
      if (at >= end) { return; }
      if (at < pos) { s.done = true; return; }
      var take = Math.min(16 - have, end - at);
      s.hdr = Buffer.concat([s.hdr, chunk.subarray(at - pos, at - pos + take)]);
      if (s.hdr.length < 8) { return; }
      var size = s.hdr.readUInt32BE(0);
      var type = s.hdr.toString('latin1', 4, 8);
      if (size === 1) {
        if (s.hdr.length < 16) { return; }
        size = Number(s.hdr.readBigUInt64BE(8));
      }
      if (!/^[\x20-\x7e]{4}$/.test(type) || (size !== 0 && size < 8)) { s.done = true; reportBoxes(); return; }
      s.found.push({ type: type, start: s.next, size: size || (expected - s.next) });
      s.hdr = Buffer.alloc(0);
      if (type === 'moov') { onMoovFound(s.next + size); }
      if (type === 'mdat' || size === 0 || s.found.length >= 8) { s.done = true; reportBoxes(); return; }
      s.next += size;
    }
  }

  /* Every byte for the player goes through here, in file order. */
  function emit(buf) {
    if (!buf.length) { return true; }
    sent += buf.length;
    if (capture) {
      var keep = Math.min(buf.length, capture.end - (base + sent - buf.length));
      if (keep > 0) { capture.parts.push(keep === buf.length ? buf : buf.subarray(0, keep)); capture.size += keep; }
      if (base + sent >= capture.end) {
        if (capture.size === capture.end) { headCachePut(entry.url, total, Buffer.concat(capture.parts)); }
        capture = null;
      }
    }
    if (boxScan && boxScan.moovEnd && !boxScan.moovLogged && base + sent >= boxScan.moovEnd) {
      boxScan.moovLogged = true;
      if (label) {
        var ms = Date.now() - tStart;
        timing.log('cdn ' + label + ' | índice (moov) completo a los ' + ms + 'ms (' + mb(boxScan.moovEnd) +
          ', ~' + (ms > 0 ? (sent * 8 / ms / 1000).toFixed(1) : '?') + ' Mbit/s' + (parallel ? ', en paralelo' : '') + ')');
      }
    }
    return res.write(buf);
  }

  function finish() {
    if (done) { return; }
    done = true;
    connRecord.resumeOnCut = null;
    if (parallel) { abortSegments(); }
    try { if (!res.writableEnded) { res.end(); } } catch (eEnd) { /* ignore */ }
    cleanup();
  }
  res.once('close', function () { if (!done) { finish(); } });

  /* ---- parallel index download ---- */
  function planParallel(moovEnd) {
    /* Off by default: with the real CDN, extra simultaneous connections made it
       reset the main one (measured 12/11/2026).  Kept only for experiments. */
    if (process.env.XUPER_PARALLEL_INDEX !== '1') { return; }
    if (parallel || !canResume || base !== 0 || moovEnd > base + expected) { return; }
    var limit = Math.min(moovEnd, Math.max(sent, PARALLEL_MAIN_HEAD));
    if (moovEnd - limit < PARALLEL_MIN_INDEX) { return; }
    var span = moovEnd - limit;
    var part = Math.ceil(span / PARALLEL_PARTS);
    parallel = { limit: limit, segs: [], idx: 0, mainDone: false, t0: Date.now(), reqs: [] };
    for (var i = 0; i < PARALLEL_PARTS; i++) {
      var from = limit + i * part;
      var to = Math.min(moovEnd, from + part) - 1;
      if (from > to) { break; }
      parallel.segs.push({ from: from, to: to, pos: from, chunks: [], complete: false, failed: false, retries: 0 });
    }
    if (label) {
      timing.log('cdn ' + label + ' | índice de ' + mb(moovEnd) + ': se descarga en paralelo (' +
        parallel.segs.length + ' trozos + la conexión principal hasta ' + mb(limit) + ')');
    }
    parallel.segs.forEach(startSegment);
  }

  function abortSegments() {
    parallel.reqs.forEach(function (r) { try { r.abort(); } catch (eA) { /* ignore */ } });
    parallel.reqs = [];
  }

  function startSegment(seg) {
    if (done || !parallel || parallel.finished) { return; }
    var gotResponse = false;
    var from = seg.pos;
    var info = mediaRequest(entry, 'GET', { Range: 'bytes=' + from + '-' + seg.to }, ip);
    var r = (info.secure ? https : http).request(info.options, function (u) {
      gotResponse = true;
      if (done || parallel.finished) { u.resume(); return; }
      if (u.statusCode !== 206) { u.resume(); return retrySegment(seg, 'HTTP ' + u.statusCode); }
      if (!rangeHonored(u, from)) {
        try { u.destroy(); } catch (eDrop) { /* ignore */ }
        return retrySegment(seg, 'rango no respetado');
      }
      /* The request timeout stays armed: these parts are read without pauses,
         so a silent socket means the server stopped sending.  It then aborts
         the request and the part is retried from its last byte. */
      r.setTimeout(BODY_IDLE_MS, function () { try { r.abort(); } catch (eIdle) { /* ignore */ } });
      var ended = false;
      function end(why) {
        if (ended) { return; }
        ended = true;
        if (seg.pos > seg.to) { seg.complete = true; flushParallel(); } else { retrySegment(seg, why); }
      }
      u.on('data', function (c) {
        if (done || parallel.finished || ended) { return; }
        var room = seg.to + 1 - seg.pos;
        if (c.length > room) { c = c.subarray(0, room); }
        seg.chunks.push(c);
        seg.pos += c.length;
        flushParallel();
      });
      u.on('end', function () { end('fin'); });
      u.on('aborted', function () { end('cortada'); });
      u.on('error', function (e) { end(timing.safeError(e)); });
      u.on('close', function () { end('cerrada'); });
    });
    parallel.reqs.push(r);
    r.setTimeout(20000, function () { try { r.abort(); } catch (eT) { /* ignore */ } });
    r.on('error', function (e) { if (!gotResponse) { retrySegment(seg, timing.safeError(e)); } });
    r.end();
  }

  function retrySegment(seg, why) {
    if (done || !parallel || parallel.finished || seg.complete) { return; }
    seg.retries++;
    if (seg.retries > SEG_MAX_RETRIES) { seg.failed = true; return flushParallel(); }
    setTimeout(function () { startSegment(seg); }, 200 * seg.retries);
  }

  function flushParallel() {
    if (done || !parallel || !parallel.mainDone || parallel.finished) { return; }
    while (parallel.idx < parallel.segs.length) {
      var seg = parallel.segs[parallel.idx];
      if (base + sent !== seg.from + (seg.pos - seg.from) - seg.chunks.reduce(function (n, c) { return n + c.length; }, 0)) {
        return endParallel('desajuste de posición');
      }
      while (seg.chunks.length) { emit(seg.chunks.shift()); }
      if (seg.complete) { parallel.idx++; continue; }
      if (seg.failed) { return endParallel('un trozo no se pudo descargar'); }
      return;   // waiting for more data of this part
    }
    endParallel(null);
  }

  /* Leave the parallel phase and continue with one sequential connection. */
  function endParallel(problem) {
    if (parallel.finished) { return; }
    parallel.finished = true;
    abortSegments();
    if (label) {
      timing.log('cdn ' + label + ' | ' + (problem ? 'descarga en paralelo abandonada (' + problem + '); sigue en una conexión' :
        'índice descargado en paralelo en ' + (Date.now() - parallel.t0) + 'ms; sigue el vídeo en una conexión'));
    }
    if (sent >= expected) { return finish(); }
    requestFrom(base + sent, null);
  }

  function attach(stream, skip) {
    skip = skip || 0;
    current = stream;
    connRecord.up = stream;
    /* Body inactivity limit.  Counted only while the proxy is reading: when the
       player stops taking data (pause, full buffer) the stream is paused and a
       silent socket is then normal. */
    var idle = null;
    function unwatch() { if (idle) { clearTimeout(idle); idle = null; } }
    function watch() {
      unwatch();
      idle = setTimeout(function () {
        idle = null;
        if (stream !== current || done) { return; }
        try { stream.destroy(); } catch (eIdle) { /* ignore */ }
        cut('sin datos durante ' + Math.round(BODY_IDLE_MS / 1000) + ' s');
      }, BODY_IDLE_MS);
      if (idle.unref) { idle.unref(); }
    }
    function cut(why) {
      unwatch();
      if (stream !== current || done) { return; }
      current = null;
      onCut(why);
    }
    watch();
    stream.on('data', function (chunk) {
      if (stream !== current || done) { unwatch(); return; }
      watch();
      if (skip > 0) {
        // Bytes the player already has (resume answered from an earlier byte).
        if (chunk.length <= skip) { skip -= chunk.length; return; }
        chunk = chunk.subarray(skip);
        skip = 0;
      }
      if (boxScan && !boxScan.done) { try { scanBoxes(chunk, base + sent); } catch (eScan) { boxScan.done = true; } }
      if (parallel && !parallel.mainDone) {
        var room = parallel.limit - (base + sent);
        if (chunk.length >= room) {
          // The main connection has delivered its part: the rest of the index
          // comes from the parallel parts.
          if (room > 0) { emit(chunk.subarray(0, room)); }
          parallel.mainDone = true;
          unwatch();
          current = null;
          connRecord.up = null;
          try { stream.destroy(); } catch (eD) { /* ignore */ }
          return flushParallel();
        }
      }
      if (!emit(chunk)) {
        stream.pause();
        unwatch();
        res.once('drain', function () { if (stream === current) { stream.resume(); watch(); } });
      }
    });
    stream.on('end', function () { cut('fin anticipado'); });
    stream.on('aborted', function () { cut('cortada por el CDN'); });
    stream.on('error', function (e) { cut(timing.safeError(e)); });
    stream.on('close', function () { cut('cerrada'); });
  }

  function onCut(why) {
    if (!canResume || sent >= expected) { return finish(); }
    // The player left (seek, other title): nothing to resume.
    if (connRecord.closing || !connRecord.res || res.destroyed || res.writableEnded) { return finish(); }
    if (sent - sentAtResume >= RESUME_PROGRESS) { resumes = 0; }
    if (resumes >= MAX_RESUMES) {
      if (label) { timing.log('cdn ' + label + ' | conexión cortada otra vez (' + why + '); ' + MAX_RESUMES + ' cortes seguidos sin progreso, se entrega lo recibido'); }
      return finish();
    }
    resumes++; totalResumes++;
    sentAtResume = sent;
    if (label) {
      timing.log('cdn ' + label + ' | conexión cortada (' + why + ') tras ' + sent + ' bytes en ' +
        (Date.now() - tStart) + 'ms → reanudando desde el byte ' + (base + sent) + ' (#' + totalResumes + ')');
    }
    requestFrom(base + sent, Date.now());
  }

  /* One sequential CDN connection from byte `from` to the end of the range. */
  function requestFrom(from, tResume) {
    if (done) { return; }
    var to = base + expected - 1;
    if (from > to) { return finish(); }
    var info = mediaRequest(entry, 'GET', { Range: 'bytes=' + from + '-' + to }, ip);
    var answered = false;
    var again = (info.secure ? https : http).request(info.options, function (up2) {
      answered = true;
      if (done) { try { up2.destroy(); } catch (eLate) { /* ignore */ } return; }
      var start = answerStart(up2);
      var skip = start >= 0 && start <= from ? from - start : -1;
      if (skip < 0 || skip > RESUME_SKIP_MAX) {
        if (label) {
          timing.log('cdn ' + label + ' | la conexión al CDN respondió HTTP ' + up2.statusCode +
            (start >= 0 ? ' desde el byte ' + start + ' (se pidió el ' + from + ')' : ' sin posición') + '; se entrega lo recibido');
        }
        // Never appended: these bytes would land at the wrong position.
        try { up2.destroy(); } catch (eDrop) { /* ignore */ }
        return finish();
      }
      if (label && skip > 0) {
        timing.log('cdn ' + label + ' | el CDN respondió HTTP ' + up2.statusCode + ' desde el byte ' + start +
          ' (se pidió el ' + from + '): se descartan ' + skip + ' bytes ya entregados y se sigue');
      }
      if (label && tResume) { timing.log('cdn ' + label + ' | reanudada en ' + (Date.now() - tResume) + 'ms'); }
      again.setTimeout(0);
      attach(up2, skip);
    });
    connRecord.upstream = again;
    /* Measured 12/11/2026: a resume sent while another connection of this
       title was open never got an answer, and the player waited 25 s for
       nothing.  A healthy CDN answers in 0.3-2 s, so an unanswered resume is
       given up early and asked again (onCut counts it like another cut). */
    again.setTimeout(RESUME_ANSWER_MS, function () { try { again.abort(); } catch (eAbort) { /* ignore */ } });
    again.on('error', function (e) {
      if (done || answered || current !== null || connRecord.upstream !== again) { return; }
      onCut('la reanudación no obtuvo respuesta en ' + Math.round(RESUME_ANSWER_MS / 1000) + ' s: ' + timing.safeError(e));
    });
    again.end();
  }

  connRecord.resumeOnCut = function (err) {
    if (!current) { return; }
    current = null;
    onCut(timing.safeError(err));
  };
  if (up) {
    attach(up);
  } else {
    // Head served from memory: continue from the CDN right after it.
    if (pre.cached && pre.cached.length) { emit(pre.cached); }
    if (sent >= expected) { return finish(); }
    requestFrom(base + sent, null);
  }
}

/* Diagnostic (XUPER_TIEMPOS=1): compare the video servers SLB offered for a
 * title.  One after another, each one is asked for the same 2 MB from the
 * middle of the file; logs host name, time to first byte and speed only. */
function probeServers(urls, headers, text) {
  if (!timing.enabled || !urls || !urls.length) { return; }
  var list = urls.filter(function (u) { return /^https?:\/\//i.test(u || ''); });
  timing.log('servidores de vídeo ' + text + ' | el SLB ofreció ' + list.length + ' servidor(es); midiendo 2 MB de cada uno…');
  var results = [];
  var i = 0;
  function next() {
    if (i >= list.length) {
      results.sort(function (a, b) { return b.mbps - a.mbps; });
      timing.log('servidores de vídeo ' + text + ' | resumen (más rápido primero): ' +
        results.map(function (r) { return '#' + r.n + ' ' + r.host + ' ' + (r.ok ? r.mbps.toFixed(1) + ' Mbit/s' : r.error); }).join(' · '));
      return;
    }
    var n = ++i;
    var target = list[n - 1];
    var host = urlmod.parse(target).hostname || '?';
    var probe = { url: target, headers: headers || {}, resolvedIp: '' };
    resolveHostIp(probe, function (ip) {
      var info = mediaRequest(probe, 'GET', { Range: 'bytes=20000000-22097151' }, ip);
      var t0 = Date.now(), tFirst = 0, bytes = 0, finished = false;
      function done(error, status) {
        if (finished) { return; }
        finished = true;
        var ms = Date.now() - t0;
        var r = { n: n, host: host, ok: !error && bytes > 0, mbps: bytes && ms ? bytes * 8 / ((ms - tFirst) || ms) / 1000 : 0, error: error || '' };
        results.push(r);
        timing.log('servidores de vídeo ' + text + ' | #' + n + (n === 1 ? ' (el que se usa)' : '') + ' ' + host +
          (error ? ' | ' + error : ' | HTTP ' + status + ' | primera respuesta ' + tFirst + 'ms | ' +
            (bytes / 1048576).toFixed(1) + ' MB en ' + (ms - tFirst) + 'ms = ' + r.mbps.toFixed(1) + ' Mbit/s'));
        setTimeout(next, 300);
      }
      var rq = (info.secure ? https : http).request(info.options, function (u) {
        tFirst = Date.now() - t0;
        if (u.statusCode !== 206 && u.statusCode !== 200) { u.resume(); return done('HTTP ' + u.statusCode); }
        u.on('data', function (c) { bytes += c.length; });
        u.on('end', function () { done(null, u.statusCode); });
        u.on('aborted', function () { done(bytes ? null : 'cortada', u.statusCode); });
        u.on('error', function (e) { done(bytes ? null : timing.safeError(e), u.statusCode); });
      });
      rq.setTimeout(15000, function () { try { rq.abort(); } catch (eT) { /* ignore */ } done(bytes ? null : 'sin respuesta en 15 s', 0); });
      rq.on('error', function (e) { done(timing.safeError(e), 0); });
      rq.end();
    });
  }
  next();
}

/* Serve the start of a title from the head cache, if this request needs it. */
function serveFromHeadCache(req, res, entry, token, ip, connRecord, cleanup) {
  if (req.method !== 'GET') { return false; }
  var cache = headCacheGet(entry.url);
  if (!cache) { return false; }
  var m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range || 'bytes=0-'));
  if (!m) { return false; }
  var start = parseInt(m[1], 10);
  var end = m[2] ? Math.min(parseInt(m[2], 10), cache.total - 1) : cache.total - 1;
  if (start >= cache.buf.length || start > end) { return false; }
  var cached = cache.buf.subarray(start, Math.min(cache.buf.length, end + 1));
  res.writeHead(206, {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, max-age=120',
    'Connection': 'keep-alive',
    'Content-Length': end - start + 1,
    'Content-Range': 'bytes ' + start + '-' + end + '/' + cache.total
  });
  if (timing.enabled && timingLabels[token]) {
    timing.log('cdn ' + timingLabels[token].text + ' | índice servido desde la memoria (' +
      Math.round(cached.length / 1048576 * 10) / 10 + ' MB, sin esperar al CDN)');
  }
  pipeResumable(null, res, req, entry, ip, connRecord, token, cleanup,
    { expected: end - start + 1, base: start, total: cache.total, cached: cached });
  return true;
}

function forward(req, res, entry, token) {
  /* When switching to a different movie or episode, immediately abort all previous video streams */
  if (activeToken !== token) {
    killActiveStreams();
    activeToken = token;
  }

  var rangeHeaders = {};
  if (req.headers.range) { rangeHeaders.Range = req.headers.range; }
  if (req.headers['if-range']) { rangeHeaders['If-Range'] = req.headers['if-range']; }

  resolveHostIp(entry, function (ip) {
    if (res.finished) { return; }

    var requestInfo = mediaRequest(entry, req.method === 'HEAD' ? 'HEAD' : 'GET', rangeHeaders, ip);
    var secure = requestInfo.secure;
    var opts = requestInfo.options;

    if (res.socket) {
      try { res.socket.setNoDelay(true); } catch (eNd1) { /* ignore */ }
    }

    var connRecord = { upstream: null, res: res, req: req, up: null };
    activeUpstreams.push(connRecord);

    function cleanup() {
      var idx = activeUpstreams.indexOf(connRecord);
      if (idx !== -1) { activeUpstreams.splice(idx, 1); }
      destroyConnection(connRecord);
    }

    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);

    /* Test only (XUPER_SIMULATE_DEAD=mp4|ts): pretend the CDN server of that
       format does not answer, to exercise the app's version fallback. */
    var deadFormat = process.env.XUPER_SIMULATE_DEAD;
    var parentEntry = tokens[token];
    if (deadFormat && parentEntry && parentEntry.format === deadFormat) {
      if (timing.enabled && timingLabels[token]) { timing.log('cdn ' + timingLabels[token].text + ' | SIMULACIÓN: servidor .' + deadFormat + ' caído → 504'); }
      return setTimeout(function () {
        try { res.writeHead(504, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); res.end('simulado'); } catch (eSim) { /* ignore */ }
        cleanup();
      }, 3000);
    }

    /* The start of this title (up to the end of its index) is in memory. */
    if (serveFromHeadCache(req, res, entry, token, ip, connRecord, cleanup)) { return; }

    var tRequest = Date.now();
    var upstream = (secure ? https : http).request(opts, function (up) {
      connRecord.up = up;
      if (up.statusCode === 401 || up.statusCode === 403) {
        var rejected = tokens[token];
        if (rejected && rejected.onReject && !rejected.rejectReported) {
          rejected.rejectReported = true;
          try { rejected.onReject(up.statusCode); } catch (eReject) { /* ignore */ }
        }
      }
      var tl = timing.enabled && timingLabels[token];
      if (tl && (tl.logged < 4 || (up.statusCode || 0) >= 400)) {
        tl.logged++;
        var parentEntry = tokens[token];
        var kind = /\.m3u8(\?|$)/i.test(entry.url || '') ? 'manifiesto' :
          (req.headers.range ? 'bytes ' + String(req.headers.range).slice(0, 40) : 'segmento');
        timing.log('cdn ' + tl.text + ' | ' + kind + ' | HTTP ' + up.statusCode +
          ' | espera del CDN=' + (Date.now() - tRequest) + 'ms' +
          (parentEntry && parentEntry.at ? ' | desde que se creó el enlace=' + (Date.now() - parentEntry.at) + 'ms' : '') +
          (entry.backupIndex ? ' | servidor alternativo #' + entry.backupIndex : ''));
      }
      /* Cortes a mitad de reproducción: después de las 4 primeras peticiones se
         registra igualmente cualquier descarga lenta (espera > 1,5 s o total
         > 4 s), que es lo que deja al reproductor sin datos. */
      var tTtfb = Date.now() - tRequest;
      if (tl) {
        var slowKind = /\.m3u8(\?|$)/i.test(entry.url || '') ? 'manifiesto' : 'segmento';
        res.once('finish', function () {
          var total = Date.now() - tRequest;
          if (tTtfb > 1500 || total > 4000) {
            timing.log('cdn ' + tl.text + ' | LENTO ' + slowKind + ' | espera del CDN=' + tTtfb + 'ms | descarga total=' + total + 'ms' +
              (up.headers['content-length'] ? ' | ' + Math.round(Number(up.headers['content-length']) / 1024) + ' KB' : ''));
          }
        });
      }
      if (up.socket) {
        try { up.socket.setNoDelay(true); } catch (eNd2) { /* ignore */ }
      }
      upstream.setTimeout(0);
      if (upstream.socket) {
        try { upstream.socket.setTimeout(0); } catch (e1) { /* ignore */ }
      }

      var rawMime = (up.headers['content-type'] || '').toLowerCase();
      var contentType = 'video/mp2t';
      if (rawMime.indexOf('mp4') !== -1) {
        contentType = 'video/mp4';
      } else if (rawMime.indexOf('mpegurl') !== -1 || (entry.url && entry.url.indexOf('.m3u8') !== -1) || entry.hlsSource) {
        contentType = 'application/vnd.apple.mpegurl';
      }
      var isM3u8 = (contentType === 'application/vnd.apple.mpegurl');

      var out = {
        'Content-Type': contentType,
        'Accept-Ranges': up.headers['accept-ranges'] || 'bytes',
        'Access-Control-Allow-Origin': '*',
        /* This is a loopback-only authenticated proxy.  no-store makes the
           webOS media pipeline discard every received range, leaving it with a
           tiny buffer and visible micro-pauses.  A short private cache permits
           normal read-ahead/retry without sharing the licensed response. */
        'Cache-Control': isM3u8 ? 'no-cache, no-store' : 'private, max-age=120',
        'Connection': 'keep-alive'
      };
      if (up.headers['content-length']) { out['Content-Length'] = up.headers['content-length']; }
      if (up.headers['content-range']) { out['Content-Range'] = up.headers['content-range']; }

      if (req.method === 'HEAD') {
        res.writeHead(up.statusCode || 200, out);
        res.end();
        up.resume();
        return;
      }

      if (isM3u8) {
        var chunks = [];
        up.on('data', function (chunk) { chunks.push(chunk); });
        up.on('error', function () { cleanup(); });
        up.on('end', function () {
          var rawBody = Buffer.concat(chunks).toString('utf8');
          /* En vivo la lista avanza (MEDIA-SEQUENCE sube) cada pocos segundos.
             Si deja de avanzar, la emisión del canal está parada en origen. */
          if (tl && /#EXT-X-MEDIA-SEQUENCE:(\d+)/.test(rawBody) && !/#EXT-X-ENDLIST/.test(rawBody)) {
            var seqNow = Number(RegExp.$1), td = /#EXT-X-TARGETDURATION:(\d+)/.exec(rawBody);
            var lastSeq = entry.timingSeq;
            if (lastSeq && lastSeq.seq === seqNow && Date.now() - lastSeq.at > Math.max(8000, (td ? Number(td[1]) : 6) * 2000) && !lastSeq.warned) {
              lastSeq.warned = true;
              timing.log('cdn ' + tl.text + ' | LA EMISIÓN NO AVANZA: la lista sigue igual desde hace ' + Math.round((Date.now() - lastSeq.at) / 1000) + ' s (origen del canal parado)');
            }
            if (!lastSeq || lastSeq.seq !== seqNow) { entry.timingSeq = { seq: seqNow, at: Date.now() }; }
          }
          var body = rewriteHlsManifest(rawBody, token, entry.url);
          delete out['Content-Length'];
          delete out['Content-Range'];
          out['Content-Length'] = Buffer.byteLength(body);
          try {
            res.writeHead(up.statusCode || 200, out);
            res.end(body);
          } catch (eManifest) { cleanup(); }
        });
        return;
      }

      res.writeHead(up.statusCode || 200, out);

      /* Directo with another audio language: list that stream first in the
         PMT. Same byte count, so Content-Length/Content-Range stay valid.
         Cleanup waits for the response to finish (res 'finish'/'close'), so
         the transform's last packets are not cut off. */
      var audioIndex = contentType === 'video/mp2t' ? audioParam(req.url) : 0;
      if (audioIndex > 0) {
        if (!entry.tsAudioState) { entry.tsAudioState = {}; }
        up.on('error', function () { cleanup(); });
        up.pipe(tsAudio.createRewriter(audioIndex, rangeStart(req.headers.range), entry.tsAudioState)).pipe(res);
        return;
      }

      pipeResumable(up, res, req, entry, ip, connRecord, token, cleanup);
    });

    connRecord.upstream = upstream;

    if (upstream.socket) {
      try { upstream.socket.setNoDelay(true); } catch (eNd3) { /* ignore */ }
    }

    /* Connect timeout only - aborted if headers do not arrive in 10 s.  A
       healthy CDN answered in 0.3-1.8 s in every measurement; a dead server
       held the player 25 s before (12/11/2026), now the app can switch to
       another version sooner. */
    upstream.setTimeout(10000, function () {
      if (timing.enabled && timingLabels[token] && !res.headersSent) {
        timing.log('cdn ' + timingLabels[token].text + ' | SIN RESPUESTA en 10 s → 504');
      }
      if (!res.headersSent) {
        try { upstream.abort(); } catch (e) { /* ignore */ }
        try {
          res.writeHead(504, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          res.end('gateway timeout');
        } catch (e504) { /* ignore */ }
      }
      cleanup();
    });

    upstream.on('error', function (uErr) {
      /* Mid-body cut of a resumable download: continue from the last byte. */
      if (res.headersSent && connRecord.resumeOnCut) { return connRecord.resumeOnCut(uErr); }
      if (timing.enabled && timingLabels[token]) {
        timing.log('cdn ' + timingLabels[token].text + ' | ERROR de conexión ' + timing.safeError(uErr) +
          ' tras ' + (Date.now() - tRequest) + 'ms' + (res.headersSent ? ' (a mitad de la descarga)' : ' (antes de responder)'));
      }
      if (entry && entry.url) {
        var h = urlmod.parse(entry.url).hostname;
        var hit = dnsx.cached(h);
        if (hit && hit.ips && hit.ips.length > 1) {
          entry.resolvedIp = dnsx.dial(h, hit.ips);
        }
      }
      if (!res.headersSent && entry && entry.backupUrls && entry.backupIndex < entry.backupUrls.length) {
        var nextUrl = entry.backupUrls[entry.backupIndex++];
        console.log('[proxy] upstream falló (' + (uErr && (uErr.code || uErr.message)) + '), reintentando con CDN alternativa');
        entry.url = nextUrl;
        entry.resolvedIp = '';
        detachUpstream(connRecord);
        return forward(req, res, entry, token);
      }
      /* Live segments and manifests: the CDN sometimes resets one connection
         (ECONNRESET) while the next one works.  Retry the same request twice
         right away instead of answering 502, which made hls.js wait ~30 s. */
      var quick = req.__xuperQuickRetries || 0;
      if (!res.headersSent && req.method !== 'HEAD' && quick < 2 && !res.destroyed) {
        req.__xuperQuickRetries = quick + 1;
        if (timing.enabled && timingLabels[token]) {
          timing.log('cdn ' + timingLabels[token].text + ' | reintento rápido #' + (quick + 1) + ' tras ' + timing.safeError(uErr));
        }
        detachUpstream(connRecord);
        return setTimeout(function () {
          if (!res.destroyed && !res.headersSent) { forward(req, res, entry, token); }
        }, 300 * (quick + 1));
      }
      if (!res.headersSent) {
        try {
          res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          res.end('upstream error');
        } catch (e502) { /* ignore */ }
      }
      cleanup();
    });

    upstream.end();
  });
}

/* ---- Radio en vivo ------------------------------------------------------
   La página es segura y bloquearía señales y logos por HTTP: pasan por aquí.
   Solo se abren direcciones entregadas por service/radio.js (fichas), así el
   proxy local no sirve para abrir cualquier dirección. */
var radioTokens = {}, radioByUrl = {}, radioOrder = [];
var MAX_RADIO_TOKENS = 6000;
function addRadio(target) {
  target = String(target || '');
  if (radioByUrl[target]) { return baseUrl() + '/radio/' + radioByUrl[target]; }
  var token = crypto.randomBytes(12).toString('hex');
  radioTokens[token] = target;
  radioByUrl[target] = token;
  radioOrder.push(token);
  while (radioOrder.length > MAX_RADIO_TOKENS) {
    var old = radioOrder.shift();
    delete radioByUrl[radioTokens[old]];
    delete radioTokens[old];
  }
  return baseUrl() + '/radio/' + token;
}

function forwardRadio(req, res, target, hops) {
  var parsed = urlmod.parse(target);
  var secure = parsed.protocol === 'https:';
  var options = {
    protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port || (secure ? 443 : 80),
    path: parsed.path || '/', method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: { 'User-Agent': 'XuperDesktop', 'Icy-MetaData': '0', Accept: '*/*' }
  };
  dnsx.prepare(options, function (perr, prepared) {
    if (perr) { prepared = options; }
    var upstream = (secure ? https : http).request(prepared, function (up) {
      var status = up.statusCode || 502;
      if (status >= 300 && status < 400 && up.headers.location && hops < 5) {
        up.resume();
        return forwardRadio(req, res, urlmod.resolve(target, up.headers.location), hops + 1);
      }
      var head = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache',
        'Content-Type': up.headers['content-type'] || 'audio/mpeg' };
      if (up.headers['content-length']) { head['Content-Length'] = up.headers['content-length']; }
      try { res.writeHead(status, head); } catch (eHead) { up.resume(); return; }
      up.pipe(res);
      up.on('error', function () { try { res.end(); } catch (eEnd) { /* ignore */ } });
    });
    upstream.setTimeout(20000, function () { try { upstream.abort(); } catch (eAbort) { /* ignore */ } });
    upstream.on('error', function () {
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); }
        res.end('emisora no disponible');
      } catch (eRes) { /* ignore */ }
    });
    /* Al dejar de escuchar (el <audio> cierra), cortar la señal. */
    res.on('close', function () { try { upstream.abort(); } catch (eClose) { /* ignore */ } });
    upstream.end();
  });
}

/* ---- Videoteca: vídeos de una carpeta del PC ------------------------------
   Solo archivos que entrega service/videoteca.js (una ficha por archivo), con
   rangos para poder avanzar y retroceder.  La página nunca ve la ruta. */
var localTokens = {}, localByPath = {}, localOrder = [];
var LOCAL_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
function addLocal(filePath) {
  filePath = String(filePath || '');
  if (localByPath[filePath]) { return baseUrl() + '/file/' + localByPath[filePath] + localExt(filePath); }
  var token = crypto.randomBytes(12).toString('hex');
  localTokens[token] = filePath;
  localByPath[filePath] = token;
  localOrder.push(token);
  while (localOrder.length > 20000) {
    var old = localOrder.shift();
    delete localByPath[localTokens[old]];
    delete localTokens[old];
  }
  return baseUrl() + '/file/' + token + localExt(filePath);
}
function localExt(filePath) {
  var m = /\.[a-z0-9]{2,4}$/i.exec(filePath);
  return m ? m[0].toLowerCase() : '';
}
function sendLocal(req, res, filePath) {
  var fs = require('fs');
  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      return res.end('no encontrado');
    }
    var type = LOCAL_TYPES[localExt(filePath)] || 'application/octet-stream';
    var size = st.size, start = 0, end = size - 1, status = 200;
    var m = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range || ''));
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = parseInt(m[1], 10); if (m[2]) { end = Math.min(size - 1, parseInt(m[2], 10)); } }
      else { start = Math.max(0, size - parseInt(m[2], 10)); }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + size, 'Access-Control-Allow-Origin': '*' });
        return res.end();
      }
      status = 206;
    }
    var head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=60' };
    if (status === 206) { head['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size; }
    res.writeHead(status, head);
    if (req.method === 'HEAD') { return res.end(); }
    var stream = fs.createReadStream(filePath, { start: start, end: end });
    stream.on('error', function () { try { res.end(); } catch (eEnd) { /* ignore */ } });
    res.on('close', function () { try { stream.destroy(); } catch (eDestroy) { /* ignore */ } });
    stream.pipe(res);
  });
}

function handler(req, res) {
  try { req.setTimeout(0); } catch (eT1) { /* ignore */ }
  try { res.setTimeout(0); } catch (eT2) { /* ignore */ }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range'
    });
    res.end();
    return;
  }
  if (req.url === '/media/abort') {
    killActiveStreams();
    activeToken = null;
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('aborted');
    return;
  }
  var local = /^\/file\/([a-f0-9]{24})(\.[a-z0-9]{2,4})?$/.exec((req.url || '').split('?')[0]);
  if (local) {
    var localPath = localTokens[local[1]];
    if (!localPath) {
      res.writeHead(410, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('expired');
      return;
    }
    sendLocal(req, res, localPath);
    return;
  }
  var radio = /^\/radio\/([a-f0-9]{24})$/.exec((req.url || '').split('?')[0]);
  if (radio) {
    var radioTarget = radioTokens[radio[1]];
    if (!radioTarget) {
      res.writeHead(410, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('expired');
      return;
    }
    forwardRadio(req, res, radioTarget, 0);
    return;
  }
  var sub = /^\/sub\/([a-f0-9]{24})\.srt$/.exec(req.url || '');
  if (sub) {
    var subEntry = subtitleTokens[sub[1]];
    if (!subEntry) {
      res.writeHead(410, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('expired');
      return;
    }
    sendSubtitle(req, res, subEntry);
    return;
  }
  var hls = /^\/hls\/([a-f0-9]{24})\/([A-Za-z0-9_-]+)$/.exec((req.url || '').split('?')[0]);
  if (hls) {
    if (urlmod.parse(req.url, true).query.sig !== manifestSignature(hls[1], hls[2])) {
      res.writeHead(403); res.end(); return;
    }
    var hlsEntry = tokens[hls[1]];
    if (!hlsEntry) {
      res.writeHead(410, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('expired');
      return;
    }
    var childUrl = fromBase64Url(hls[2]);
    if (!/^https?:\/\//i.test(childUrl)) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('invalid hls child');
      return;
    }
    forward(req, res, {
      url: childUrl,
      headers: hlsEntry.headers,
      duration: 0,
      backupUrls: hlsEntry.backupUrls,
      backupIndex: hlsEntry.backupIndex
    }, hls[1]);
    return;
  }
  var m = /^\/media\/([a-f0-9]{24})(?:\/([^\?#]*))?(?:[?#].*)?$/.exec(req.url || '');
  if (!m) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
    return;
  }
  var token = m[1];
  var subpath = m[2] || '';
  var entry = tokens[token];
  if (!entry) {
    res.writeHead(410, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('expired');
    return;
  }
  if (!entry.hlsSource && entry.url.indexOf('.m3u8') === -1 && subpath.indexOf('.m3u8') !== -1) {
    sendVirtualHls(req, res, token, entry);
    return;
  }
  var segIndex = segmentParam(req.url);
  if (segIndex >= 0 && entry.seekPlan) {
    forwardSegment(req, res, entry, token, segIndex);
    return;
  }
  forward(req, res, entry, token);
}

function start(cb) {
  if (server && port) { return cb(null, port); }
  server = http.createServer(handler);
  server.timeout = 0;
  if (typeof server.setTimeout === 'function') {
    server.setTimeout(0);
  }
  server.on('error', function (err) { cb(err); });
  server.listen(0, '127.0.0.1', function () {
    port = server.address().port;
    cb(null, port);
  });
}

function baseUrl() {
  if (process.env.RENDER_EXTERNAL_URL) return new URL(process.env.RENDER_EXTERNAL_URL).origin + '/reproducir/proxy';
  return port ? 'http://127.0.0.1:' + port : '';
}

/* Byte-range access to a registered title (same headers, DNS and CDN as
 * playback).  Used to measure the duration from the file's timestamps. */
function rangeReader(token) {
  var entry = tokens[token];
  if (!entry) { return null; }
  return {
    length: function (cb) { sourceLength(entry, cb); },
    range: function (start, end, cb) { readRange(entry, start, end, cb); }
  };
}

module.exports = {
  addRadio: addRadio,
  addLocal: addLocal,
  rangeReader: rangeReader,
  start: start,
  add: add,
  label: label,
  onReject: onReject,
  markHls: markHls,
  probeServers: probeServers,
  addSubtitle: addSubtitle,
  baseUrl: baseUrl,
  port: function () { return port; },
  killActiveStreams: killActiveStreams,
  close: function () { killActiveStreams(); if (server) server.close(); }
};

