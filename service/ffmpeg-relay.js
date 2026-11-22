'use strict';
// ffmpeg-relay.js  (solo ES5: el Node de la TV es muy antiguo)
// Remuxea TS -> MP4 fragmentado (sin recodificar) y lo sirve por HTTP local,
// para que el <video> use el reproductor nativo de la TV con un MP4 en vez del TS.

var http = require('http');
var fs = require('fs');
var crypto = require('crypto');
var urlmod = require('url');
var spawn = require('child_process').spawn;
var dnsx = require('./dnsx');

/* Services run in a restricted namespace where /media/developer may not be
 * visible even though it is visible through SSH. Keep the executable next to
 * this service so the spawned process sees the same filesystem. */
var FFMPEG = process.env.XUPER_FFMPEG_PATH || (__dirname + '/ffmpeg');
var HOST = '127.0.0.1';   // solo local: no es un relay abierto
var PORT = 0;

var sessions = {};        // token -> { url, headers, audio, hevc, hw, height }
var current = null;       // { ff } stream activo (solo uno a la vez)

/* ---- Aceleración por hardware del Modo fluido --------------------------
   Convertir HEVC a H.264 solo con la CPU (libx264) pone al 100 % los equipos
   antiguos. Al arrancar se prueba en segundo plano qué codificador H.264 de
   la tarjeta gráfica funciona (Intel Quick Sync, NVIDIA NVENC, AMD AMF) con
   un vídeo sintético de 1 s. La decodificación usa -hwaccel auto (DXVA2 /
   D3D11): si la gráfica no sabe decodificar ese formato, FFmpeg sigue por
   software solo. Si el codificador falla con un título, se vuelve a libx264
   sin que el usuario lo note. */
var HW_ENCODERS = [
  { enc: 'h264_qsv', label: 'Intel Quick Sync' },
  { enc: 'h264_nvenc', label: 'NVIDIA NVENC' },
  { enc: 'h264_amf', label: 'AMD AMF' }
];
var hwState = { tested: false, testing: false, encoder: '', label: '', tried: [], broken: false, last: '' };
var hwWaiters = [];

function hwEncoderArgs(enc, kbps) {
  var rate = [String(kbps) + 'k', String(Math.round(kbps * 1.5)) + 'k', String(kbps * 2) + 'k'];
  if (enc === 'h264_qsv') { return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', rate[0], '-maxrate', rate[1], '-bufsize', rate[2], '-g', '50']; }
  if (enc === 'h264_nvenc') { return ['-c:v', 'h264_nvenc', '-preset', 'p3', '-rc', 'vbr', '-b:v', rate[0], '-maxrate', rate[1], '-bufsize', rate[2], '-g', '50']; }
  return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'vbr_peak', '-b:v', rate[0], '-maxrate', rate[1], '-bufsize', rate[2], '-g', '50'];
}

function detectHardware(done) {
  if (done) { if (hwState.tested) { return done(hwState); } hwWaiters.push(done); }
  if (hwState.tested || hwState.testing) { return; }
  hwState.testing = true;
  var i = 0;
  function finish() {
    hwState.tested = true; hwState.testing = false;
    log('aceleración modo fluido: ' + (hwState.encoder ? hwState.label + ' (' + hwState.encoder + ')' : 'no disponible, se usa la CPU') + ' | probados: ' + hwState.tried.join(', '));
    var w = hwWaiters; hwWaiters = [];
    for (var k = 0; k < w.length; k++) { try { w[k](hwState); } catch (eW) { /* ignore */ } }
  }
  function next() {
    if (i >= HW_ENCODERS.length) { return finish(); }
    var c = HW_ENCODERS[i++];
    var args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
      '-frames:v', '25', '-pix_fmt', 'nv12'].concat(hwEncoderArgs(c.enc, 1500)).concat(['-f', 'null', '-']);
    var ff, doneOne = false;
    try { ff = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); } catch (eSpawn) { hwState.tried.push(c.enc + ' no'); return next(); }
    var timer = setTimeout(function () { try { ff.kill('SIGKILL'); } catch (eK) { /* ignore */ } }, 10000);
    ff.stderr.on('data', function () { /* drain */ });
    function settle(ok) {
      if (doneOne) { return; }
      doneOne = true; clearTimeout(timer);
      hwState.tried.push(c.enc + (ok ? ' sí' : ' no'));
      if (ok) { hwState.encoder = c.enc; hwState.label = c.label; return finish(); }
      next();
    }
    ff.on('error', function () { settle(false); });
    ff.on('close', function (code) { settle(code === 0); });
  }
  next();
}

/* ¿El error de FFmpeg viene del codificador/decodificador de la gráfica y no
   de la entrada (red, enlace caducado, archivo dañado)? */
function isEncoderFailure(text, encoder) {
  text = String(text || '');
  if (/Error opening input|Server returned|Connection (refused|reset|timed out)|Failed to resolve|Invalid data found|I\/O error|End of file/i.test(text)) { return false; }
  return text.indexOf(encoder) !== -1 || /qsv|mfx|nvenc|cuda|amf|d3d11|dxva|hwaccel|hardware|encoder|Error (initializing|while opening) (output|encoder)/i.test(text);
}

/* Kbps por resolución para los codificadores de la gráfica. */
function targetKbps(height) {
  if (height && height <= 480) { return 1500; }
  if (height && height <= 720) { return 3000; }
  return 5000;
}

function log() {
  var args = Array.prototype.slice.call(arguments);
  try { fs.appendFileSync(require('path').join(require('os').tmpdir(), 'xuper-desktop-relay.log'), args.join(' ') + '\n'); } catch (eLog) { /* diagnostic log is optional */ }
  console.log.apply(console, ['[relay]'].concat(args));
}

/* The packaged mode is already 0755 (tools/fix_ipk_modes.py). Try chmod only
   when it is missing, so a root-owned install does not log a false alarm. */
try {
  var mode = fs.statSync(FFMPEG).mode;
  if (!(mode & parseInt('111', 8))) {
    fs.chmodSync(FFMPEG, parseInt('755', 8));
  }
} catch (e) {
  /* Installed packages are owned by root; the service user cannot chmod them.
     Record it: if the packaged mode is wrong, spawn() would fail with EACCES. */
  log('no se pudo aplicar permiso de ejecucion a ffmpeg:', e.message);
}

function stopCurrent() {
  if (current) {
    try { current.ff.kill('SIGKILL'); } catch (e) { /* ya termino */ }
    current = null;
  }
}

// Separa User-Agent (ffmpeg lo quiere en -user_agent) del resto de cabeceras.
function splitHeaders(h) {
  var ua = null;
  var rest = [];
  Object.keys(h || {}).forEach(function (k) {
    if (k.toLowerCase() === 'user-agent') ua = h[k];
    else rest.push(k + ': ' + h[k] + '\r\n');
  });
  return { ua: ua, rest: rest.join('') };
}

// Registra una sesion y devuelve la URL local para el <video>.
// stream: { url, headers } tal como lo devuelve magis.resolve
function register(stream, opts) {
  opts = opts || {};
  var token = crypto.randomBytes(8).toString('hex');
  sessions[token] = {
    url: stream.url,
    headers: stream.headers || {},
    audio: opts.audio || 0,
    hevc: !!opts.hevc,
    hw: opts.hw !== false,
    height: Number(opts.height) || 0
  };
  var base = process.env.RENDER_EXTERNAL_URL ? new URL(process.env.RENDER_EXTERNAL_URL).origin + '/reproducir/relay' : 'http://' + HOST + ':' + PORT;
  return base + '/s/' + token + '.mp4';
}

function buildArgs(s, start, audio, encoder) {
  var h = splitHeaders(s.headers);
  var args = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-probesize', '1M', '-analyzeduration', '1M'
  ];
  if (/^https?:\/\//i.test(s.url)) {   // estas opciones solo existen para entradas HTTP(S)
    args.push('-rw_timeout', '15000000');
    /* El CDN corta la descarga a los pocos MB ("Stream ends prematurely").
       Con -reconnect FFmpeg pide de nuevo desde el byte donde se cortó (Range),
       en vez de abandonar con "End of file" (código 4 en el reproductor).
       5 s de espera máxima entre intentos: un corte real no deja el vídeo colgado. */
    args.push('-reconnect', '1', '-reconnect_on_network_error', '1',
      '-reconnect_on_http_error', '5xx', '-reconnect_delay_max', '5');
    if (/^https:/i.test(s.url)) { args.push('-tls_verify', '1'); }
    if (h.ua) args.push('-user_agent', h.ua);
    if (h.rest) args.push('-headers', h.rest);
  }
  /* La gráfica decodifica si puede; si no, FFmpeg sigue por software. */
  if (encoder) args.push('-hwaccel', 'auto');
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', s.url, '-map', '0:v:0', '-map', '0:a:' + audio + '?');
  var height = Number(s.height) || 0;
  var filters = [];
  if (height) filters.push("scale=-2:'min(ih," + height + ")':flags=fast_bilinear");
  if (encoder) {
    filters.push('format=nv12');
    args.push('-vf', filters.join(','));
    args = args.concat(hwEncoderArgs(encoder, targetKbps(height)));
  } else {
    if (filters.length) args.push('-vf', filters.join(','));
    /* Sin gráfica y con resolución reducida, un preset más rápido. */
    args.push('-c:v', 'libx264', '-preset', height ? 'superfast' : 'veryfast', '-crf', height ? '23' : '22', '-pix_fmt', 'yuv420p');
  }
  args.push(
    '-c:a', 'aac', '-b:a', '160k',
    // El portal entrega AAC dentro de TS como ADTS. MP4/fMP4 exige el Audio
    // Specific Config, que este filtro extrae sin recodificar el audio.
    '-bsf:a', 'aac_adtstoasc'
  );
  if (s.hevc) args.push('-tag:v', 'avc1');   // hvc1 es la etiqueta que el reproductor nativo acepta bien
  args.push(
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1'
  );
  return args;
}

/*
 * The bundled static ffmpeg occasionally cannot use webOS's local DNS stub
 * (127.0.0.1), while the platform resolver can. Resolve HTTP CDN names with
 * DoH (dnsx) or the platform utility and preserve the original Host header for the CDN.
 */
function resolveForFfmpeg(s, done) {
  var fixedUrl = require('./cachefly').ffmpegUrl(s.url);
  if (fixedUrl !== s.url) {
    log('CDN CacheFly: ffmpeg usa HTTP (su certificado HTTPS no cubre el dominio)');
    s = { url: fixedUrl, headers: s.headers, audio: s.audio, hevc: s.hevc, hw: s.hw, height: s.height };
  }
  var parsed = urlmod.parse(s.url || '');
  // Solo HTTP: con HTTPS, cambiar el nombre por la IP rompe la verificación
  // TLS (el certificado es del dominio, no de la IP).
  if (!/^http:$/i.test(parsed.protocol || '') || !parsed.hostname || /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) {
    return done(s);
  }

  dnsx.resolve(parsed.hostname, function (err, res) {
    var ip = (res && res.ips && res.ips[0]) || '';
    if (!err && ip) {
      var headers = {};
      Object.keys(s.headers || {}).forEach(function (key) {
        if (key.toLowerCase() !== 'host') headers[key] = s.headers[key];
      });
      headers.Host = parsed.host;
      parsed.hostname = ip;
      parsed.host = ip + (parsed.port ? ':' + parsed.port : '');
      parsed.href = null;
      log('CDN resuelto por DoH (' + (res && res.source) + ') para ffmpeg: ' + parsed.hostname + ' -> ' + ip);
      return done({
        url: urlmod.format(parsed),
        headers: headers,
        audio: s.audio,
        hevc: s.hevc,
        hw: s.hw,
        height: s.height
      });
    }

    log('DoH no devolvio IP para ' + parsed.hostname + ' (' + (err && err.message) + '), probando DNS nativo...');
    var lookup;
    try { lookup = spawn('/usr/bin/getent', ['ahostsv4', parsed.hostname]); } catch (eSpawn) { return done(s); }
    var out = '';
    lookup.stdout.on('data', function (chunk) { out += String(chunk); });
    lookup.on('error', function () { done(s); });
    lookup.on('close', function () {
      var match = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(out);
      if (!match) {
        log('DNS nativo no devolvio IPv4; se usa hostname');
        return done(s);
      }
      var headers2 = {};
      Object.keys(s.headers || {}).forEach(function (key) {
        if (key.toLowerCase() !== 'host') headers2[key] = s.headers[key];
      });
      headers2.Host = parsed.host;
      parsed.hostname = match[1];
      parsed.host = match[1] + (parsed.port ? ':' + parsed.port : '');
      parsed.href = null;
      log('CDN resuelto por webOS para ffmpeg');
      done({
        url: urlmod.format(parsed),
        headers: headers2,
        audio: s.audio,
        hevc: s.hevc,
        hw: s.hw,
        height: s.height
      });
    });
  });
}

var server = http.createServer(function (req, res) {
  var u = urlmod.parse(req.url, true);

  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }

  if (u.pathname === '/abort' || u.pathname === '/media/abort') {
    stopCurrent();
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end('aborted');
  }

  var m = /^\/s\/([0-9a-f]+)\.mp4$/.exec(u.pathname || '');
  var s = m && sessions[m[1]];
  if (!s) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'none',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end();
  }

  var start = Math.max(0, Number(u.query.start) || 0);
  var audio = Number(u.query.a != null ? u.query.a : s.audio) || 0;

  stopCurrent();   // el player a veces abre y aborta peticiones; no dejamos procesos huerfanos

  resolveForFfmpeg(s, function (input) {
    function launch(encoder) {
      var ff = spawn(FFMPEG, buildArgs(input, start, audio, encoder), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      current = { ff: ff };
      hwState.last = encoder || 'libx264';
      var started = false, errText = '';

      ff.on('error', function (e) {
        log('no se pudo lanzar ffmpeg:', e.message);
        if (!started) {
          res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
          started = true;
        }
        res.end();
      });

      ff.stderr.on('data', function (d) { var t = String(d).trim(); if (errText.length < 2000) errText += t + '\n'; log('ffmpeg:', t); });

      ff.stdout.on('data', function (chunk) {
        if (!started) {
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'none',
            'Cache-Control': 'no-cache',
            'Connection': 'close',
            'Access-Control-Allow-Origin': '*'
          });
          started = true;
        }
        // backpressure: si el player va lento, ffmpeg deja de leer del portal
        if (!res.write(chunk)) {
          ff.stdout.pause();
          res.once('drain', function () { ff.stdout.resume(); });
        }
      });

      ff.on('close', function (code) {
        if (current && current.ff === ff) current = null;
        /* La gráfica no pudo con este título: repetir con la CPU, una vez.
           Un fallo de red o del enlace (404, sin conexión…) no es culpa de la
           gráfica: se informa tal cual y la gráfica sigue activa. */
        if (!started && encoder && code && !res.finished && !aborted && isEncoderFailure(errText, encoder)) {
          log('el codificador ' + encoder + ' falló (código ' + code + '); se repite con libx264');
          hwState.broken = true;
          return launch('');
        }
        if (!started) {
          res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
          started = true;
        }   // ffmpeg no produjo nada
        res.end();
        if (code) log('ffmpeg termino con codigo', code);
      });
      res.on('close', function () { try { ff.kill('SIGKILL'); } catch (e) { /* ya termino */ } });
    }
    var aborted = false;
    res.on('close', function () { aborted = true; });
    if (!input.hw) { return launch(''); }
    detectHardware(function (hw) { launch(hw.broken ? '' : hw.encoder); });
  });
});

server.on('error', function (e) { log('error del servidor:', e.message); });
server.listen(PORT, HOST, function () { PORT = server.address().port; log('escuchando en', HOST + ':' + PORT); });
/* La prueba de la gráfica corre al arrancar, sin esperar al primer vídeo. */
setTimeout(function () { try { fs.accessSync(FFMPEG); detectHardware(); } catch (eNo) { /* sin FFmpeg */ } }, 1500);

module.exports = {
  register: register,
  stop: stopCurrent,
  available: function () {
    /* A packaged file can exist but lack +x (ares-package on Windows writes
       0666). Report that as unavailable instead of letting spawn() fail later
       and silently falling back to direct playback. */
    try {
      fs.accessSync(FFMPEG, (fs.constants && fs.constants.X_OK) || fs.X_OK || 1);
      return true;
    } catch (eAccess) {
      return false;
    }
  },
  path: function () { return FFMPEG; },
  /* Diagnóstico: qué acelera el Modo fluido en este equipo. */
  info: function (done) {
    detectHardware(function (hw) {
      done({ encoder: hw.encoder, label: hw.label, tried: hw.tried.slice(), broken: hw.broken, last: hw.last });
    });
  },
  port: function () { return PORT; },
  close: function () { stopCurrent(); server.close(); }
};
