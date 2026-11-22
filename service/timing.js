'use strict';

/* Medición de tiempos por fase de reproducción (diagnóstico).
 * Solo se activa con la variable de entorno XUPER_TIEMPOS=1.
 * Registra nombres de fase, rutas del portal, códigos HTTP y duraciones:
 * nunca URLs de vídeo, tokens, licencias ni credenciales. */

var enabled = process.env.XUPER_TIEMPOS === '1';

function stamp() {
  var d = new Date();
  function p(n, w) { n = String(n); while (n.length < (w || 2)) { n = '0' + n; } return n; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
}

function log(text) {
  if (!enabled) { return; }
  console.log('[tiempos ' + stamp() + '] ' + text);
}

/* Traza de una operación con varias fases: cada mark() registra lo que tardó
 * esa fase desde la anterior; end() imprime una línea resumen. */
var seq = 0;
function trace(kind, label) {
  var id = ++seq;
  var t0 = Date.now();
  var last = t0;
  var parts = [];
  var closed = false;
  return {
    id: id,
    mark: function (phase, note) {
      if (!enabled || closed) { return; }
      var now = Date.now();
      parts.push(phase + '=' + (now - last) + 'ms' + (note ? ' (' + note + ')' : ''));
      last = now;
    },
    end: function (result) {
      if (!enabled || closed) { return; }
      closed = true;
      log('#' + id + ' ' + kind + ' ' + label + ' | ' + (parts.join(' | ') || 'sin fases') +
        ' | TOTAL=' + (Date.now() - t0) + 'ms → ' + (result || 'ok'));
    }
  };
}

/* Mensaje de error sin datos sensibles (sin URLs ni parámetros). */
function safeError(err) {
  var msg = String((err && (err.code || err.message)) || err || 'error');
  return msg.replace(/https?:\/\/\S+/gi, '<url>').slice(0, 160);
}

module.exports = { enabled: enabled, log: log, trace: trace, safeError: safeError };
