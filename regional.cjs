'use strict';
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { fork, spawn } = require('node:child_process');
const { pipeline } = require('node:stream');
const path = require('node:path');

const cookie = '__Host-xuper-session';
const workerRole = process.env.XUPER_ROLE === 'worker' && !!process.send;
const regionalRole = process.env.XUPER_ROLE === 'regional';
const fs = require('node:fs');
const rawProfile = fs.existsSync('/etc/secrets/wireguard.conf');
const hasProfile = rawProfile || fs.existsSync('/etc/secrets/wireproxy.conf');
const vpn = process.env.XUPER_EGRESS ? process.env.XUPER_EGRESS === 'wireguard'
  : process.env.RENDER === 'true' && !regionalRole && hasProfile;
const secret = process.env.XUPER_REGIONAL_SECRET || (vpn ? crypto.randomBytes(32).toString('hex') : '');
const countries = new Set((process.env.XUPER_COUNTRIES || 'PE').split(',').map(s => s.trim().toUpperCase()));
const workers = new Map();
const maxSessions = Number(process.env.XUPER_MAX_SESSIONS || 2);
if ((regionalRole || vpn) && (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || secret.length < 32))
  throw new Error('Revisa XUPER_MAX_SESSIONS y XUPER_REGIONAL_SECRET (mínimo 32 caracteres).');

function error(res, status, message) {
  res.writeHead(status, {'content-type':'text/plain; charset=utf-8','cache-control':'private, no-store'});
  res.end(message);
}
function sign(id) {
  return crypto.createHmac('sha256', secret).update('visitor/' + id).digest('hex');
}
function equal(a, b) {
  const hash = v => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}
function forward(req, res, target, route, headers) {
  const client = target.protocol === 'https:' ? https : http;
  const outgoing = client.request({protocol:target.protocol, hostname:target.hostname, port:target.port,
    path:route, method:req.method, headers}, incoming => {
    for (const key of ['content-type','content-length','content-range','accept-ranges','retry-after'])
      if (incoming.headers[key] !== undefined) res.setHeader(key,incoming.headers[key]);
    res.writeHead(incoming.statusCode);
    pipeline(incoming,res,()=>outgoing.destroy());
  });
  outgoing.setTimeout(200000,()=>outgoing.destroy());
  outgoing.on('error',()=>{ if (!res.headersSent && !res.destroyed) error(res,502,'El servicio regional no responde.'); else res.destroy(); });
  res.on('close',()=>outgoing.destroy());
  req.pipe(outgoing);
}
function requestHeaders(req) {
  const headers = {};
  for (const key of ['range','content-type','origin','sec-fetch-site'])
    if (req.headers[key] !== undefined) headers[key] = req.headers[key];
  return headers;
}
async function gateway(req, res, url) {
  // Only trust the geolocation supplied by the public Render edge.
  const country = req.headers['cf-ipcountry'];
  if (process.env.RENDER !== 'true' || !/^[A-Z]{2}$/.test(country || '') || country === 'XX' || !countries.has(country)) {
    error(res,403,'Acceso disponible únicamente desde los países habilitados.');
    return true;
  }
  const remote = process.env.XUPER_REGIONAL_URL;
  if (!vpn && (!remote || secret.length < 32 || new URL(remote).protocol !== 'https:')) {
    if (!/^\/(api|reproducir)\//.test(url.pathname)) return false;
    error(res,503,'Falta configurar el servicio regional en Render.');
    return true;
  }
  const match = /(?:^|;\s*)__Host-xuper-session=([a-f0-9]{32})\.([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  let id = match && equal(sign(match[1]),match[2]) && match[1];
  if (!id && (url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
    id = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie',cookie+'='+id+'.'+sign(id)+'; Path=/; Secure; HttpOnly; SameSite=Lax');
  }
  if (!/^\/(api|reproducir)\//.test(url.pathname)) return false;
  if (!id) { error(res,403,'Vuelve a abrir la página de inicio.'); return true; }
  if (url.pathname.startsWith('/api/') && (req.method !== 'POST' || req.headers.origin !== url.origin)) {
    error(res,403,'Solicitud no permitida.'); return true;
  }
  if (vpn) {
    await serveSession(req,res,url,id);
    return true;
  }
  forward(req,res,new URL(remote),url.pathname+url.search,{
    ...requestHeaders(req),authorization:'Bearer '+secret,'x-xuper-session':id
  });
  return true;
}
function startWorker(id) {
  const env = {...process.env, PORT:'0', XUPER_ROLE:'worker', RENDER_EXTERNAL_URL:publicAddress()};
  if (vpn) {
    env.LD_PRELOAD = 'libproxychains.so.4';
    env.PROXYCHAINS_CONF_FILE = path.join(__dirname,'proxychains.conf');
  }
  delete env.XUPER_REGIONAL_SECRET;
  const child = fork(path.join(__dirname,'server.cjs'),[],{env});
  const entry = {child,busy:0,last:Date.now()};
  entry.ready = new Promise((resolve,reject)=>{
    const timer = setTimeout(()=>{ reject(new Error('Arranque agotado')); child.kill(); },20000);
    child.once('message',msg=>{clearTimeout(timer);resolve(msg.port);});
    child.once('error',err=>{clearTimeout(timer);reject(err);});
    child.once('exit',()=>{clearTimeout(timer);workers.delete(id);reject(new Error('Sesión cerrada'));});
  });
  workers.set(id,entry);
  return entry;
}
async function regional(req,res,url) {
  if (!equal(req.headers.authorization || '', 'Bearer '+secret)) return error(res,403,'Acceso privado.');
  const id = req.headers['x-xuper-session'];
  if (!/^[a-f0-9]{32}$/.test(id || '') || !/^\/(api|reproducir)\//.test(url.pathname)) return error(res,404,'Ruta desconocida.');
  return serveSession(req,res,url,id);
}
function publicAddress() {
  return regionalRole ? process.env.XUPER_PUBLIC_ORIGIN : process.env.RENDER_EXTERNAL_URL;
}
async function serveSession(req,res,url,id) {
  // Catalogue and liveness requests never allocate a personal player.
  const shared = /^\/api\/(ping|heartbeat|keepAlive|home|search|detail|audioInfo|liveChannels|liveCategories|radioStations)$/.test(url.pathname)
    || url.pathname.startsWith('/reproducir/proxy/radio/');
  if (shared) id = 'catalogue';
  let entry = workers.get(id);
  if (!entry && !url.pathname.startsWith('/api/')) return error(res,410,'La sesión ha caducado.');
  const players = workers.size - Number(workers.has('catalogue'));
  if (!shared && !entry && !['/api/resolve','/api/resolveLive','/api/resolveSmooth'].includes(url.pathname))
    return error(res,403,'Operación sin una reproducción activa.');
  if (!shared && !entry && players >= maxSessions) return error(res,503,'Los reproductores están ocupados. Intenta más tarde.');
  entry ||= startWorker(id);
  entry.busy++;
  res.once('close',()=>{entry.busy--;entry.last=Date.now();});
  let port;
  try { port = await entry.ready; }
  catch { if (!res.destroyed) error(res,503,'El servicio regional no está disponible.'); return; }
  if (res.destroyed) return;
  forward(req,res,new URL('http://127.0.0.1:'+port),url.pathname+url.search,{
    ...requestHeaders(req),host:new URL(publicAddress()).host
  });
}
if (regionalRole || (vpn && !workerRole)) {
  if (new URL(publicAddress()).protocol !== 'https:') throw new Error('Configura el origen público con HTTPS.');
  setInterval(()=>{
    for (const entry of workers.values())
      if (!entry.busy && Date.now()-entry.last > 10*60000 && entry.child.connected) entry.child.disconnect();
  },60000).unref();
}
if (vpn && !workerRole) {
  const config = rawProfile ? path.join(__dirname,'wireproxy.ini') : '/etc/secrets/wireproxy.conf';
  const client = spawn('wireproxy',['-s','-c',config],{stdio:'ignore'});
  const stopped = ()=>{ console.error('WireGuard no está disponible. Revisa el archivo secreto wireproxy.conf.'); process.exit(1); };
  client.once('exit',stopped);
  client.once('error',stopped);
  process.once('exit',()=>client.kill());
}
async function verifyExit() {
  if (!vpn) return;
  if (!require('node:fs').readFileSync('/proc/self/maps','utf8').includes('libproxychains'))
    throw new Error('No se cargó el transporte regional.');
  const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace',{signal:AbortSignal.timeout(10000),redirect:'error'});
  const country = /^loc=([A-Z]{2})$/m.exec(await response.text())?.[1];
  if (!response.ok || country !== (process.env.XUPER_EXIT_COUNTRY || 'MX'))
    throw new Error('El país de salida del servicio no coincide con el configurado.');
}
module.exports = {workerRole,regionalRole,gateway,regional,verifyExit};
