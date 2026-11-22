'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const root = path.join(__dirname, 'ui');
const firstPort = Number(process.env.PORT || 4173);
let port = firstPort;
const publicUrl = process.env.RENDER_EXTERNAL_URL;
const publicOrigin = publicUrl && new URL(publicUrl).origin;
const host = publicOrigin ? '0.0.0.0' : '127.0.0.1';
if (publicOrigin && !publicOrigin.startsWith('https://')) throw new Error('Configura HTTPS.');
const publicMethods = new Set(['ping','keepAlive','heartbeat','home','search','detail','audioInfo',
  'mediaDuration','resolve','resolveSmooth','liveChannels','liveCategories','resolveLive','radioStations']);
const authority = () => host + ':' + port;
process.env.XUPER_DATA_DIR = path.join(__dirname, 'perfil-web');
fs.mkdirSync(process.env.XUPER_DATA_DIR, { recursive: true });
process.env.XUPER_FFMPEG_PATH ||= process.platform === 'win32'
  ? path.join(__dirname, 'bin', 'ffmpeg.exe') : '/usr/bin/ffmpeg';
process.env.XUPER_DESKTOP_TRANSCODE = '1';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon' };
let service;
const server = http.createServer(async (req, res) => {
  const fail = code => res.writeHead(code).end();
  try {
    const origin = publicOrigin || 'http://' + authority();
    if (publicOrigin && req.url === '/healthz') return res.writeHead(200).end('ok');
    if (req.headers.host !== new URL(origin).host) return fail(403);
    if (publicOrigin) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      if (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') return fail(403);
    }
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url, origin);
    const media = publicOrigin && /^\/reproducir\/(proxy|relay)(\/.*)$/.exec(url.pathname);
    if (media) {
      if (media[1] === 'proxy' && !/^\/(?:media|radio|sub|hls)\/[a-f0-9]{24}(?:[./]|$)/.test(media[2])) return fail(403);
      if (media[1] === 'relay' && !/^\/s\/[a-f0-9]+\.mp4$/.test(media[2])) return fail(403);
      if (!['GET','HEAD'].includes(req.method)) return fail(405);
      if (req.headers['sec-fetch-site'] === 'cross-site') return fail(403);
      const target = media[1] === 'relay' ? require('./service/ffmpeg-relay') : require('./service/proxy');
      const internalPort = target.port();
      if (!internalPort) return fail(503);
      const headers = req.headers.range ? {range: req.headers.range} : {};
      const upstream = http.request({ hostname: '127.0.0.1', port: internalPort, method: req.method,
        path: media[2] + url.search, headers }, reply => {
        for (const key of ['content-type','content-range','content-length','accept-ranges']) {
          if (reply.headers[key] !== undefined) res.setHeader(key, reply.headers[key]);
        }
        res.writeHead(reply.statusCode);
        pipeline(reply, res).catch(() => upstream.destroy());
      });
      upstream.on('error', () => { if (!res.headersSent && !res.destroyed) fail(502); });
      res.on('close', () => upstream.destroy());
      upstream.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST' || req.headers.origin !== origin ||
          req.headers['content-type'] !== 'application/json') return fail(403);
      const method = url.pathname.slice(5);
      if (publicOrigin && !publicMethods.has(method)) return fail(403);
      if (!service.methods.includes(method)) return fail(404);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) return fail(413);
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(400);
      const result = await service.call(method, payload, payload.background === true ? 180000 : undefined);
      if (publicOrigin && method.startsWith('resolve') && result.returnValue) {
        for (const key of ['headers','backupUrls','url']) delete result[key];
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(result));
    }
    if (!['GET','HEAD'].includes(req.method)) return fail(405);
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + path.sep) || !(await fs.promises.stat(file)).isFile()) return fail(404);
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    if (req.method === 'HEAD') return res.end();
    await pipeline(fs.createReadStream(file), res);
  } catch (err) {
    if (!res.headersSent && !res.destroyed) fail(err.code === 'ENOENT' ? 404 : 400);
  }
});
function openBrowser() {
  if (process.platform === 'win32' && process.argv.includes('--abrir')) {
    require('node:child_process').execFile('explorer.exe', ['http://' + authority()], () => {});
  }
}
async function isXuperRunning() {
  const origin = 'http://' + authority();
  try {
    const response = await fetch(origin + '/api/ping', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { origin, 'Content-Type': 'application/json' }, body: '{}'
    });
    if (!response.ok) return false;
    const info = await response.json();
    return info.returnValue === true && info.service === 'com.webosflux.xuptertv.fidelity.service';
  } catch { return false; }
}
server.on('error', async err => {
  if (!publicOrigin && err.code === 'EADDRINUSE') {
    if (await isXuperRunning()) {
      console.log('Xuper Web ya está en marcha en http://' + authority());
      openBrowser();
      return;
    }
    if (port < Math.min(firstPort + 9, 65535)) {
      port++;
      server.listen(port, host);
      return;
    }
    console.error('Todos los puertos del ' + firstPort + ' al ' + port + ' están ocupados.');
  } else console.error(err.message);
  process.exitCode = 1;
});
server.once('listening', () => {
  service = require('./desktop/service.cjs').createService();
  console.log('Xuper Web disponible en http://' + authority());
  openBrowser();
});
server.listen(port, host);
