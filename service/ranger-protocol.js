'use strict';
// SLB v11 recovered from Ranger and checked against its isolated native routines.
const crypto = require('crypto');
const ALPHABET = 'jWB7YtC3n9iXbEkUcJl1VxF4STpQoOIaRmh2M-efAgLwPqGr6uyD5vNsdH_Kz0Z8';
const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SALT = '9B4F4CE2168E11EF8DCE000C297524BB';
const LIVE_V9_SALT = '93DDB237F6944625B0A1914C5ED4A15F';
const MASK = (1n << 64n) - 1n;
function rotate(value, bits) { return ((value << bits) | (value >> (64n - bits))) & MASK; }
function finish(value) {
  value = ((value ^ (value >> 33n)) * 0xff51afd7ed558ccdn) & MASK;
  value = ((value ^ (value >> 33n)) * 0xc4ceb9fe1a85ec53n) & MASK;
  return value ^ (value >> 33n);
}
function murmur128(data, seed) {
  let h1 = BigInt(seed >>> 0), h2 = h1;
  const c1 = 0x87c37b91114253d5n, c2 = 0x4cf5ad432745937fn;
  const whole = data.length - data.length % 16;
  for (let at = 0; at < whole; at += 16) {
    const k1 = data.readBigUInt64LE(at), k2 = data.readBigUInt64LE(at + 8);
    h1 ^= rotate(k1 * c1 & MASK, 31n) * c2 & MASK;
    h1 = ((rotate(h1, 27n) + h2) * 5n + 0x52dce729n) & MASK;
    h2 ^= rotate(k2 * c2 & MASK, 33n) * c1 & MASK;
    h2 = ((rotate(h2, 31n) + h1) * 5n + 0x38495ab5n) & MASK;
  }
  const tail = data.subarray(whole);
  let k1 = 0n, k2 = 0n;
  for (let i = 0; i < tail.length; i++) {
    if (i < 8) k1 |= BigInt(tail[i]) << BigInt(i * 8);
    else k2 |= BigInt(tail[i]) << BigInt((i - 8) * 8);
  }
  if (tail.length > 8) h2 ^= rotate(k2 * c2 & MASK, 33n) * c1 & MASK;
  if (tail.length) h1 ^= rotate(k1 * c1 & MASK, 31n) * c2 & MASK;
  h1 ^= BigInt(data.length); h2 ^= BigInt(data.length);
  h1 = (h1 + h2) & MASK; h2 = (h2 + h1) & MASK;
  h1 = finish(h1); h2 = finish(h2);
  h1 = (h1 + h2) & MASK; h2 = (h2 + h1) & MASK;
  const output = Buffer.alloc(16);
  output.writeBigUInt64LE(h1); output.writeBigUInt64LE(h2, 8);
  return output;
}
function create(digest) {
  if (typeof digest !== 'function') throw Error('Ranger digest implementation required');
  function parameters(communicationKey, resource) {
    const salt = /^(req|resp):\/slb\/v9\/live$/.test(resource) ? LIVE_V9_SALT : SALT;
    const key = digest(Buffer.from(communicationKey + salt, 'utf8'));
    const uri = 'http://encrypt.io?scheme=aes-cbc-128-o2&key=' + key + '&resource=' + resource;
    return { key: Buffer.from(key, 'hex'), iv: murmur128(Buffer.from(uri, 'utf8'), 0x5f325ab6) };
  }
  function encodeRequest(entries, communicationKey, route = '/slb/v11/vod') {
    return encodePlain(JSON.stringify(entries), communicationKey, route);
  }
  function encodePlain(plain, communicationKey, route) {
    const params = parameters(communicationKey, 'req:' + route);
    const cipher = crypto.createCipheriv('aes-128-cbc', params.key, params.iv);
    const encoded = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
    return [...encoded.replace(/=+$/, '')].map(c => ALPHABET[STANDARD.indexOf(c)]).join('');
  }
  function decodeResponse(wire, communicationKey, route = '/slb/v11/vod') {
    const encoded = [...wire.trim()].map(c => {
      const index = ALPHABET.indexOf(c);
      if (index < 0 && c !== '=') throw Error('Invalid SLB response encoding');
      return index < 0 ? c : STANDARD[index];
    }).join('');
    const params = parameters(communicationKey, 'resp:' + route);
    const cipher = crypto.createDecipheriv('aes-128-cbc', params.key, params.iv);
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(encoded, 'base64')), cipher.final()]).toString('utf8'));
  }
  return { parameters, encodeRequest, encodePlain, decodeResponse };
}
module.exports = { create, murmur128 };
