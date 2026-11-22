'use strict';
/* Radio en vivo: emisoras de Radio Browser (radio-browser.info), un directorio
 * público y gratuito, sin claves.  Normas del servicio: identificarse con un
 * nombre de app (User-Agent) y avisar cuando se escucha una emisora (clic),
 * que alimenta su ranking de popularidad.
 *
 * - Se consulta por país (código ISO de 2 letras), solo emisoras que pasaron
 *   su última comprobación, ordenadas por escuchas.
 * - Las direcciones se resuelven por DNS seguro (dnsx), como el portal.
 * - Las señales y logos por HTTP pasan por el proxy local (la página es
 *   segura y bloquearía HTTP); las de HTTPS se usan tal cual.
 */

var https = require('https');
var dnsx = require('./dnsx');
var proxy = require('./proxy');

var MIRRORS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'all.api.radio-browser.info'];
var CACHE_MS = 30 * 60 * 1000;
var cache = {};               /* clave -> { at, stations } */
var userAgent = 'XuperDesktop';

function setVersion(version) { userAgent = 'XuperDesktop/' + (version || ''); }

function getJson(path, done) {
  var i = 0;
  function next(lastErr) {
    if (i >= MIRRORS.length) { return done(lastErr || new Error('Radio Browser no respondió')); }
    var host = MIRRORS[i++];
    dnsx.prepare({ hostname: host, port: 443, path: path, method: 'GET', protocol: 'https:',
      headers: { 'User-Agent': userAgent, Accept: 'application/json' } }, function (perr, options) {
      if (perr) { return next(perr); }
      var finished = false;
      var req = https.request(options, function (res) {
        var parts = [];
        res.on('data', function (c) { parts.push(c); });
        res.on('end', function () {
          if (finished) { return; }
          finished = true;
          if (res.statusCode !== 200) { return next(new Error(host + ': HTTP ' + res.statusCode)); }
          try { done(null, JSON.parse(Buffer.concat(parts).toString('utf8'))); }
          catch (eJson) { next(new Error(host + ': respuesta no válida')); }
        });
      });
      req.setTimeout(9000, function () { try { req.abort(); } catch (eA) { /* ignore */ } });
      req.on('error', function (err) { if (!finished) { finished = true; next(err); } });
      req.end();
    });
  }
  next(null);
}

function playable(url) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) { return ''; }
  return /^https:/i.test(url) ? url : proxy.addRadio(url);
}

function normalize(list) {
  var out = [], seen = {};
  for (var i = 0; i < (list || []).length; i++) {
    var s = list[i] || {};
    if (Number(s.lastcheckok) !== 1) { continue; }
    var url = String(s.url_resolved || s.url || '').trim();
    var name = String(s.name || '').replace(/\s+/g, ' ').trim();
    if (!url || !name) { continue; }
    var key = name.toLowerCase() + '|' + url;
    if (seen[key]) { continue; }
    seen[key] = true;
    out.push({
      id: String(s.stationuuid || ''),
      name: name,
      stream: playable(url),
      hls: Number(s.hls) === 1 || /\.m3u8(\?|$)/i.test(url),
      logo: playable(s.favicon),
      tags: String(s.tags || ''),
      city: String(s.state || ''),
      language: String(s.language || ''),
      codec: String(s.codec || ''),
      bitrate: Number(s.bitrate) || 0,
      votes: Number(s.votes) || 0,
      clicks: Number(s.clickcount) || 0,
      homepage: String(s.homepage || '')
    });
  }
  return out;
}

/* stations({country, language?, limit?}) -> { stations: [...] } */
function stations(params, done) {
  var country = String(params && params.country || 'PE').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'PE';
  var language = String(params && params.language || '').toLowerCase().replace(/[^a-z ]/g, '').slice(0, 30);
  var limit = Math.max(20, Math.min(600, Number(params && params.limit) || 400));
  /* "Mis radios": emisoras concretas por su identificador (de cualquier país). */
  var uuids = String(params && params.uuids || '').split(',').map(function (u) { return u.replace(/[^a-f0-9-]/gi, ''); })
    .filter(Boolean).slice(0, 100).join(',');
  var key = uuids ? 'ids|' + uuids : country + '|' + language + '|' + limit;
  var hit = cache[key];
  if (hit && Date.now() - hit.at < CACHE_MS) { return done(null, { country: country, stations: hit.stations, cached: true }); }
  proxy.start(function (perr) {
    if (perr) { return done(perr); }
    var path = uuids ? '/json/stations/byuuid?uuids=' + uuids :
      '/json/stations/search?countrycode=' + country + '&hidebroken=true&order=clickcount&reverse=true&limit=' + limit +
      (language ? '&language=' + encodeURIComponent(language) : '');
    getJson(path, function (err, list) {
      if (err) { return done(err); }
      var result = normalize(list);
      cache[key] = { at: Date.now(), stations: result };
      done(null, { country: country, stations: result });
    });
  });
}

/* click({id}): avisa a Radio Browser de que se escucha la emisora. */
function click(params, done) {
  var id = String(params && params.id || '').replace(/[^a-f0-9-]/gi, '');
  if (!id) { return done(null, { ok: false }); }
  getJson('/json/url/' + id, function (err) { done(null, { ok: !err }); });
}

module.exports = { stations: stations, click: click, setVersion: setVersion };
