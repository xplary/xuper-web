'use strict';

/* Audio language choice for Directo (no FFmpeg).
 *
 * A portal MPEG-TS file carries every audio language as its own stream, and
 * hls.js always plays the FIRST audio stream listed in the PMT (the table of
 * contents repeated at the start of each segment).  To play another language
 * we rewrite only that table so the chosen audio stream is listed first.
 * Audio and video bytes are never touched and the size stays the same, so
 * byte ranges and Content-Length remain valid. */

var Transform = require('stream').Transform;
var PACKET = 188;

var CRC_TABLE = (function () {
  var t = new Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i << 24;
    for (var j = 0; j < 8; j++) { c = (c & 0x80000000) ? ((c << 1) ^ 0x04C11DB7) : (c << 1); }
    t[i] = c >>> 0;
  }
  return t;
})();

/* MPEG-2 CRC32 used by PSI tables. */
function crc32(buf, start, end) {
  var crc = 0xFFFFFFFF;
  for (var i = start; i < end; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xFF]) >>> 0;
  }
  return crc >>> 0;
}

/* MPEG-1/2 audio, AAC (ADTS/LATM), AC-3 and E-AC-3. */
var AUDIO_TYPES = { 0x03: 1, 0x04: 1, 0x0f: 1, 0x11: 1, 0x81: 1, 0x87: 1 };

function isAudioEntry(buf, type, descStart, descEnd) {
  if (AUDIO_TYPES[type]) { return true; }
  if (type !== 0x06) { return false; }
  /* Private PES: audio only when it carries an AC-3 / E-AC-3 / DTS descriptor. */
  for (var d = descStart; d + 1 < descEnd; d += 2 + buf[d + 1]) {
    var tag = buf[d];
    if (tag === 0x6A || tag === 0x7A || tag === 0x7B || tag === 0x81) { return true; }
  }
  return false;
}

/* Start of the PSI section inside a packet, or -1. */
function sectionStart(buf, p) {
  if (!(buf[p + 1] & 0x40)) { return -1; }                 // needs payload_unit_start
  var afc = (buf[p + 3] >> 4) & 3;
  if (afc === 0 || afc === 2) { return -1; }
  var at = p + 4;
  if (afc === 3) { at += 1 + buf[at]; }
  if (at >= p + PACKET) { return -1; }
  at += 1 + buf[at];                                         // pointer_field
  return at < p + PACKET ? at : -1;
}

function patPmtPid(buf, p) {
  var at = sectionStart(buf, p);
  if (at < 0 || buf[at] !== 0x00) { return -1; }
  var end = at + 3 + (((buf[at + 1] & 15) << 8) | buf[at + 2]) - 4;
  for (var q = at + 8; q + 3 < end && q + 3 < p + PACKET; q += 4) {
    var program = (buf[q] << 8) | buf[q + 1];
    if (program !== 0) { return ((buf[q + 2] & 31) << 8) | buf[q + 3]; }
  }
  return -1;
}

/* Rewrites the PMT in the packet at offset p so the audio stream number
 * `audioIndex` (0 = first audio in the file) is listed first.  Returns true
 * when the packet was changed. */
function rewritePmt(buf, p, audioIndex) {
  if (!(audioIndex > 0)) { return false; }
  var at = sectionStart(buf, p);
  if (at < 0 || buf[at] !== 0x02) { return false; }
  var sectionEnd = at + 3 + (((buf[at + 1] & 15) << 8) | buf[at + 2]);
  if (sectionEnd > p + PACKET) { return false; }           // multi-packet PMT: leave as is
  var loopStart = at + 12 + (((buf[at + 10] & 15) << 8) | buf[at + 11]);
  var loopEnd = sectionEnd - 4;
  var entries = [];
  for (var q = loopStart; q + 5 <= loopEnd;) {
    var len = 5 + (((buf[q + 3] & 15) << 8) | buf[q + 4]);
    if (q + len > loopEnd) { return false; }
    entries.push({ start: q, len: len, audio: isAudioEntry(buf, buf[q], q + 5, q + len) });
    q += len;
  }
  var audios = entries.filter(function (e) { return e.audio; });
  if (audioIndex >= audios.length) { return false; }
  var chosen = audios[audioIndex];
  var order = entries.filter(function (e) { return e !== chosen; });
  order.splice(order.indexOf(audios[0]), 0, chosen);
  var loop = Buffer.concat(order.map(function (e) { return Buffer.from(buf.slice(e.start, e.start + e.len)); }));
  loop.copy(buf, loopStart);
  var crc = crc32(buf, at, loopEnd);
  buf[loopEnd] = (crc >>> 24) & 0xFF;
  buf[loopEnd + 1] = (crc >>> 16) & 0xFF;
  buf[loopEnd + 2] = (crc >>> 8) & 0xFF;
  buf[loopEnd + 3] = crc & 0xFF;
  return true;
}

/* Stream transform for a TS byte range starting at file offset `fileStart`.
 * `state.pmtPid` is shared per title so a range without PAT still works. */
function createRewriter(audioIndex, fileStart, state) {
  state = state || {};
  var skip = (PACKET - ((Number(fileStart) || 0) % PACKET)) % PACKET;
  var rest = null;
  return new Transform({
    transform: function (chunk, _enc, done) {
      if (skip > 0) {
        var pass = Math.min(skip, chunk.length);
        skip -= pass;
        this.push(chunk.slice(0, pass));
        chunk = chunk.slice(pass);
        if (!chunk.length) { return done(); }
      }
      var buf = rest ? Buffer.concat([rest, chunk]) : chunk;
      var whole = buf.length - (buf.length % PACKET);
      for (var p = 0; p < whole; p += PACKET) {
        if (buf[p] !== 0x47) { continue; }
        var pid = ((buf[p + 1] & 31) << 8) | buf[p + 2];
        if (pid === 0) {
          var pmt = patPmtPid(buf, p);
          if (pmt > 0) { state.pmtPid = pmt; }
        } else if (pid === state.pmtPid) {
          rewritePmt(buf, p, audioIndex);
        }
      }
      rest = whole < buf.length ? Buffer.from(buf.slice(whole)) : null;
      this.push(buf.slice(0, whole));
      done();
    },
    flush: function (done) {
      if (rest) { this.push(rest); }
      done();
    }
  });
}

module.exports = { createRewriter: createRewriter, rewritePmt: rewritePmt, crc32: crc32, patPmtPid: patPmtPid };
