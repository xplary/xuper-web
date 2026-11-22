'use strict';

/* Duration of an MPEG-TS file without FFmpeg.
 *
 * Every video PES packet carries a presentation timestamp (PTS, 90 kHz).
 * Reading ~1 MB at the start and ~1 MB at the end of the file is enough:
 * duration = last PTS - first PTS of the video stream.  Two small range
 * requests, usually well under a second. */

var PACKET = 188;
var HEAD_BYTES = PACKET * 5600;      // ~1 MB
var TAIL_BYTES = PACKET * 5600;
var WRAP = 8589934592;               // 2^33: PTS counter wraps around
var VIDEO_TYPES = { 0x01: 1, 0x02: 1, 0x10: 1, 0x1b: 1, 0x24: 1, 0x42: 1, 0xea: 1 };

function ptsAt(b, p) {
  return ((b[p] & 14) * 536870912) + (b[p + 1] * 4194304) + ((b[p + 2] & 254) * 16384) +
    (b[p + 3] * 128) + ((b[p + 4] & 254) / 2);
}

/* First offset where three packets in a row start with the sync byte. */
function syncOffset(b) {
  for (var k = 0; k < PACKET && k + PACKET * 2 < b.length; k++) {
    if (b[k] === 0x47 && b[k + PACKET] === 0x47 && b[k + PACKET * 2] === 0x47) { return k; }
  }
  return -1;
}

function payloadStart(b, p) {
  var afc = (b[p + 3] >> 4) & 3;
  if (afc === 0 || afc === 2) { return -1; }
  var at = p + 4;
  if (afc === 3) { at += 1 + b[at]; }
  return at < p + PACKET ? at : -1;
}

function sectionAt(b, p) {
  var at = payloadStart(b, p);
  if (at < 0 || !(b[p + 1] & 0x40)) { return -1; }
  at += 1 + b[at];
  return at < p + PACKET ? at : -1;
}

/* Video PID from PAT + PMT in the first bytes, or -1. */
function videoPid(b) { return videoInfo(b).pid; }

/* { pid, type } of the video stream (type 0x24 HEVC, 0x1b H.264…), pid -1 if unknown. */
function videoInfo(b) {
  var start = syncOffset(b), pmtPid = -1;
  if (start < 0) { return { pid: -1, type: 0 }; }
  for (var p = start; p + PACKET <= b.length; p += PACKET) {
    if (b[p] !== 0x47) { continue; }
    var pid = ((b[p + 1] & 31) << 8) | b[p + 2];
    var at = sectionAt(b, p);
    if (at < 0) { continue; }
    if (pid === 0 && b[at] === 0x00 && pmtPid < 0) {
      var patEnd = at + 3 + (((b[at + 1] & 15) << 8) | b[at + 2]) - 4;
      for (var q = at + 8; q + 3 < patEnd; q += 4) {
        if ((b[q] << 8 | b[q + 1]) !== 0) { pmtPid = ((b[q + 2] & 31) << 8) | b[q + 3]; break; }
      }
    } else if (pid === pmtPid && b[at] === 0x02) {
      var end = at + 3 + (((b[at + 1] & 15) << 8) | b[at + 2]) - 4;
      for (var e = at + 12 + (((b[at + 10] & 15) << 8) | b[at + 11]); e + 5 <= end && e + 5 <= p + PACKET;) {
        var esPid = ((b[e + 1] & 31) << 8) | b[e + 2];
        if (VIDEO_TYPES[b[e]]) { return { pid: esPid, type: b[e] }; }
        e += 5 + (((b[e + 3] & 15) << 8) | b[e + 4]);
      }
      return { pid: -1, type: 0 };
    }
  }
  return { pid: -1, type: 0 };
}

/* All PTS values of `pid` found in the buffer, in file order. */
function ptsList(b, pid) {
  var start = syncOffset(b), out = [];
  if (start < 0) { return out; }
  for (var p = start; p + PACKET <= b.length; p += PACKET) {
    if (b[p] !== 0x47 || !(b[p + 1] & 0x40)) { continue; }
    if ((((b[p + 1] & 31) << 8) | b[p + 2]) !== pid) { continue; }
    var at = payloadStart(b, p);
    if (at < 0 || at + 14 > p + PACKET) { continue; }
    if (b[at] !== 0 || b[at + 1] !== 0 || b[at + 2] !== 1) { continue; }
    if (b[at + 7] & 0x80) { out.push(ptsAt(b, at + 9)); }
  }
  return out;
}

/* PTS (90 kHz ticks) of the first video in the file: second 0 of the title. */
function startPts(head, pid) {
  var first = ptsList(head, pid);
  if (!first.length) { return null; }
  return Math.min.apply(null, first.slice(0, 60));
}

/* First video PES with a PTS in `b`: { pos (offset in b), pts } or null.
   Tells which second of the title a byte of the file holds. */
function firstVideoPts(b, pid) {
  var start = syncOffset(b);
  if (start < 0) { return null; }
  for (var p = start; p + PACKET <= b.length; p += PACKET) {
    if (b[p] !== 0x47 || !(b[p + 1] & 0x40)) { continue; }
    if ((((b[p + 1] & 31) << 8) | b[p + 2]) !== pid) { continue; }
    var at = payloadStart(b, p);
    if (at < 0 || at + 14 > p + PACKET) { continue; }
    if (b[at] !== 0 || b[at + 1] !== 0 || b[at + 2] !== 1) { continue; }
    if (b[at + 7] & 0x80) { return { pos: p, pts: ptsAt(b, at + 9) }; }
  }
  return null;
}

/* Seconds since `base`, across the 33-bit clock wrap. */
function secondsSince(pts, base) {
  var d = pts - base;
  if (d < -WRAP / 2) { d += WRAP; }
  return d / 90000;
}

/* Seconds between the first and last video timestamps, or 0. */
function fromBuffers(head, tail) {
  var pid = videoPid(head);
  if (pid < 0) { return 0; }
  var first = ptsList(head, pid), last = ptsList(tail, pid);
  if (!first.length || !last.length) { return 0; }
  /* Frames are stored out of order (B-frames): use the smallest start and
     the largest end timestamp, then undo one counter wrap if needed. */
  var a = Math.min.apply(null, first.slice(0, 60));
  var z = Math.max.apply(null, last.slice(-60));
  var ticks = z - a;
  if (ticks < 0) { ticks += WRAP; }
  var seconds = ticks / 90000;
  return seconds > 30 && seconds < 6 * 3600 ? Math.round(seconds * 100) / 100 : 0;
}

/* reader: { length(cb(err, bytes)), range(start, end, cb(err, buffer)) } */
function measure(reader, done) {
  reader.length(function (err, length) {
    if (err || !(length > PACKET * 1000)) { return done(err || new Error('tamaño desconocido')); }
    reader.range(0, Math.min(length, HEAD_BYTES) - 1, function (e1, head) {
      if (e1 || !head) { return done(e1 || new Error('sin datos')); }
      var tailStart = Math.max(0, length - TAIL_BYTES);
      reader.range(tailStart, length - 1, function (e2, tail) {
        if (e2 || !tail) { return done(e2 || new Error('sin datos')); }
        var seconds = fromBuffers(head, tail);
        done(seconds ? null : new Error('sin marcas de tiempo'), seconds);
      });
    });
  });
}

module.exports = { measure: measure, fromBuffers: fromBuffers, videoInfo: videoInfo, startPts: startPts, firstVideoPts: firstVideoPts, secondsSince: secondsSince, HEAD_BYTES: HEAD_BYTES, TAIL_BYTES: TAIL_BYTES };
