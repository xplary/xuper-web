'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
/* hedgeMs (opcional): si el resolutor no contesta en ese tiempo se lanza una
   segunda petición idéntica por una conexión nueva y gana la primera que
   responda.  A veces una petición se queda colgada 11-15 s (conexión
   reutilizada o servidor lento) mientras otra recién abierta contesta en
   menos de 1 s.  Solo hay un error si fallan las dos (un 429 corta enseguida). */
function lookup(options, done) {
  if (!(options.hedgeMs > 0)) return lookupOnce(options, done);
  let finished = false, pending = 1, hedged = false, timer = null;
  function end(error, value) { finished = true; if (timer) clearTimeout(timer); timer = null; done(error || null, value); }
  function settle(error, value) {
    if (finished) return;
    pending--;
    /* Respuesta (buena o un HTTP del servidor, p. ej. 404/429): es definitiva. */
    if (!error || error.httpStatus) return end(error, value);
    /* Fallo de red de la primera antes del plazo: un único reintento ya. */
    if (!hedged) { if (timer) clearTimeout(timer); timer = null; return fire(); }
    if (!pending) end(error);
  }
  function fire() {
    hedged = true; pending++;
    if (typeof options.onHedge === 'function') { try { options.onHedge(); } catch (_) {} }
    lookupOnce(Object.assign({}, options, { freshConnection: true }), settle);
  }
  timer = setTimeout(function () { timer = null; if (!finished && !hedged) fire(); }, options.hedgeMs);
  lookupOnce(options, settle);
}
function lookupOnce(options, done) {
  let finished = false;
  function finish(error, value) { if (finished) return; finished = true; done(error, value); }
  let url;
  const route = options.route || '/slb/v11/vod';
  try {
    if (!['/slb/v11/vod', '/slb/v9/live'].includes(route)) throw Error('Ruta SLB inválida');
    const base = /^https?:\/\//i.test(options.address) ? options.address : 'http://' + options.address;
    url = new URL(route, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Dirección SLB inválida');
    const wire = route === '/slb/v9/live'
      ? options.codec.encodePlain(options.auth, options.communicationKey, route)
      : options.codec.encodeRequest(options.entries, options.communicationKey, route);
    url.searchParams.set('auth', wire);
  } catch (error) { return finish(error); }
  const transport = url.protocol === 'https:' ? https : http;
  const req = transport.get(url, { agent: options.freshConnection ? false : undefined, headers: {
    App: options.app, 'App-Version': options.version, 'User-Agent': options.userAgent,
    'Content-Type': 'application/octet-stream', 'Ranger-Id': crypto.randomUUID()
  } }, response => {
    if (response.statusCode !== 200) {
      response.resume();
      const error = Error('SLB respondió HTTP ' + response.statusCode);
      error.httpStatus = response.statusCode;
      return finish(error);
    }
    const chunks = []; let size = 0;
    response.on('data', chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) return req.destroy(Error('Respuesta SLB demasiado grande'));
      chunks.push(chunk);
    });
    response.on('error', finish);
    response.on('end', () => {
      try { finish(null, options.codec.decodeResponse(Buffer.concat(chunks).toString('utf8'), options.communicationKey, route)); }
      catch (_) { finish(Error('No se pudo interpretar la respuesta SLB')); }
    });
  });
  req.setTimeout(15000, () => req.destroy(Error('Tiempo de espera de SLB agotado')));
  req.on('error', finish);
}
module.exports = { lookup };
