/*
 * Magis portal client for the XuperTV webOS port.
 *
 * PROVENANCE
 * ----------
 * Protocol recovered statically from Xuper.apk (4.34.4):
 *   - body crypto: fc/b.java (DESede/ECB/PKCS5) + dc/a.java (base64)
 *   - portal key : AndroidManifest meta-data PORTAL_KEY, decrypted with
 *                  jb/b.java + fc/b.java using the literal in k2/b.java
 *   - endpoints  : classes2.dex strings (/api/portalCore/...)
 *   - constants  : build config (portalCode masnew, apkVer header 43404)
 * Updated 2026-11-12 from NF 6.5.8 native initialization and authorized
 * network diagnostics: runtime key, application identity, version and host.
 * Fresh activation, catalog (270 items) and detail verified from Windows.
 *
 * Supports device activation and explicit account login. Credentials are used
 * only for the requested login; passwords and sessions are not persisted.
 *
 * ES5/CommonJS on purpose: webOS 4 ships an old Node.js inside its services.
 */
'use strict';

var crypto = require('crypto');
var https = require('https');
var http = require('http');
var url = require('url');
var dnsx = require('./dnsx');
var rangerCodec = require('./ranger-protocol').create(liveDigestHex);
var rangerSlb = require('./ranger-slb');
var nfAccountProtocol = require('./nf-protocol');
var timing = require('./timing');

/* --------------------------------------------------------------- constants */
// NF 6.5.8: native initialization -> d5.a.j -> s7.a legacy decoder.
// Both directions verified against a fresh device activation and catalog.
var KEY_HEX = 'e9c7f6e7cf5bfdddb57bfe1f6dfffc6dfdbf777e3adfae1b';
var HOSTS = [
  'oujlkyh.ykdgmofwi.com',
  'ftmrmy.jdfey0cd.com',
  'fuxok.nguvmqhpk.com',
  'eajmnp.hcgv1dt8.com',
  'mptec.dhkrxuzcy.com',
  'hinumz.a878kkoyc.com',
  'krdwvd.swcaw7qx.com',
  'osuhk.m3x8o50te.com',
  'oogoy.f30c96w8.com'
];
var PORTAL_CODE = 'masnew';
var APP_ID = 'com.msandroid.mobile';
var APK_VERSION = '60291';
var SPKG_VER = '10';
var APK_VER_HEADER = '60291';
var USER_AGENT = 'okhttp/3.12.12';
var CONTENT_TYPE = 'application/json;charset=utf-8';
var SNTOKEN_SALT = 'ntFT65w6itH!lHCPw7D=@qnsFC5adD28';
var FIXED_MAC = '02:00:00:00:00:00';
var FIXED_RESERVE1 = '583442714b345572434a4d5769637461545a735936413d3d';
var FIXED_DRM_ID = '0iSGEyv2EqiS/nqI/I3hqdu12irw5Q3/uqrWvRFx9bM=';
var UA_CDN = 'Ranger/4.9.5-ebebe425';
var RANGER_COMMUNICATION_KEY = '6cf2589b-d21e-4fbf-8bf2-d346364b4a42';

var RATE_MS = 450;          // portal pacing (observed safe value)
var REQUEST_TIMEOUT = 20000;
var TREE_TTL = 10 * 60 * 1000;
var SEARCH_TTL = 3 * 60 * 1000;
var SLB_TTL = 5 * 60 * 1000;

var ROOT_CODES = {
  featured: 'masnew_featured',
  movies: 'masnew_movies',
  series: 'masnew_series',
  anime: 'masnew_anime',
  kids: 'masnew_kids',
  free: 'masnew_free'
};

var ROOT_CATEGORY = {
  featured: 'destacado',
  movies: 'pelicula',
  series: 'serie',
  anime: 'anime',
  kids: 'infantil',
  free: 'gratis'
};

var DEVICE_FIXED = {
  loginType: '3', appLanguage: 'en', hardwareInfo: 'ranchu',
  model: 'sdk_gphone64_arm64', product: 'sdk_gphone64_arm64', cpu: 'arm64-v8a',
  B29: '', reserve1: FIXED_RESERVE1, deviceToken: '', drmId: FIXED_DRM_ID, sdkVer: 33
};

var FINGERPRINT_FIXED = {
  board: 'goldfish_arm64', brand: 'google', cpuAbi: 'arm64-v8a', device: 'emu64a',
  diskInfo: '8GB', display: 'sdk_gphone64_arm64',
  fingerprint: 'google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.036/11228894:user/release-keys',
  hardware: 'ranchu', host: 'abfarm', manufacturer: 'Google', ramSize: '4GB',
  romSize: '8GB', tags: 'release-keys', verId: ''
};

/* ------------------------------------------------------------------ crypto */
function bufFrom(value, enc) {
  return Buffer.from ? Buffer.from(value, enc) : new Buffer(value, enc);
}
function bufAlloc(size) {
  if (Buffer.alloc) { return Buffer.alloc(size); }
  var b = new Buffer(size);
  b.fill(0);
  return b;
}

var EMPTY_IV = bufFrom('', 'binary');

function encryptBody(plain) {
  var c = crypto.createCipheriv('des-ede3', bufFrom(KEY_HEX, 'hex'), EMPTY_IV);
  var raw = Buffer.concat([c.update(bufFrom(plain, 'utf8')), c.final()]);
  return bufFrom(raw.toString('base64'), 'ascii').toString('hex');
}

function decryptBlob(wire) {
  var b64 = bufFrom(wire, 'hex').toString('ascii');
  var d = crypto.createDecipheriv('des-ede3', bufFrom(KEY_HEX, 'hex'), EMPTY_IV);
  return Buffer.concat([d.update(bufFrom(b64, 'base64')), d.final()]).toString('utf8');
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/* ----------------------------------------------------------------- helpers */
function text(value) {
  if (value === null || value === undefined) { return ''; }
  return String(value);
}

function trim(value) {
  return text(value).replace(/^\s+|\s+$/g, '');
}

function imageOf(asset, type) {
  var list = asset && asset.posterList;
  if (!list || !list.length) { return ''; }
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].fileType === type && trim(list[i].fileUrl) !== '') {
      return trim(list[i].fileUrl);
    }
  }
  return '';
}

function genresOf(asset) {
  var raw = text(asset && asset.tags);
  if (!raw) { return []; }
  var parts = raw.split(',');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var g = trim(parts[i]);
    if (g) { out.push(g); }
  }
  return out;
}

/* ----------------------------------------------------------------- session */
var session = { sn: '', userId: '', userToken: '', snToken: '', portalCode: '', ready: false, busy: false };
var sessionWaiters = null;
var accountLoginBusy = false;

/* Account session kept between runs.  The host (Electron main) stores the
 * snapshot encrypted and gives it back at start; this module never writes
 * files.  The password is not part of it: only the session the portal issued,
 * the device serial it was issued for and the name shown in "Mi cuenta". */
var accountLabel = '';
var accountRemembered = false;
var accountListener = null;

function notifyAccount() {
  if (!accountListener) { return; }
  try { accountListener(); } catch (_) { /* storing is best effort */ }
}
function setAccountListener(fn) { accountListener = typeof fn === 'function' ? fn : null; }
function setAccountRemembered(on) { accountRemembered = !!on; }

function clearPortalCaches() {
  treeCache = {}; searchCache = {}; itemCache = {}; slbCache = null; audioCache = {};
  liveResolveCache = {}; liveChannelCache = {}; liveCategoriesCache = null;
  liveGeneration++; liveRejectedAt = {};
}

function accountSnapshot() {
  if (!session.ready || !session.accountAuthenticated || !session.userId || !session.userToken) { return null; }
  return {
    v: 1, userId: session.userId, userToken: session.userToken, portalCode: session.portalCode || '',
    sn: session.sn || '', snToken: session.snToken || '', label: accountLabel
  };
}

/* Only before any session exists: a running session is never replaced. */
function restoreAccount(saved) {
  if (!saved || saved.v !== 1 || typeof saved.userId !== 'string' || typeof saved.userToken !== 'string') { return false; }
  if (!trim(saved.userId) || !trim(saved.userToken)) { return false; }
  if (session.ready || sessionWaiters || accountLoginBusy) { return false; }
  session.userId = trim(saved.userId); session.userToken = trim(saved.userToken);
  session.portalCode = trim(saved.portalCode);
  session.sn = trim(saved.sn); session.snToken = trim(saved.snToken);
  session.ready = true; session.accountAuthenticated = true; session.requiresAccountLogin = false;
  accountLabel = text(saved.label).slice(0, 120);
  timing.log('cuenta: sesión restaurada del equipo (sin volver a iniciar sesión)');
  return true;
}

function accountStatus() {
  var authenticated = !!(session.ready && session.accountAuthenticated);
  return {
    authenticated: authenticated,
    account: authenticated ? accountLabel : '',
    expired: !!session.requiresAccountLogin,
    remembered: authenticated && accountRemembered,
    canRemember: accountRemembered
  };
}

/* Local sign-out: the next request activates an anonymous device session. */
function logoutAccount(done) {
  if (accountLoginBusy) { return done(new Error('Hay un inicio de sesión en curso')); }
  session.ready = false; session.accountAuthenticated = false; session.requiresAccountLogin = false;
  session.userId = ''; session.userToken = ''; session.portalCode = ''; session.snToken = '';
  accountLabel = '';
  clearPortalCaches();
  timing.log('cuenta: sesión cerrada desde Mi cuenta; se usará una sesión anónima');
  notifyAccount();
  done(null, { authenticated: false });
}

function loginAccount(credentials, done) {
  if (accountLoginBusy) return done(new Error('Ya hay un inicio de sesión en curso'));
  var bean;
  try { bean = nfAccountProtocol.createLoginBean(credentials, FIXED_MAC); }
  catch (error) { return done(error); }
  var label = bean.userName;
  accountLoginBusy = true;
  function begin() {
    call('v8/login', bean, { baseFields: false }, function (error, user) {
      bean.password = ''; bean.userName = '';
      accountLoginBusy = false;
      if (error) return done(error);
      if (!user || !user.userId || !user.userToken) return done(new Error('El servidor no devolvió una sesión de cuenta'));
      session.userId = trim(user.userId); session.userToken = trim(user.userToken);
      session.portalCode = trim(user.portalCodeList && user.portalCodeList[0] && user.portalCodeList[0].portalCode);
      session.ready = true; session.accountAuthenticated = true; session.requiresAccountLogin = false;
      accountLabel = label;
      clearPortalCaches();
      timing.log('cuenta: sesión iniciada');
      notifyAccount();
      done(null, { authenticated: true });
    });
  }
  // An anonymous activation must settle before login can replace its session.
  if (sessionWaiters) sessionWaiters.push(function () { begin(); });
  else begin();
}
/* Portal request queue.  All requests still go out one at a time with the
 * RATE_MS pacing that keeps the portal from answering 429, but in priority
 * order:
 *   play       - what the viewer is waiting for (resolve a title or channel)
 *   normal     - catalog, detail, login, session
 *   background - language hints for posters ("Sin español"); held while a
 *                playback is being resolved and for PLAY_HOLD_MS afterwards.
 * Measured before this change: a movie waited ~8 s behind nine background
 * startPlayVOD hints before its own request was sent. */
var queues = { play: [], normal: [], background: [] };
var lastCallAt = 0;
var playActive = 0;
var playHoldUntil = 0;
var holdTimer = null;
var PLAY_HOLD_MS = 4000;

function queuedCount() {
  return queues.play.length + queues.normal.length + queues.background.length;
}

function backgroundHeld() {
  return playActive > 0 || Date.now() < playHoldUntil;
}

function enqueue(fn, priority, isStale, onDrop) {
  var name = queues[priority] ? priority : 'normal';
  queues[name].push({ run: fn, stale: isStale, drop: onDrop });
  drain();
}

/* Next request to send.  A superseded playback request (the viewer already
 * asked for something else) is dropped here without using a rate slot. */
function nextItem() {
  var order = ['play', 'normal', 'background'];
  for (var o = 0; o < order.length; o++) {
    var q = queues[order[o]];
    if (order[o] === 'background' && backgroundHeld()) { continue; }
    while (q.length) {
      var item = q.shift();
      if (item.stale && item.stale()) {
        if (item.drop) { setTimeout(item.drop, 0); }
        continue;
      }
      return item;
    }
  }
  return null;
}

function hasRunnable() {
  return queues.play.length > 0 || queues.normal.length > 0 ||
    (queues.background.length > 0 && !backgroundHeld());
}

function scheduleHoldEnd() {
  if (holdTimer || !queues.background.length || playActive > 0) { return; }
  var wait = playHoldUntil - Date.now();
  if (wait <= 0) { return; }
  holdTimer = setTimeout(function () { holdTimer = null; drain(); }, wait + 5);
}

function drain() {
  if (session.busy) { return; }
  if (!hasRunnable()) { scheduleHoldEnd(); return; }
  var wait = lastCallAt + RATE_MS - Date.now();
  if (wait > 0) {
    session.busy = true;
    setTimeout(function () { session.busy = false; drain(); }, wait);
    return;
  }
  var item = nextItem();
  if (!item) { scheduleHoldEnd(); return; }
  session.busy = true;
  lastCallAt = Date.now();
  item.run(function () {
    session.busy = false;
    drain();
  });
}

/* A playback request starts: background hints wait, and an older playback of
 * the same kind that is still queued is superseded ("latest wins"). */
var playGeneration = { vod: 0, live: 0 };
function beginPlayback(kind) {
  playGeneration[kind] = (playGeneration[kind] || 0) + 1;
  playActive++;
  var ticket = { kind: kind, gen: playGeneration[kind], ended: false };
  ticket.opts = { priority: 'play', play: ticket };
  return ticket;
}
function endPlayback(ticket) {
  if (!ticket || ticket.ended) { return; }
  ticket.ended = true;
  playActive = Math.max(0, playActive - 1);
  playHoldUntil = Math.max(playHoldUntil, Date.now() + PLAY_HOLD_MS);
  drain();
}
function ticketStale(ticket) {
  return !!ticket && ticket.gen !== playGeneration[ticket.kind];
}
function supersededError() {
  var err = new Error('Reproducción reemplazada por otra más reciente');
  err.superseded = true;
  return err;
}

function deviceDict() {
  var d = {};
  for (var k in DEVICE_FIXED) {
    if (Object.prototype.hasOwnProperty.call(DEVICE_FIXED, k)) { d[k] = DEVICE_FIXED[k]; }
  }
  d.apkVersion = APK_VERSION;
  d.sysVersion = SPKG_VER;
  d.appId = APP_ID;
  d.sn = session.sn;
  return d;
}

function post(path, body, done) {
  var origDone = done;
  var settled = false;
  done = function (err, result) {
    if (settled) { return; }
    settled = true;
    clearTimeout(deadline);
    origDone(err, result, { server: attempt + 1 });
  };
  var deadline = setTimeout(function () {
    done(new Error(path + ': el portal no respondió dentro de 25 segundos'));
  }, 25000);
  var payload;
  try {
    payload = encryptBody(JSON.stringify(body));
  } catch (encErr) {
    return done(new Error(path + ': error cifrando cuerpo: ' + encErr.message));
  }
  var host = HOSTS[0];
  var attempt = 0;

  function nextHost(err) {
    if (settled) { return; }
    attempt++;
    if (attempt < HOSTS.length) {
      host = HOSTS[attempt];
      setup();
      return;
    }
    done(err);
  }

  function setup() {
    if (settled) { return; }
    /* The portal hostname is resolved over DoH so an ISP that poisons its DNS
       cannot stop the catalogue.  TLS SNI and the HTTP Host header keep the
       original name. */
    var baseOptions = {
      hostname: host,
      servername: host,
      rejectUnauthorized: true,
      path: '/api/portalCore/' + path,
      method: 'POST',
      headers: {
        apk: APP_ID,
        apkVer: APK_VER_HEADER,
        spkgVer: SPKG_VER,
        'User-Agent': USER_AGENT,
        'Content-Type': CONTENT_TYPE,
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    dnsx.prepare(baseOptions, function (prepErr, options) {
      if (settled) { return; }
      if (prepErr) { return nextHost(prepErr); }

      var req = https.request(options, function (res) {
        var chunks = [];
        if (res.statusCode === 429) {
          res.resume();
          return done(rateLimitError(path));
        }
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          var raw = Buffer.concat(chunks).toString('utf8');
          var answer;
          try {
            answer = JSON.parse(raw);
          } catch (e) {
            return done(new Error(path + ': respuesta no JSON (' + res.statusCode + ')'));
          }
          var code = answer.returnCode === undefined || answer.returnCode === null ? '' : String(answer.returnCode);
          if (code !== '' && code !== '0') {
            var portalMsg = text(answer.errorMessage);
            var err = portalError(path, code, portalMsg);
            return done(err);
          }
          if (typeof answer.data === 'string' && answer.data !== '') {
            var plain;
            try {
              plain = decryptBlob(answer.data);
            } catch (e2) {
              return done(new Error(path + ': no se pudo descifrar la respuesta (' + e2.message + ')'));
            }
            try {
              return done(null, JSON.parse(plain));
            } catch (e3) {
              return done(new Error(path + ': respuesta descifrada no JSON'));
            }
          }
          done(null, answer.data !== undefined && answer.data !== null ? answer.data : answer);
        });
      });

      req.setTimeout(REQUEST_TIMEOUT, function () {
        req.abort();
      });
      req.on('timeout', function () {
        req.abort();
      });
      req.on('error', function (e) { nextHost(e); });
      req.write(payload);
      req.end();
    });
  }

  setup();
}

/* The portal refuses some countries by IP (portal100024, "所在区域为黑名单").
   Show it in plain Spanish and stop retrying the activation for a while. */
var REGION_BLOCK_TEXT = 'El servicio no está disponible en tu región (bloqueo por país). ' +
  'Prueba con una VPN de Latinoamérica, por ejemplo Perú o México.';
var REGION_BLOCK_RETRY_MS = 5 * 60 * 1000;
var regionBlockedUntil = 0;
function isRegionBlock(code, message) {
  return code === 'portal100024' || /黑名单|区域/.test(message || '');
}
function regionBlockError(detail) {
  var err = new Error(REGION_BLOCK_TEXT);
  err.regionBlocked = true;
  err.portalDetail = detail;
  return err;
}

function portalError(path, code, message) {
  var detail = path + ' -> ' + code + ' ' + message;
  var err;
  if (code === 'portal200001') {
    err = new Error('El servidor ha dejado de aceptar la versión de aplicación enviada por Desktop (' +
      code + ', ' + path + '). No se pudo iniciar la sesión del dispositivo.');
    err.versionRejected = true;
  } else {
    err = isRegionBlock(code, message) ? regionBlockError(detail) : new Error(detail);
  }
  err.portalCode = code;
  err.portalDetail = detail;
  err.portalRoute = path;
  return err;
}

function rateLimitError(path) {
  var err = new Error('El servidor limita temporalmente las solicitudes (HTTP 429, ' +
    path + '). Esta respuesta no permite verificar la cuenta. Espera antes de volver a intentar.');
  err.httpStatus = 429;
  err.portalRoute = path;
  return err;
}

function call(path, bean, opts, done) {
  if (typeof opts === 'function') { done = opts; opts = {}; }
  opts = opts || {};
  var tQueued = Date.now();
  var queuedBehind = queuedCount() + (session.busy ? 1 : 0);
  var ticket = opts.play || null;
  var staleCheck = ticket ? function () { return ticketStale(ticket); } : null;
  var onDrop = function () {
    timing.log('portal ' + path + ' | descartada sin enviar: el usuario ya pidió otra reproducción');
    done(supersededError());
  };
  enqueue(function (release) {
    var tStart = Date.now();
    var body = {};
    var k;
    if (opts.baseFields !== false) {
      body.portalCode = session.portalCode || PORTAL_CODE;
      body.userId = session.userId;
      body.userToken = session.userToken;
    }
    var dev = deviceDict();
    for (k in dev) {
      if (Object.prototype.hasOwnProperty.call(dev, k)) { body[k] = dev[k]; }
    }
    for (k in bean) {
      if (Object.prototype.hasOwnProperty.call(bean, k)) { body[k] = bean[k]; }
    }
    post(path, body, function (err, data, meta) {
      release();
      timing.log('portal ' + path + ' | cola=' + (tStart - tQueued) + 'ms (detrás de ' + queuedBehind +
        ') | red=' + (Date.now() - tStart) + 'ms | servidor=#' + ((meta && meta.server) || '?') +
        ' → ' + (err ? 'ERROR: ' + timing.safeError(err) : 'ok'));
      // Si el portal rechaza con aaa100028 (no iniciado sesión / token caducado), renovamos la sesión automáticamente
      if (opts.baseFields !== false && err && err.portalCode === 'aaa100028' && !opts._sessionRetried) {
        if (session.accountAuthenticated || session.requiresAccountLogin) {
          session.ready = false; session.accountAuthenticated = false; session.requiresAccountLogin = true;
          session.userId = ''; session.userToken = ''; slbCache = null;
          liveResolveCache = {};
          accountLabel = '';
          timing.log('cuenta: el servidor rechazó la sesión de cuenta (' + path + ', aaa100028); hay que volver a iniciar sesión');
          notifyAccount();   // the stored copy is no longer valid either
          return done(new Error('Tu sesión de cuenta venció. Inicia sesión en Ajustes → Mi cuenta.'));
        }
        console.log('[magis] sesión no iniciada (' + (err.portalCode || err.message) + '). Renovando sesión limpia...');
        session.ready = false;
        session.userId = '';
        session.userToken = '';
        session.snToken = '';
        return ensureSession(function (errSess) {
          if (errSess) { return done(err); }
          opts._sessionRetried = true;
          call(path, bean, opts, done);
        });
      }
      done(err, data);
    });
  }, opts.priority, staleCheck, onDrop);
}

function ensureSession(done) {
  if (session.requiresAccountLogin) return done(new Error('Inicia sesión en Ajustes → Mi cuenta.'));
  if (session.ready && session.userId && session.userToken) { return done(null, session); }
  if (regionBlockedUntil > Date.now()) { return done(regionBlockError('bloqueo de región recordado')); }
  if (sessionWaiters) { sessionWaiters.push(done); return; }
  sessionWaiters = [done];
  session.ready = false;
  var tSession = Date.now();
  timing.log('sesión: no había sesión lista, iniciando activación/renovación');
  var finished = false;
  var timer = setTimeout(function () {
    finish(new Error('La activación del dispositivo no respondió dentro de 25 segundos'));
  }, 25000);
  function finish(err) {
    if (finished) { return; }
    finished = true;
    clearTimeout(timer);
    timing.log('sesión: terminada en ' + (Date.now() - tSession) + 'ms → ' + (err ? 'ERROR: ' + timing.safeError(err) : 'ok'));
    var waiting = sessionWaiters;
    sessionWaiters = null;
    if (err && err.regionBlocked) {
      regionBlockedUntil = Date.now() + REGION_BLOCK_RETRY_MS;
      console.log('[magis] ' + (err.portalDetail || err.message));
    }
    if (err) {
      session.ready = false;
      session.userId = '';
      session.userToken = '';
      session.portalCode = '';
      session.accountAuthenticated = false;
      session.snToken = '';
    }
    for (var i = 0; i < waiting.length; i++) { waiting[i](err, err ? undefined : session); }
  }
  var fp = {};
  var k;
  for (k in FINGERPRINT_FIXED) {
    if (Object.prototype.hasOwnProperty.call(FINGERPRINT_FIXED, k)) { fp[k] = FINGERPRINT_FIXED[k]; }
  }
  fp.androidId = randomHex(8);
  fp.cpuId = randomHex(8);
  fp.serialNumber = randomHex(8);
  fp.etheMac = randomHex(6).replace(/(..)(?=.)/g, '$1:');
  fp.gatewayMac = randomHex(6).replace(/(..)(?=.)/g, '$1:');
  fp.wifiMac = randomHex(6).replace(/(..)(?=.)/g, '$1:');

  call('v3/snToken', fp, { baseFields: false }, function (err, mint) {
    if (finished) { return; }
    if (err) { return finish(err); }
    var snToken = trim(mint && mint.snToken);
    if (!snToken) { return finish(new Error('el portal no devolvió snToken')); }
    var sn = mint && trim(mint.sn);
    if (!sn) {
      sn = crypto.createHash('md5').update(snToken + SNTOKEN_SALT).digest('hex');
    }
    session.snToken = snToken;
    session.sn = String(sn).toLowerCase();

    call('v8/active', {
      snToken: snToken, authVersion: '', authCode: '', preCode: '', macAddr: FIXED_MAC,
      reserve1: '', openNum: 4, channel: 'default', matadata: '', signdata: ''
    }, { baseFields: false }, function (err2, active) {
      if (finished) { return; }
      if (err2) { return finish(err2); }
      session.userId = trim(active && active.userId);
      session.userToken = trim(active && active.userToken);
      // NF selects the first portal assigned by the server after activation.
      // Catalog routes may tolerate an obsolete code; startPlayVOD does not.
      var assignedPortals = active && active.portalCodeList;
      session.portalCode = assignedPortals && assignedPortals.length
        ? trim(assignedPortals[0] && assignedPortals[0].portalCode) : '';
      if (!session.userId || !session.userToken) { return finish(new Error('el portal no activó el dispositivo')); }
      session.ready = true;
      session.accountAuthenticated = false;
      slbCache = null;
      finish(null);
    });
  });
}

/* ------------------------------------------------------------ normalizers */
function itemFromAsset(asset, category, kind) {
  if (!asset || trim(asset.contentId) === '') { return null; }
  var type = trim(asset.programType) || 'movie';
  var isSeries = type === 'teleplay' || type === 'series' || (asset.volumnCount && parseInt(asset.volumnCount, 10) > 1);
  return {
    id: trim(asset.contentId),
    title: text(asset.name || asset.title),
    category: category || '',
    kind: kind || (isSeries ? 'serie' : 'película'),
    score: asset.score === undefined || asset.score === null || asset.score === '' ? '—' : text(asset.score),
    year: trim(asset.releaseTime || asset.releaseDate) ? trim(asset.releaseTime || asset.releaseDate).slice(0, 4) : '—',
    duration: text(asset.duration),
    genres: genresOf(asset),
    director: text(asset.director),
    actors: text(asset.actorDisplay || asset.actors),
    synopsis: text(asset.description || asset.synopsis),
    poster: imageOf(asset, 'icon') || imageOf(asset, 'poster'),
    landscape: imageOf(asset, 'poster') || imageOf(asset, 'stage'),
    backdrop: imageOf(asset, 'stage') || imageOf(asset, 'poster'),
    type: isSeries ? 'teleplay' : type,
    alias: text(asset.alias),
    country: trim(asset.originalCountry || asset.country),
    releaseDate: trim(asset.releaseTime || asset.releaseDate),
    tagline: trim(asset.viewPoint || asset.tagline),
    volumeCount: asset.volumnCount === undefined || asset.volumnCount === null ? (parseInt(asset.volumeCount, 10) || 0) : parseInt(asset.volumnCount, 10) || 0,
    updateCount: asset.updateCount === undefined || asset.updateCount === null ? 0 : parseInt(asset.updateCount, 10) || 0,
    moreAudio: asset.moreAudio !== undefined ? asset.moreAudio : 0,
    moreSubtitle: asset.moreSubtitle !== undefined ? asset.moreSubtitle : 0,
    row: '',
    shelveTime: trim(asset.shelveTime),
    streamUrl: '',
    portal: true
  };
}

/* ------------------------------------------------------------------- cache */
var treeCache = {};    // rootKey -> { at, rows }
var itemCache = {};    // contentId -> item (full, with synopsis)
var searchCache = {};  // q -> { at, items }
var slbCache = null;

function remember(item) {
  if (item && item.id) { itemCache[item.id] = item; }
}

function itemsFromTree(tree, rootKey) {
  var rows = tree && tree.recommendList;
  var out = [];
  var category = ROOT_CATEGORY[rootKey] || '';
  if (!rows || !rows.length) { return out; }
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var assets = row && row.assetList;
    if (!assets || !assets.length) { continue; }
    for (var a = 0; a < assets.length; a++) {
      var item = itemFromAsset(assets[a], category, null);
      if (!item) { continue; }
      item.row = text(row.name);
      if (rootKey === 'free' && /free\.kids/i.test(item.row) && item.category.indexOf('infantil') === -1) {
        item.category += ',infantil';
      }
      out.push(item);
      remember(item);
    }
  }
  return out;
}

/* -------------------------------------------------------------- public API */
function home(rootKey, done) {
  rootKey = ROOT_CODES[rootKey] ? rootKey : 'movies';
  var cached = treeCache[rootKey];
  if (cached && Date.now() - cached.at < TREE_TTL) {
    return done(null, { root: rootKey, items: cached.items, cached: true });
  }
  ensureSession(function (err) {
    if (err) { return done(err); }
    call('getNextColumns', {
      columnCode: ROOT_CODES[rootKey], pageNum: 1, pageSize: 60, version: ''
    }, function (err2, tree) {
      if (err2) { return done(err2); }
      var items = itemsFromTree(tree, rootKey);
      treeCache[rootKey] = { at: Date.now(), items: items };
      done(null, { root: rootKey, items: items, cached: false });
    });
  });
}

/* search(value, [{ pageNum, pageSize }], done). The portal pages its results
   and reports the real total (often well over the first 20). */
function search(value, opts, done) {
  if (typeof opts === 'function') { done = opts; opts = {}; }
  opts = opts || {};
  var pageNum = Math.max(1, parseInt(opts.pageNum, 10) || 1);
  var pageSize = Math.max(1, Math.min(100, parseInt(opts.pageSize, 10) || 20));
  var q = trim(value);
  if (!q) { return done(null, { items: [], total: 0 }); }
  var key = q.toLowerCase() + '|' + pageNum + '|' + pageSize;
  var cached = searchCache[key];
  if (cached && Date.now() - cached.at < SEARCH_TTL) {
    return done(null, { items: cached.items, total: cached.total, pageNum: pageNum, pageSize: pageSize, cached: true });
  }
  ensureSession(function (err) {
    if (err) { return done(err); }
    call('v3/searchByName', {
      value: q, type: '0', columnId: '', filter: '', pageNum: pageNum, pageSize: pageSize
    }, function (err2, answer) {
      if (err2) { return done(err2); }
      var groups = answer && answer.searchItemList;
      var out = [];
      var seen = {};
      if (groups && groups.length) {
        for (var g = 0; g < groups.length; g++) {
          var list = groups[g] && groups[g].itemList;
          if (!list || !list.length) { continue; }
          for (var i = 0; i < list.length; i++) {
            var item = itemFromAsset(list[i], '', null);
            if (!item || seen[item.id]) { continue; }
            seen[item.id] = true;
            out.push(item);
            remember(item);
          }
        }
      }
      var total = (answer && parseInt(answer.totalSize, 10)) || out.length;
      searchCache[key] = { at: Date.now(), items: out, total: total };
      done(null, { items: out, total: total, pageNum: pageNum, pageSize: pageSize, cached: false });
    });
  });
}

function detail(contentId, done, opts) {
  var id = trim(contentId);
  if (!id) { return done(new Error('falta contentId')); }
  opts = opts || {};
  ensureSession(function (err) {
    if (err) { return done(err); }
    call('v4/getItemData', {
      contentId: id, type: '0', sortType: '0', language: 'en', macAddr: FIXED_MAC
    }, function (err2, answer) {
      var cached = itemCache[id] || null;
      if (err2) {
        /* Movies answer portal100006 ("episode does not exist"): the catalog
           record already carries director/cast/synopsis/tags. */
        if (err2.portalCode === 'portal100006' && cached) {
          return done(null, { item: cached, episodes: [], seasons: [] });
        }
        /* Opened from History right after start: the record is not in memory
           yet. Look the title up by name to recover its catalog data; a movie
           without it still opens (it plays with startPlayVOD). */
        if (err2.portalCode === 'portal100006') {
          var minimal = { item: { id: id, title: trim(opts.title), portal: true }, episodes: [], seasons: [] };
          var name = trim(opts.title);
          if (!name) { return done(null, minimal); }
          return search(name, { pageSize: 50 }, function () {
            var found = itemCache[id];
            done(null, found ? { item: found, episodes: [], seasons: [] } : minimal);
          });
        }
        return done(err2);
      }
      var data = answer && answer.assetData;
      if (!data) {
        return cached ? done(null, { item: cached, episodes: [], seasons: [] })
                      : done(new Error('el portal no devolvió datos del título'));
      }
      var item = itemFromAsset(data, cached ? cached.category : '', null);
      if (cached) {
        /* keep the row/alias context learned from the tree */
        item.row = cached.row;
        item.category = cached.category;
      }
      remember(item);

      var episodes = [];
      var list = data.simpleProgramList;
      if (list && list.length) {
        for (var i = 0; i < list.length; i++) {
          var e = list[i];
          if (!e) { continue; }
          episodes.push({
            id: trim(e.contentId),
            title: text(e.name),
            name: text(e.name),
            number: e.seriesNumber === undefined || e.seriesNumber === null ? i + 1 : e.seriesNumber,
            duration: text(e.duration),
            quality: text(e.quality),
            /* Optional artwork/synopsis used by the episode browser when the
               portal sends them; the list falls back to number+title. */
            picture: text(e.picture || e.pic || e.image || e.cover || e.posterUrl || e.poster),
            description: text(e.description || e.desc || e.synopsis || e.shortDescription || e.introduce)
          });
        }
      }
      var seasons = [];
      var sl = data.sameSeasonSeriesList;
      if (sl && sl.length) {
        for (var s = 0; s < sl.length; s++) {
          if (sl[s] && trim(sl[s].contentId)) {
            seasons.push({ id: trim(sl[s].contentId), number: sl[s].seasonNumber });
          }
        }
      }
      done(null, { item: item, episodes: episodes, seasons: seasons });
    });
  });
}

/* ------------------------------------------------------------------- play */
function slbBean() {
  return {
    hasPay: '0', userIdentity: '1', type: 'merge', appVer: APK_VERSION, lang: 'es',
    encMediaSupported: 1, liveCodeList: ['masnew_live'], appParams: '',
    reserve1: FIXED_RESERVE1, pipFlag: '0'
  };
}

function isCfl(url) {
  var q = url.slice(url.lastIndexOf('?') + 1).split('&');
  for (var i = 0; i < q.length; i++) {
    if (trim(q[i]) === 'sign_type=cfl') { return true; }
  }
  return false;
}

function withScheme(addr) {
  var clean = trim(addr).replace(/\/+$/, '');
  clean = clean.replace(/^http:\/\//i, 'https://');
  return /^https:\/\//.test(clean) ? clean : 'https://' + clean;
}

function vodCdns(slb) {
  var out = [];
  var list = slb && slb.cdn_list;
  if (!list || !list.length) { return out; }
  for (var i = 0; i < list.length; i++) {
    var cdn = list[i];
    if (!cdn || trim(cdn.tag) !== 'vod') { continue; }
    var urls = cdn.url_list || [];
    for (var u = 0; u < urls.length; u++) {
      var entry = urls[u];
      var url = trim(entry && entry.url);
      if ((isCfl(url) || trim(entry && entry.sign_type) === 'cfl') && trim(entry && entry.tag) === 'free') {
        var bases = [withScheme(cdn.main_addr)];
        var spare = trim(cdn.spared_addr);
        if (spare && bases.indexOf(withScheme(spare)) === -1) { bases.push(withScheme(spare)); }
        out.push({ bases: bases, auth: url });
        break;
      }
    }
  }
  // Secondary fallback: if no CacheFly CDN found, accept any free VOD CDN
  if (!out.length) {
    for (var j = 0; j < list.length; j++) {
      var cdn2 = list[j];
      if (!cdn2 || trim(cdn2.tag) !== 'vod') { continue; }
      var urls2 = cdn2.url_list || [];
      for (var u2 = 0; u2 < urls2.length; u2++) {
        var entry2 = urls2[u2];
        var url2 = trim(entry2 && entry2.url);
        if (url2 && (trim(entry2 && entry2.tag) === 'free' || url2.indexOf('tag=free') !== -1)) {
          var bases2 = [withScheme(cdn2.main_addr)];
          var spare2 = trim(cdn2.spared_addr);
          if (spare2 && bases2.indexOf(withScheme(spare2)) === -1) { bases2.push(withScheme(spare2)); }
          out.push({ bases: bases2, auth: url2 });
          break;
        }
      }
    }
  }
  return out;
}

function getSlb(done, opts) {
  if (slbCache && Date.now() < slbCache.at + SLB_TTL) { return done(null, slbCache.slb); }
  firstCall([
    { path: 'v15/getSlbInfo', bean: slbBean(), opts: opts },
    { path: 'v14/getSlbInfo', bean: slbBean(), opts: opts }
  ], function (err, slb) {
    if (err) { return done(err); }
    if (!vodCdns(slb).length) { return done(new Error('el portal no expuso CDN de vod libre')); }
    slbCache = { at: Date.now(), slb: slb };
    done(null, slb);
  });
}

function vodSlbCdns(slb) {
  var list = (slb && slb.cdn_list) || [];
  return list.filter(function (cdn) {
    return cdn && cdn.tag === 'vod' && String(cdn.cdn_type) === '1' && trim(cdn.main_addr) &&
      (cdn.url_list || []).some(function (entry) { return entry && entry.tag === 'free' && trim(entry.url); });
  });
}

function lookupVodSlb(slb, tracks, selected, done) {
  var cdns = vodSlbCdns(slb);
  var index = 0;
  function next(lastError) {
    if (index >= cdns.length) return done(lastError || new Error('SLB no devolvió servidores de vídeo'));
    var cdn = cdns[index++];
    var auth = cdn.url_list.filter(function (entry) { return entry && entry.tag === 'free' && trim(entry.url); })[0].url;
    var batch = [selected].concat(tracks.filter(function (track) { return track !== selected; })).slice(0, 8);
    var entries = batch.map(function (track) {
      return { auth: auth, license: trim((track.licenseList && track.licenseList[0] && track.licenseList[0].license) || ''), media_code: trim(track.contentId) };
    }).filter(function (entry) { return entry.license && entry.media_code; });
    rangerSlb.lookup({ address: cdn.main_addr, codec: rangerCodec, communicationKey: RANGER_COMMUNICATION_KEY,
      entries: entries, app: APP_ID, version: APK_VERSION, userAgent: UA_CDN }, function (error, result) {
      if (error) {
        if (error.httpStatus === 429) return done(error);
        return next(error);
      }
      var info = ((result && result.play_infos) || []).filter(function (item) { return item && item.media_code === trim(selected.contentId); })[0];
      var servers = ((info && info.servers) || []).filter(function (server) {
        return server && /^https?:\/\//i.test(trim(server.media_url));
      });
      if (!servers.length) return next(new Error('SLB no autorizó la pista seleccionada'));
      done(null, { url: servers[0].media_url, backupUrls: servers.slice(1).map(function (server) { return server.media_url; }), format: info.media_format });
    });
  }
  next(null);
}

/* webOS 4 has hardware decode limits that are much lower than Android IjkPlayer.
 * The portal may return several files for the same episode but does not promise
 * that the first one is playable smoothly on a 2019 LG. Prefer an ordinary
 * H.264/MP4 rendition and reject high-frame-rate, UHD and very high bitrate
 * variants when a compatible alternative is present. */
function fieldNumber(value) {
  var match = text(value).match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

function trackHeight(track) {
  var direct = fieldNumber(track && (track.videoHeight || track.height || track.pixelHeight));
  if (direct) { return direct; }
  var label = text(track && (track.resolution || track.videoResolution || track.quality)).toLowerCase();
  var byDimensions = label.match(/\d{3,4}\s*[x×]\s*(\d{3,4})/);
  if (byDimensions) { return parseInt(byDimensions[1], 10); }
  /* Portal labels look like "720p"; \b720\b never matched them. */
  var byLines = label.match(/(\d{3,4})\s*[pi]\b/);
  if (byLines) { return parseInt(byLines[1], 10); }
  if (/\b(4k|uhd|2160)\b/.test(label)) { return 2160; }
  if (/\b1440\b/.test(label)) { return 1440; }
  if (/\b1080\b|\bfhd\b/.test(label)) { return 1080; }
  if (/\b720\b|\bhd\b/.test(label)) { return 720; }
  if (/\b480\b|\bsd\b/.test(label)) { return 480; }
  return 0;
}

function trackBitrateKbps(track) {
  var raw = track && (track.videoBitrate || track.videoBitRate || track.bitrate || track.bitRate || track.rate || '');
  var value = fieldNumber(raw);
  var label = text(raw).toLowerCase();
  if (/mbps|m\b/.test(label)) { return value * 1000; }
  /* Portal values without a suffix are normally bits per second. */
  return value > 10000 ? value / 1000 : value;
}

function trackFrameRate(track) {
  return fieldNumber(track && (track.frameRate || track.fps || track.videoFps));
}

function trackSummary(track) {
  return {
    codec: trim(track && track.encodeFormat).toUpperCase(),
    format: trim(track && track.videoFormat).toLowerCase(),
    quality: trim(track && track.quality),
    height: trackHeight(track),
    bitrateKbps: trackBitrateKbps(track),
    frameRate: trackFrameRate(track)
  };
}

var durationSeconds = require('./media-duration').seconds;

function mediaScore(track) {
  var rawEnc = trim(track && track.encodeFormat).toLowerCase().replace(/[^a-z0-9]/g, '');
  var fmt = trim(track && track.videoFormat).toLowerCase();
  var isH264 = (rawEnc.indexOf('h264') !== -1 || rawEnc.indexOf('avc') !== -1);
  var isHevc = (rawEnc.indexOf('h265') !== -1 || rawEnc.indexOf('hevc') !== -1);
  var isMp4 = (fmt === 'mp4');
  var summary = trackSummary(track);

  var score = 0;
  if (isH264) {
    score += 0;
  } else if (isHevc) {
    score += 80;
  } else {
    score += 160;
  }
  if (/av1|vp9|10bit|hdr/.test(rawEnc)) { score += 500; }
  /* On webOS 4 the HTML5 MPEG-TS demuxer can keep the media clock moving
     while presenting uneven frames (even with a full network buffer).  The
     portal normally exposes the same VOD rendition as MP4, whose timestamps
     are handled by the native player reliably.  Make MP4 a true preference;
     TS remains the fallback only when no MP4 track is supplied. */
  if (!isMp4) { score += 2000; }
  /* Paso B (temporary experiment, only with XUPER_PREFER_TS=1): prefer the
     TS/HEVC rendition, which has no large MP4 index to download first. */
  if (process.env.XUPER_PREFER_TS === '1' && fmt === 'ts') { score -= 5000; }
  if (summary.height > 1080) { score += 500 + summary.height; }
  if (summary.frameRate > 30) { score += 300 + summary.frameRate; }
  if (summary.bitrateKbps > 9000) { score += 250; }
  else if (summary.bitrateKbps > 6500) { score += 80; }
  return score;
}

function collectTracks(episode) {
  var tracks = [];
  var totals = (episode && episode.totalMovieList) || [];
  for (var t = 0; t < totals.length; t++) {
    var movies = (totals[t] && totals[t].movieList) || [];
    for (var m = 0; m < movies.length; m++) {
      if (movies[m] && trim(movies[m].contentId)) { tracks.push(movies[m]); }
    }
  }
  tracks.sort(function (a, b) { return mediaScore(a) - mediaScore(b); });
  return tracks;
}

function subtitleList(episode) {
  var out = [];
  var subs = (episode && episode.subtitleList) || [];
  for (var s = 0; s < subs.length && out.length < 30; s++) {
    var file = subs[s] && subs[s].file && subs[s].file[0];
    if (!file || !trim(file.url)) { continue; }
    out.push({
      lang: trim(subs[s].language),
      url: trim(file.url),
      format: trim(file.fileType) || 'srt'
    });
  }
  return out;
}

/* Shared startPlayVOD step: both the playback resolver and the media-info
 * call need the same episode/track list. */
function loadPlay(contentId, seriesId, done, opts) {
  var id = trim(contentId);
  if (!id) { return done(new Error('falta contentId')); }
  ensureSession(function (err) {
    if (err) { return done(err); }
    call('v10/startPlayVOD', {
      contentId: id,
      seriesContentId: trim(seriesId),
      startTime: 0, type: '1', columnId: 0, authType: ''
    }, opts || {}, function (err2, play) {
      if (err2) { return done(err2); }
      var episode = play && play.episodeList && play.episodeList[0];
      if (!episode) { return done(new Error('el portal no devolvió pistas de vídeo')); }
      var tracks = collectTracks(episode);
      if (!tracks.length) { return done(new Error('el portal no devolvió pistas de vídeo')); }
      done(null, { play: play, episode: episode, tracks: tracks });
    });
  });
}

/* Language list and subtitle files for the audio/subtitle dialog.  It
 * deliberately exposes no playable URL, license or request headers, so the
 * page can call it from the detail screen before playback starts. */
function mediaInfo(contentId, seriesId, done) {
  loadPlay(contentId, seriesId, function (err, info) {
    if (err) { return done(err); }
    var track = info.tracks[0];
    done(null, {
      name: text(info.play && info.play.name),
      audio: trim(track.audioInfo),
      subtitles: subtitleList(info.episode),
      tracks: info.tracks.map(trackSummary),
      selected: trackSummary(track),
      duration: durationSeconds(track.duration || info.episode.duration || (info.play && info.play.duration))
    });
  });
}

/* Audio and subtitle languages of a title without starting playback:
 * { audio: "por,spa,eng", subs: "es,en" }.  Series answer in getItemData
 * (audioInfo / subsInfo); movies (portal100006 there) only expose them in
 * startPlayVOD, so a title known to be a movie goes there directly (one call
 * instead of two).  Cached for the session. */
var audioCache = {};
function langList(values) {
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var code = trim(values[i]).toLowerCase();
    if (code && out.indexOf(code) === -1) { out.push(code); }
  }
  return out.join(',');
}
function audioInfo(contentId, opts, done) {
  if (typeof opts === 'function') { done = opts; opts = {}; }
  opts = opts || {};
  var id = trim(contentId);
  if (!id) { return done(new Error('falta contentId')); }
  if (audioCache[id] !== undefined) { return done(null, audioCache[id]); }
  /* Poster language hints ("Sin español"): never ahead of a playback. */
  var background = { priority: 'background' };
  function fromPlay(onFail) {
    loadPlay(id, '', function (err3, info) {
      if (err3) { return onFail ? onFail() : done(err3); }
      var langs = { audio: trim(info.tracks[0] && info.tracks[0].audioInfo),
        subs: langList(subtitleList(info.episode).map(function (s) { return s.lang; })) };
      audioCache[id] = langs;
      done(null, langs);
    }, background);
  }
  ensureSession(function (err) {
    if (err) { return done(err); }
    if (opts.movie) { return fromPlay(fromItemData); }
    fromItemData();
  });
  function fromItemData() {
    call('v4/getItemData', {
      contentId: id, type: '0', sortType: '0', language: 'en', macAddr: FIXED_MAC
    }, background, function (err2, answer) {
      var asset = !err2 && answer && answer.assetData;
      var fromItem = asset && trim(asset.audioInfo);
      if (fromItem) {
        var langs = { audio: fromItem, subs: langList(String(asset.subsInfo || '').split(',')) };
        audioCache[id] = langs;
        return done(null, langs);
      }
      /* A wrong "movie" hint lands here after startPlayVOD already failed. */
      if (opts.movie) { return done(err2 || new Error('sin datos de idioma')); }
      fromPlay();
    });
  }
}

function resolve(contentId, seriesId, options, done) {
  if (typeof options === 'function') { done = options; options = {}; }
  options = options || {};
  var tr = timing.trace('película/serie', 'contenido=' + trim(contentId));
  var ticket = beginPlayback('vod');
  var resolveDone = done;
  done = function (err, stream) {
    endPlayback(ticket);
    tr.end(err ? (err.superseded ? 'descartada (el usuario pidió otra reproducción)' : 'ERROR: ' + timing.safeError(err)) : 'ok');
    resolveDone(err, stream);
  };
  loadPlay(contentId, seriesId, function (err, info) {
    tr.mark('sesión+startPlayVOD');
    if (err) { return done(err); }
    var play = info.play;
    var episode = info.episode;
    var tracks = info.tracks;
    var index = parseInt(options.trackIndex, 10);
    if (!(index >= 0 && index < tracks.length)) { index = 0; }
    /* Quality chosen by the viewer (lines, e.g. 720). Without an exact match
       use the closest lower one; 0 keeps the automatic choice. */
    var preferHeight = parseInt(options.preferHeight, 10) || 0;
    if (preferHeight > 0 && !(parseInt(options.trackIndex, 10) > 0)) {
      var best = -1, bestHeight = 0;
      for (var q = 0; q < tracks.length; q++) {
        var h = trackHeight(tracks[q]);
        if (h === preferHeight) { best = q; break; }
        if (h && h < preferHeight && h > bestHeight) { best = q; bestHeight = h; }
      }
      if (best >= 0) { index = best; }
    }
    var track = tracks[index];
    /* Playback diagnostics deliberately contain only rendition metadata.
       They let us distinguish a TS-only title from a bad selector without
       exposing a playable URL, license, or request headers to the page. */
    var availableTracks = [];
    for (var a = 0; a < tracks.length; a++) {
      availableTracks.push(trackSummary(tracks[a]));
    }
    var license = trim((track.licenseList && track.licenseList[0] && track.licenseList[0].license) || '');
    var picked = trackSummary(track);
    tr.mark('pista', 'elegida #' + index + ' de ' + tracks.length + ': ' + (picked.format || '?') + ' ' + (picked.codec || '?') + ' ' +
      (picked.quality || '?') + ' | disponibles: ' + availableTracks.map(function (t) { return (t.format || '?') + '/' + (t.codec || '?') + '/' + (t.quality || '?'); }).join(', '));
    if (!license) { return done(new Error('el portal no devolvió licencia de reproducción')); }

    var slbWasCached = !!(slbCache && Date.now() < slbCache.at + SLB_TTL);
    if (ticketStale(ticket)) { return done(supersededError()); }
    getSlb(function (err3, slb) {
      tr.mark('slbPortal', slbWasCached ? 'caché' : 'consulta nueva');
      if (err3) { return done(err3); }
      if (vodSlbCdns(slb).length) {
        return lookupVodSlb(slb, tracks, track, function (slbError, media) {
          /* SLB media_format is not always the plain word "ts"; the portal's
             track format decides when SLB does not clearly say mp4.  Treating
             a TS as MP4 sent it to Chromium's native player (error 4). */
          var slbFormat = trim(media && media.format).toLowerCase();
          var trackFormat = trim(track.videoFormat).toLowerCase();
          var isTs = slbFormat === 'ts' || /mpeg-?ts|mp2t|m2ts/.test(slbFormat) ||
            (slbFormat.indexOf('mp4') === -1 && trackFormat === 'ts');
          tr.mark('slbV11', 'formato SLB "' + (slbFormat || 'vacío') + '", pista "' + (trackFormat || '?') + '" → ' + (isTs ? 'TS' : 'MP4'));
          if (slbError) return done(slbError);
          done(null, {
            url: media.url, backupUrls: media.backupUrls,
            mime: isTs ? 'video/mp2t' : 'video/mp4',
            codec: trim(track.encodeFormat).toUpperCase(), quality: trim(track.quality),
            duration: durationSeconds(track.duration || episode.duration || (play && play.duration)),
            selectedTrack: trackSummary(track), availableTracks: availableTracks, trackIndex: index,
            audio: trim(track.audioInfo), subtitles: subtitleList(episode), name: text(play && play.name),
            headers: { 'User-Agent': UA_CDN, App: APP_ID, 'App-Version': APK_VERSION }
          });
        });
      }
      var cdns = vodCdns(slb);
      if (!cdns.length) { return done(new Error('el portal no expuso CDN de vod libre')); }
      var cdn = cdns[0];
      var ext = trim(track.videoFormat).toLowerCase() === 'ts' ? 'ts' : 'mp4';
      var url = cdn.bases[0] + '/vod/' + trim(track.contentId) + '_media.' + ext;

      var mime = ext === 'ts' ? 'video/mp2t' : 'video/mp4';
      var codec = trim(track.encodeFormat).toUpperCase();
      done(null, {
        url: url,
        mime: mime,
        codec: codec,
        quality: trim(track.quality),
        duration: durationSeconds(track.duration || episode.duration || (play && play.duration)),
        selectedTrack: trackSummary(track),
        availableTracks: availableTracks,
        trackIndex: index,
        audio: trim(track.audioInfo),
        headers: {
          'Content-Auth': cdn.auth,
          'Content-License': license,
          'User-Agent': UA_CDN,
          App: APP_ID,
          'App-Version': APK_VERSION
        },
        subtitles: subtitleList(episode),
        name: text(play && play.name)
      });
    }, ticket.opts);
  }, ticket.opts);
}

/* ------------------------------------------------------------------- live */
var LIVE_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd46f3085, 0x04881d05,
  0xd9d4d039, 0xe6bd99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffecc47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2da7d2bb, 0xeb86d391
];
var LIVE_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
var LIVE_ROUND1 = [10, 11, 12, 13, 14, 15, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5];
var LIVE_G = [];
for (var iG = 0; iG < 64; iG++) {
  LIVE_G.push(iG < 16 ? LIVE_ROUND1[iG] : iG < 32 ? (5 * iG + 1) % 16 : iG < 48 ? (3 * iG + 5) % 16 : (7 * iG) % 16);
}
var LIVE_SALT = bufFrom([
  0x73, 0x61, 0x6c, 0x74, 0x33, 0x33, 0x33, 0x33, 0x3d, 0x34,
  0x98, 0x0d, 0x0a, 0x15, 0x32, 0xc9, 0xc3, 0x82, 0x17, 0x08, 0xc0
]);

function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

function liveCompress(st, block, off) {
  var m = new Array(16);
  for (var j = 0; j < 16; j++) {
    var p = off + j * 4;
    m[j] = (block[p] | (block[p + 1] << 8) | (block[p + 2] << 16) | (block[p + 3] << 24)) >>> 0;
  }
  var a = st[0], b = st[1], c = st[2], d = st[3];
  for (var i = 0; i < 64; i++) {
    var f;
    if (i < 16) f = (b & c) | (~b & d);
    else if (i < 32) f = (d & b) | (~d & c);
    else if (i < 48) f = b ^ c ^ d;
    else f = c ^ (b | ~d);
    var sum = (f + a + LIVE_K[i] + m[LIVE_G[i]]) >>> 0;
    a = d; d = c; c = b;
    b = (b + rotl(sum, LIVE_S[i])) >>> 0;
  }
  st[0] = (st[0] + a) >>> 0;
  st[1] = (st[1] + b) >>> 0;
  st[2] = (st[2] + c) >>> 0;
  st[3] = (st[3] + d) >>> 0;
}

function liveDigestHex(bytes) {
  var st = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  var len = bytes.length;
  var padLen = ((56 - ((len + 1) % 64)) + 64) % 64;
  var total = bufAlloc(len + 1 + padLen + 8);
  bytes.copy(total, 0);
  total[len] = 0x80;
  var low = (len % 0x20000000) * 8;
  var high = Math.floor(len / 0x20000000);
  for (var i = 0; i < 4; i++) {
    total[len + 1 + padLen + i] = (low >>> (8 * i)) & 0xff;
    total[len + 5 + padLen + i] = (high >>> (8 * i)) & 0xff;
  }
  for (var off = 0; off < total.length; off += 64) {
    liveCompress(st, total, off);
  }
  var out = '';
  for (var w = 0; w < 4; w++) {
    for (var j = 0; j < 4; j++) {
      var byteVal = (st[w] >>> (8 * j)) & 0xff;
      var hex = byteVal.toString(16);
      if (hex.length < 2) hex = '0' + hex;
      out += hex;
    }
  }
  return out;
}

function signO3(token, startMomentMs) {
  var head = bufFrom('token=' + token + '&sign2_method=sign_o3&instance=0&start_moment=' + startMomentMs, 'utf8');
  var msg = Buffer.concat([head, LIVE_SALT]);
  return liveDigestHex(msg);
}

function bareHost(mainAddr) {
  var s = typeof mainAddr === 'string' ? mainAddr : '';
  if (s.indexOf('https://') === 0) s = s.slice(8);
  if (s.indexOf('http://') === 0) s = s.slice(7);
  var slash = s.indexOf('/');
  return slash >= 0 ? s.slice(0, slash) : s;
}

/* opts (optional, before done): { priority: 'background' } for the startup
 * scan of every category, so it never delays what the viewer asked for. */
function getLiveChannels(columnId, pageNum, pageSize, opts, done) {
  if (typeof opts === 'function') { done = opts; opts = null; }
  if (typeof columnId === 'function') {
    done = columnId;
    columnId = null;
    pageNum = 1;
    pageSize = 20;
  } else if (typeof pageNum === 'function') {
    done = pageNum;
    pageNum = 1;
    pageSize = 20;
  } else if (typeof pageSize === 'function') {
    done = pageSize;
    pageSize = 20;
  }
  pageNum = Math.max(1, parseInt(pageNum, 10) || 1);
  pageSize = Math.max(1, Math.min(50, parseInt(pageSize, 10) || 20));
  ensureSession(function (err) {
    if (err) { return done(err); }
    /* Return one portal page at a time.  The client paints page one first,
       then asks for the remaining pages in the background.  This avoids a
       blank TV screen while a large category (for example Deportes) loads. */
    fetchLivePage(columnId || LIVE_DEFAULT_COLUMN, pageNum, pageSize, function (err2, page) {
      if (err2) { return done(err2); }
      done(null, page.channels, page.hasMore);
    }, opts && opts.priority === 'background' ? { priority: 'background' } : undefined);
  });
}

/* --------------------------------------------- licencias de canales en vivo
 * Cada canal de v6/getLiveData trae su licencia de reproducción.  Esa licencia
 * pertenece a la sesión que la pidió y caduca, así que se renueva volviendo a
 * pedir la MISMA página de catálogo de la que salió el canal.  v4/startPlayLive
 * no sirve para renovarla: en las pruebas respondió portal100004 ("canal
 * inexistente") a todos los canales. */
var liveChannelCache = {};
/* Categoría y página donde se vio cada canal.  No contiene licencias ni datos
 * de la cuenta, por eso sobrevive al inicio de sesión (las licencias no). */
var liveChannelOrigin = {};
/* Sube cada vez que cambia la sesión: una respuesta pedida con la sesión
 * anterior no debe guardar licencias para la nueva. */
var liveGeneration = 0;
var livePageInflight = {};
var LIVE_DEFAULT_COLUMN = 76182;
var LIVE_SEARCH_PAGE_SIZE = 50;   // máximo que acepta getLiveChannels
var LIVE_SEARCH_MAX_PAGES = 5;    // canal de origen desconocido: hasta 250 canales
var LIVE_REJECT_COOLDOWN_MS = 60000;
var liveRejectedAt = {};

/* Pide una página de canales (una sola petición aunque la pidan varios a la
 * vez) y actualiza licencias y origen de cada canal. */
function fetchLivePage(columnId, pageNum, pageSize, done, opts) {
  columnId = columnId || LIVE_DEFAULT_COLUMN;
  // A request in the background queue is not shared with an urgent one.
  var key = columnId + '|' + pageNum + '|' + pageSize + (opts && opts.priority === 'background' ? '|bg' : '');
  if (livePageInflight[key]) { livePageInflight[key].push(done); return; }
  livePageInflight[key] = [done];
  var generation = liveGeneration;
  function finish(err, page) {
    var waiting = livePageInflight[key] || [];
    delete livePageInflight[key];
    for (var w = 0; w < waiting.length; w++) { waiting[w](err, page); }
  }
  call('v6/getLiveData', {
    userToken: session.userToken,
    userId: session.userId,
    portalCode: session.portalCode || PORTAL_CODE,
    columnId: columnId,
    dataVersion: '',
    pageSize: pageSize,
    pageNum: pageNum,
    expireTimeStr: ''
  }, opts || {}, function (err2, res) {
    if (err2) { return finish(err2); }
    var list = (res && res.channelList) || [];
    var out = [];
    var seen = {};
    var current = generation === liveGeneration;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || !c.channelCode || seen[c.channelCode]) continue;
      seen[c.channelCode] = true;
      var poster = text(c.posterUrl);
      if (!poster && c.posterList && c.posterList.length) {
        poster = text(c.posterList[0].fileUrl);
      }
      var chItem = {
        channelCode: c.channelCode,
        index: c.channelNumber || out.length + 1,
        name: text(c.name || c.alias || ('Canal ' + (out.length + 1))),
        logo: poster,
        uhd: c.quality === '3',
        fav: c.isFav || false,
        now: 'En vivo',
        next: '',
        time: '',
        liveAddressList: c.liveAddressList || []
      };
      out.push(chItem);
      liveChannelOrigin[c.channelCode] = { columnId: columnId, pageNum: pageNum, pageSize: pageSize };
      if (current) { liveChannelCache[c.channelCode] = { at: Date.now(), channel: chItem }; }
    }
    finish(null, { channels: out, hasMore: list.length >= pageSize, stale: !current });
  });
}

function authorizedAddress(channel) {
  var list = (channel && channel.liveAddressList) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].playCode && list[i].license) { return list[i]; }
  }
  return null;
}

/* Licencia del catálogo si es reciente; null si falta o caducó. */
function catalogLicense(channelCode) {
  var cached = liveChannelCache[channelCode];
  if (!cached || cached.rejected || Date.now() - cached.at >= LIVE_RESOLVE_CACHE_MS) { return null; }
  var address = authorizedAddress(cached.channel);
  return address ? { address: address, ageMs: Date.now() - cached.at } : null;
}

/* Vuelve a pedir la página de la que salió el canal (y, si se movió, la
 * anterior y la siguiente).  Sin origen conocido busca en la categoría
 * general, con un límite de páginas.  done(err, address, nota); address null
 * = el canal ya no aparece en el catálogo. */
function renewLiveLicense(channelCode, done, restarted) {
  var origin = liveChannelOrigin[channelCode];
  var columnId, pageSize, pages, note, stopOnShort;
  if (origin) {
    columnId = origin.columnId; pageSize = origin.pageSize;
    pages = [origin.pageNum];
    if (origin.pageNum > 1) { pages.push(origin.pageNum - 1); }
    pages.push(origin.pageNum + 1);
    note = 'categoría ' + columnId + ' página ' + origin.pageNum;
    stopOnShort = false;
  } else {
    columnId = LIVE_DEFAULT_COLUMN; pageSize = LIVE_SEARCH_PAGE_SIZE;
    pages = [];
    for (var p = 1; p <= LIVE_SEARCH_MAX_PAGES; p++) { pages.push(p); }
    note = 'búsqueda en la categoría general (origen desconocido)';
    stopOnShort = true;
  }
  var index = 0;
  function next() {
    if (index >= pages.length) { return done(null, null, note + ': canal no encontrado'); }
    var pageNum = pages[index++];
    // Playback priority, but no "latest wins" check: other callers may share this page.
    fetchLivePage(columnId, pageNum, pageSize, function (err, page) {
      if (err) { return done(err, null, note); }
      if (page.stale) {
        // La sesión cambió durante la petición: se repite una vez con la nueva.
        if (!restarted) { return renewLiveLicense(channelCode, done, true); }
        return done(null, null, note + ': la sesión cambió');
      }
      // Only a license delivered by THIS request counts (not an older cached one).
      var found = null;
      for (var f = 0; f < page.channels.length; f++) {
        if (page.channels[f].channelCode === channelCode) { found = page.channels[f]; break; }
      }
      var address = authorizedAddress(found);
      if (address) {
        return done(null, address, note + (pageNum !== pages[0] ? ' (encontrado en la página ' + pageNum + ')' : ''));
      }
      if (stopOnShort && !page.hasMore) { return done(null, null, note + ': canal no encontrado'); }
      next();
    }, { priority: 'play' });
  }
  next();
}

/* Error definitivo: el servidor no ofrece el canal.  La interfaz no debe
 * reintentarlo en bucle (cada reintento suma peticiones y acerca el 429). */
function liveUnavailableError(cause) {
  var err = new Error('Canal no disponible: el servidor ya no ofrece este canal. Recarga la lista de canales o prueba otro.');
  err.finalLiveError = true;
  if (cause && cause.portalCode) { err.portalCode = cause.portalCode; }
  return err;
}

/* El CDN rechazó (401/403) la licencia de un canal: la próxima vez se renueva
 * en lugar de reutilizarla.  Como mucho una vez por minuto y canal, para que
 * un rechazo persistente no se convierta en un bucle de renovaciones. */
function invalidateLive(channelCode, status) {
  if (!channelCode) { return false; }
  var last = liveRejectedAt[channelCode] || 0;
  if (last && Date.now() - last < LIVE_REJECT_COOLDOWN_MS) {
    timing.log('vivo canal=' + channelCode + ' | CDN rechazó otra vez (HTTP ' + status + '); no se renueva de nuevo hasta pasado 1 min');
    return false;
  }
  liveRejectedAt[channelCode] = Date.now();
  delete liveResolveCache[channelCode];
  if (liveChannelCache[channelCode]) { liveChannelCache[channelCode].rejected = true; }
  timing.log('vivo canal=' + channelCode + ' | CDN rechazó la licencia (HTTP ' + status + '); se renovará en el próximo intento');
  return true;
}
var liveCategoriesCache = null;
function getLiveCategories(done) {
  if (liveCategoriesCache && liveCategoriesCache.length) {
    return done(null, liveCategoriesCache);
  }
  ensureSession(function (err) {
    if (err) { return done(err); }
    call('getNextColumns', { columnCode: 'masnew_live', pageNum: 1, pageSize: 50, version: '' }, function (err2, res) {
      if (err2) { return done(err2); }
      var list = (res && res.recommendList) || [];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || !c.columnId) continue;
        out.push({
          id: c.columnId,
          name: text(c.name || c.title || c.alias || 'Categoría ' + (i + 1)),
          code: c.code || ''
        });
      }
      liveCategoriesCache = out;
      done(null, out);
    });
  });
}

function parseM3u(content) {
  var lines = (content || '').split(/\r?\n/);
  var channels = [];
  var cur = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf('#EXTINF:') === 0) {
      var commaIdx = line.indexOf(',');
      var meta = line.slice(8, commaIdx > 0 ? commaIdx : undefined);
      var title = commaIdx > 0 ? line.slice(commaIdx + 1).trim() : 'Canal';
      var logoMatch = /tvg-logo="([^"]+)"/i.exec(meta);
      var groupMatch = /group-title="([^"]+)"/i.exec(meta);
      cur = {
        name: title,
        logo: logoMatch ? logoMatch[1] : '',
        group: groupMatch ? groupMatch[1] : 'Addon',
        isAddon: true,
        now: 'En vivo',
        fav: false
      };
    } else if (line && line.indexOf('#') !== 0 && cur) {
      cur.url = line;
      cur.streamUrl = line;
      cur.channelCode = 'm3u_' + (channels.length + 1);
      cur.index = channels.length + 1;
      channels.push(cur);
      cur = null;
    }
  }
  return channels;
}

function fetchM3u(urlStr, done) {
  if (!urlStr) { return done(new Error('URL de addon requerida')); }
  var isHttps = urlStr.indexOf('https://') === 0;
  var mod = isHttps ? https : http;
  var opts = url.parse(urlStr);
  opts.rejectUnauthorized = true;
  opts.method = 'GET';
  opts.headers = {
    'User-Agent': 'Mozilla/5.0 (SmartHub; SMART-TV; U; Linux/SmartTV) AppleWebKit/538.1+ (KHTML, like Gecko) Safari/538.1+'
  };
  dnsx.prepare(opts, function (prepErr, prepped) {
    if (prepErr) { return done(prepErr); }
    var req = mod.get(prepped, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchM3u(url.resolve(urlStr, res.headers.location), done);
      }
      if (res.statusCode !== 200) {
        return done(new Error('HTTP ' + res.statusCode + ' al descargar addon'));
      }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8');
        var chs = parseM3u(raw);
        done(null, chs);
      });
    });
    req.on('error', function (err) { done(err); });
    req.setTimeout(20000, function () { req.abort(); done(new Error('Tiempo de espera agotado al descargar addon')); });
  });
}

/* Live authorizations are short-lived but valid long enough to make channel
   surfing responsive.  Reusing one for two minutes avoids two portal round
   trips every time the viewer returns to a channel. */
var liveResolveCache = {};
var LIVE_RESOLVE_CACHE_MS = 120000;

/* Tries each attempt in order and stops at the first one that returns data.
   Portal builds differ per account: some require the live column id and the
   v15 SLB endpoint, older ones only answer columnId 0 / v14.  Calling the
   wrong form returns error 1, so live TV must never depend on a single guess. */
function firstCall(attempts, done) {
  var i = 0;
  function next(lastErr) {
    if (i >= attempts.length) {
      return done(lastErr || new Error('el portal no respondió'));
    }
    var attempt = attempts[i++];
    call(attempt.path, attempt.bean, attempt.opts || {}, function (err, data) {
      if (err) { if (err.httpStatus === 429 || err.superseded) return done(err); return next(err); }
      done(null, data);
    });
  }
  next(null);
}

function liveCdnsOf(slb) {
  var cdns = (slb && slb.cdn_list) || [];
  var list = [];
  var seen = {};
  function addEntry(host, auth) {
    var bh = bareHost(host);
    if (bh && !seen[bh]) {
      seen[bh] = true;
      list.push({ cflHost: bh, authBase: auth });
    }
  }
  // 1st pass: prioritize cfl / CacheFly CDNs
  for (var c = 0; c < cdns.length; c++) {
    var cdn = cdns[c];
    if (!cdn || cdn.tag !== 'live' || String(cdn.cdn_type) === '1') continue;
    var urls = cdn.url_list || [];
    for (var u = 0; u < urls.length; u++) {
      var entry = urls[u];
      var urlStr = (entry && entry.url) || '';
      if (entry.sign_type === 'cfl' || urlStr.indexOf('sign_type=cfl') !== -1) {
        addEntry(cdn.main_addr, urlStr);
        if (cdn.spared_addr) addEntry(cdn.spared_addr, urlStr);
      }
    }
  }
  // 2nd pass: fallback to any live CDN if cfl wasn't present or list is short
  for (var c2 = 0; c2 < cdns.length; c2++) {
    var cdn2 = cdns[c2];
    if (!cdn2 || cdn2.tag !== 'live' || String(cdn2.cdn_type) === '1') continue;
    var urls2 = cdn2.url_list || [];
    for (var u2 = 0; u2 < urls2.length; u2++) {
      var entry2 = urls2[u2];
      var urlStr2 = (entry2 && entry2.url) || '';
      if (urlStr2 && urlStr2.indexOf('token=') !== -1) {
        addEntry(cdn2.main_addr, urlStr2);
        if (cdn2.spared_addr) addEntry(cdn2.spared_addr, urlStr2);
      }
    }
  }
  return list;
}

/* Normalmente el resolutor contesta en 0,3-1,5 s; si tarda más de 2,5 s se
   pide otra vez por una conexión nueva (antes había esperas de 11-16 s). */
var LIVE_SLB_HEDGE_MS = 2500;
function lookupLiveSlb(cdns, playCode, license, done, tr) {
  var index = 0;
  function next(lastError) {
    if (index >= cdns.length) return done(lastError || new Error('SLB no devolvió señal para el canal'));
    var cdn = cdns[index++];
    var auth = (cdn.url_list || []).filter(function (entry) { return entry && trim(entry.url); });
    auth.sort(function (a, b) { return (a.tag === 'free' ? 0 : 1) - (b.tag === 'free' ? 0 : 1); });
    if (!auth.length) return next(lastError);
    rangerSlb.lookup({ address: cdn.main_addr, route: '/slb/v9/live', codec: rangerCodec,
      communicationKey: RANGER_COMMUNICATION_KEY, auth: auth[0].url,
      app: APP_ID, version: APK_VERSION, userAgent: UA_CDN, hedgeMs: LIVE_SLB_HEDGE_MS,
      onHedge: function () { if (tr) tr.mark('slbLento', 'sin respuesta en ' + LIVE_SLB_HEDGE_MS + 'ms: segunda petición'); } }, function (error, result) {
      if (error) { if (error.httpStatus === 429) return done(error); return next(error); }
      var servers = ((result && result.servers) || []).filter(function (server) { return server && /^https?:\/\//i.test(trim(server.media_url)); });
      if (!servers.length) return next(new Error('SLB no autorizó el canal seleccionado'));
      // V9 returns an authorization base. Ranger sends its path/query in
      // Content-Auth, signs its token and requests the channel without query.
      var base = url.parse(servers[0].media_url);
      var token = /(?:[?&])token=([^&]+)/.exec(base.search || '');
      if (!token) return next(new Error('SLB no devolvió autorización de vivo'));
      var moment = Date.now();
      var contentAuth = (base.pathname || '/live/') + (base.search || '') +
        '&sign2_method=sign_o3&instance=0&start_moment=' + moment + '&sign2=' + signO3(token[1], moment);
      base.pathname = (base.pathname || '/live/').replace(/\/?$/, '/') + encodeURIComponent(playCode) + '.m3u8';
      base.search = null; base.query = null; base.hash = null;
      done(null, { url: url.format(base), backupUrls: [],
        mime: 'application/x-mpegurl', headers: { 'User-Agent': UA_CDN, App: APP_ID, 'App-Version': APK_VERSION,
          'Content-Auth': contentAuth, 'Content-License': license, 'X-Buffer': '0' } });
    });
  }
  next(null);
}

function resolveLive(channelCode, done) {
  var tr = timing.trace('vivo', 'canal=' + channelCode);
  var ticket = beginPlayback('live');
  var liveDone = done;
  done = function (err, stream) {
    endPlayback(ticket);
    tr.end(err ? (err.superseded ? 'descartada (el usuario cambió de canal)' : 'ERROR: ' + timing.safeError(err)) : 'ok');
    liveDone(err, stream);
  };
  var cached = liveResolveCache[channelCode];
  if (session.ready && cached && (Date.now() - cached.at) < LIVE_RESOLVE_CACHE_MS) {
    tr.mark('caché', 'autorización de hace ' + Math.round((Date.now() - cached.at) / 1000) + 's');
    return setTimeout(function () { done(null, cached.stream); }, 0);
  }
  ensureSession(function (err) {
    tr.mark('sesión');
    if (err) { return done(err); }

    function getStreamAddr(cb) {
      var fresh = catalogLicense(channelCode);
      if (fresh) {
        tr.mark('licencia', 'del catálogo, edad ' + Math.round(fresh.ageMs / 1000) + 's');
        return cb(null, fresh.address);
      }
      var before = liveChannelCache[channelCode];
      var why = before ? 'caducada (' + Math.round((Date.now() - before.at) / 1000) + 's)' : 'sin licencia guardada';
      renewLiveLicense(channelCode, function (errR, address, note) {
        if (errR) {
          tr.mark('licencia', 'renovación FALLÓ (' + note + ', antes ' + why + ')');
          return cb(errR);
        }
        if (address) {
          tr.mark('licencia', 'renovada: ' + note + ', antes ' + why);
          return cb(null, address);
        }
        /* El canal no aparece en el catálogo actual.  Último recurso: un único
           startPlayLive (antes eran tres variantes que fallaban siempre). */
        call('v4/startPlayLive', { channelCode: channelCode, type: '1' }, ticket.opts, function (err2, play) {
          tr.mark('licencia', note + '; startPlayLive como último recurso' + (err2 ? ' FALLÓ' : ''));
          if (err2) {
            if (err2.httpStatus === 429) { return cb(err2); }
            return cb(err2.portalCode === 'portal100004' ? liveUnavailableError(err2) : err2);
          }
          var addr = authorizedAddress(play);
          if (!addr) { return cb(liveUnavailableError()); }
          cb(null, addr);
        });
      });
    }

    getStreamAddr(function (err2, addr) {
      if (err2) { return done(err2); }
      var playCode = addr.playCode || channelCode;
      var license = addr.license;

      var bean = slbBean();
      bean.liveCodeList = ['masnew_live'];
      var slbPaths = ['v15/getSlbInfo', 'v14/getSlbInfo'];
      var slbIndex = 0;

      function trySlb(lastSlbErr) {
        if (slbIndex >= slbPaths.length) {
          return done(new Error('el portal no expuso CDN de vivo'));
        }
        var slbPath = slbPaths[slbIndex++];
        call(slbPath, bean, ticket.opts, function (err3, slb) {
          tr.mark('slbPortal', slbPath + (err3 ? ' FALLÓ' : ''));
          if (err3) { if (err3.httpStatus === 429 || err3.superseded) return done(err3); return trySlb(err3); }
          var resolvers = ((slb && slb.cdn_list) || []).filter(function (cdn) {
            return cdn && cdn.tag === 'live' && String(cdn.cdn_type) === '1' && trim(cdn.main_addr);
          });
          if (resolvers.length) return lookupLiveSlb(resolvers, playCode, license, function (error, stream) {
            tr.mark('slbV9', resolvers.length + ' resolutor(es)' + (error ? ' FALLÓ' : ''));
            if (error) {
              // Some portal configurations advertise a resolver without its live route.
              // Only use a separate legacy CDN explicitly supplied by the portal.
              var legacy = liveCdnsOf(slb);
              if (error.httpStatus === 404 && legacy.length) return useCdns(legacy);
              return done(error);
            }
            stream.name = text(addr.name || (liveChannelCache[channelCode] && liveChannelCache[channelCode].channel.name) || channelCode);
            // Live URLs can expire quickly; obtain a fresh resolution when changing channels.
            done(null, stream);
          }, tr);
          var liveCdns = liveCdnsOf(slb);
          if (!liveCdns.length) { return trySlb(new Error('CDN de vivo vacía')); }
          useCdns(liveCdns);
        });
      }

      function useCdns(liveCdns) {
        tr.mark('caminoAntiguo', 'URL de CDN construida a mano');
        var chosen = liveCdns[0];
        var liveUrl = 'http://' + chosen.cflHost + '/live/' + playCode + '.m3u8';
        var tokenMatch = chosen.authBase.match(/token=([0-9a-fA-F]{32})/);
        var token = tokenMatch ? tokenMatch[1] : '';
        var moment = Math.floor(Date.now());
        var sign2 = signO3(token, moment);
        var authHeader = chosen.authBase + '&sign2_method=sign_o3&instance=0&start_moment=' + moment + '&sign2=' + sign2;
        var backupUrls = [];
        for (var b = 1; b < liveCdns.length; b++) {
          backupUrls.push('http://' + liveCdns[b].cflHost + '/live/' + playCode + '.m3u8');
        }
        var stream = {
          url: liveUrl,
          backupUrls: backupUrls,
          mime: 'application/x-mpegurl',
          headers: {
            'Content-Auth': authHeader,
            'Content-License': license,
            'User-Agent': UA_CDN,
            'App': APP_ID,
            'App-Version': APK_VERSION,
            'X-Buffer': '0'
          },
          name: text((addr && addr.name) || (liveChannelCache[channelCode] && liveChannelCache[channelCode].channel && liveChannelCache[channelCode].channel.name) || channelCode)
        };
        liveResolveCache[channelCode] = { at: Date.now(), stream: stream };
        done(null, stream);
      }

      trySlb(null);
    });
  });
}

module.exports = {
  loginAccount: loginAccount,
  logoutAccount: logoutAccount,
  accountStatus: accountStatus,
  accountSnapshot: accountSnapshot,
  restoreAccount: restoreAccount,
  setAccountListener: setAccountListener,
  setAccountRemembered: setAccountRemembered,
  rangerCodec: rangerCodec,
  home: home,
  search: search,
  detail: detail,
  mediaInfo: mediaInfo,
  audioInfo: audioInfo,
  resolve: resolve,
  getLiveChannels: getLiveChannels,
  getLiveCategories: getLiveCategories,
  resolveLive: resolveLive,
  invalidateLive: invalidateLive,
  fetchM3u: fetchM3u,
  parseM3u: parseM3u,
  call: call,
  post: post,
  ensureSession: ensureSession,
  session: session,
  constants: {
    APP_ID: APP_ID,
    APK_VERSION: APK_VERSION,
    UA_CDN: UA_CDN,
    FIXED_MAC: FIXED_MAC,
    ROOT_CODES: ROOT_CODES,
    HOSTS: HOSTS
  }
};
