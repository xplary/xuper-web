'use strict';

/* Instant seeking for Directo (MPEG-TS played through a generated HLS list).
 *
 * The old way read the whole file once to find every keyframe before a part
 * of the title could be reached.  Here the list is written at once from the
 * file size and its duration (first/last timestamps, two small reads): N
 * segments of ~SEGMENT_SECONDS, cut at evenly spaced byte positions.
 *
 * Those positions are not keyframes, so every segment is cut while it is
 * downloaded (createCutter):
 *   - it starts at the first keyframe at or after its nominal start (or at
 *     the PAT packet just before it, so the demuxer sees the tables first);
 *   - it ends right before the first keyframe at or after the nominal start
 *     of the next segment.
 * Both ends use the same rule, so consecutive segments join without gaps or
 * overlaps; the real start found for a segment is remembered so the next one
 * is fetched from exactly that byte.  Media bytes are never changed. */

var PACKET = 188;
/* Short segments: after a jump only ~4 s must download before the picture
   (the titles measured carry a keyframe every 0.3-5 s). */
var SEGMENT_SECONDS = 4;
var LOOKAHEAD_BYTES = 24 * 1024 * 1024;   /* max scanned past a segment end */
var START_SCAN_BYTES = 24 * 1024 * 1024;  /* max scanned for a segment start */
var HEVC = 0x24, H264 = 0x1b;

function supported(type) { return type === HEVC || type === H264; }

/* Evenly spaced segments over the whole file, on packet boundaries. */
function plan(length, duration, seconds) {
  seconds = seconds || SEGMENT_SECONDS;
  var count = Math.max(1, Math.round(duration / seconds));
  var packets = Math.floor(length / PACKET);
  var segments = [];
  for (var i = 0; i < count; i++) {
    var start = Math.floor(packets * i / count) * PACKET;
    var end = i + 1 < count ? Math.floor(packets * (i + 1) / count) * PACKET - 1 : length - 1;
    segments.push({ start: start, end: end, duration: duration / count });
  }
  return segments;
}

function payloadStart(b, p) {
  var afc = (b[p + 3] >> 4) & 3;
  if (afc === 0 || afc === 2) { return -1; }
  var at = p + 4;
  if (afc === 3) { at += 1 + b[at]; }
  return at < p + PACKET ? at : -1;
}

/* Looks at the NAL units in one video packet.  Returns 1 for a keyframe
 * (HEVC IRAP / H.264 IDR), 0 for another picture, -1 if still undecided. */
function nalVerdict(b, from, to, type) {
  for (var i = from; i + 3 < to; i++) {
    if (b[i] !== 0 || b[i + 1] !== 0) { continue; }
    var n;
    if (b[i + 2] === 1) { n = i + 3; } else if (b[i + 2] === 0 && b[i + 3] === 1) { n = i + 4; } else { continue; }
    if (n >= to) { return -1; }
    if (type === HEVC) {
      var t = (b[n] >> 1) & 63;
      if (t >= 16 && t <= 21) { return 1; }
      if (t <= 9) { return 0; }
    } else {
      var h = b[n] & 31;
      if (h === 5) { return 1; }
      if (h === 1) { return 0; }
    }
    i = n;
  }
  return -1;
}

/* Transform stream: input = file bytes from `begin` (packet aligned);
 * output = exactly one segment.  opts:
 *   begin   file offset of the first input byte
 *   lower   nominal segment start (start search from here); begin <= lower
 *   exact   true when `begin` is already the real start (skip the search)
 *   upper   nominal start of the next segment, or -1 for the last segment
 *   pid, type   video stream
 *   onCut(pos)  real start of the next segment (pos of the first byte not sent)
 *   onStart(pos) real start of this segment (first byte sent) */
function createCutter(opts) {
  var Transform = require('stream').Transform;
  var pos = opts.begin;                 /* file offset of the next input byte */
  var carry = null;
  var phase = opts.exact ? 'pass' : 'seek';
  var held = [];                        /* {pos, buf} not yet sent */
  var lastPat = -1, pesStart = -1, pesVerdict = -1, done = false, startSent = false;
  function started(at) {
    if (startSent) { return; }
    startSent = true;
    if (opts.onStart) { opts.onStart(at); }
  }
  if (opts.exact) { started(opts.begin); }

  function emitFrom(self, from, to) {
    for (var i = 0; i < held.length; i++) {
      var h = held[i];
      if (h.pos >= from && (to < 0 || h.pos < to)) { self.push(h.buf); }
    }
    held = [];
  }
  function finish(self, cut) {
    if (done) { return; }
    done = true;
    if (opts.onCut) { opts.onCut(cut); }
    self.push(null);
  }
  /* Tracks PAT/PES/keyframes; returns the cut position when a keyframe PES
   * starting at or after `bound` is recognised, else -1. */
  function watch(b, p, at0, bound) {
    var pid = ((b[p + 1] & 31) << 8) | b[p + 2];
    var pusi = !!(b[p + 1] & 0x40);
    if (pid === 0 && pusi) { lastPat = pos; return -1; }
    if (pid !== opts.pid) { return -1; }
    var at = payloadStart(b, p);
    if (at < 0) { return -1; }
    if (pusi) {
      pesStart = pos; pesVerdict = -1;
      if (b[at] === 0 && b[at + 1] === 0 && b[at + 2] === 1 && at + 9 < p + PACKET) { at += 9 + b[at + 8]; }
    }
    if (pesStart < 0 || pesVerdict !== -1) { return -1; }
    pesVerdict = nalVerdict(b, at, p + PACKET, opts.type);
    if (pesVerdict === 1 && pesStart >= bound) {
      return lastPat >= bound && lastPat <= pesStart ? lastPat : pesStart;
    }
    return -1;
  }
  function onPacket(self, pkt) {
    if (done) { return; }
    var bound;
    if (phase === 'seek') {
      held.push({ pos: pos, buf: pkt });
      var start = watch(pkt, 0, 0, opts.lower);
      if (start >= 0) {
        emitFrom(self, start, -1);
        phase = 'pass';
        started(start);
      } else if (pos - opts.lower > START_SCAN_BYTES) {
        /* No keyframe found: send what we have rather than nothing. */
        emitFrom(self, opts.lower, -1);
        phase = 'pass';
        started(opts.lower);
      } else if (held.length > 4096 && lastPat < 0) {
        held = held.slice(-2048);
      }
      return;
    }
    if (phase === 'pass') {
      if (opts.upper < 0 || pos < opts.upper) {
        watch(pkt, 0, 0, Infinity);
        self.push(pkt);
        return;
      }
      phase = 'tail';
      lastPat = -1; pesStart = -1; pesVerdict = -1;
    }
    /* tail: hold until the next keyframe at/after `upper`. */
    bound = opts.upper;
    held.push({ pos: pos, buf: pkt });
    var cut = watch(pkt, 0, 0, bound);
    if (cut >= 0) {
      emitFrom(self, -1, cut);
      finish(self, cut);
    } else if (pos - bound > LOOKAHEAD_BYTES) {
      held = [];
      finish(self, bound);
    }
  }
  var t = new Transform({
    transform: function (chunk, enc, cb) {
      if (done) { return cb(); }
      var buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      var n = Math.floor(buf.length / PACKET) * PACKET;
      for (var o = 0; o < n && !done; o += PACKET) {
        onPacket(this, buf.slice(o, o + PACKET));
        pos += PACKET;
      }
      carry = n < buf.length ? buf.slice(n) : null;
      cb();
    },
    flush: function (cb) {
      if (!done) {
        /* End of the file (or of the requested range). */
        if (phase === 'seek') { emitFrom(this, opts.lower, -1); started(opts.lower); }
        else if (held.length) { emitFrom(this, -1, -1); }
        if (carry && phase !== 'seek') { this.push(carry); }
        done = true;
        if (opts.onCut) { opts.onCut(pos); }
      }
      cb();
    }
  });
  return t;
}

module.exports = {
  SEGMENT_SECONDS: SEGMENT_SECONDS,
  LOOKAHEAD_BYTES: LOOKAHEAD_BYTES,
  supported: supported,
  plan: plan,
  createCutter: createCutter,
  nalVerdict: nalVerdict
};
