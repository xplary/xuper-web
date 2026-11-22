'use strict';
let restoringSession;
const homeSections = new Set(['featured', 'movies', 'series', 'anime', 'kids', 'free']);
const homeFreshMs = 5 * 60 * 1000;

async function sharedHome(root, request) {
  const key = new URL('/catalog-cache/' + root, location.origin).href;
  async function readOrFetch() {
    let cache;
    try {
      cache = await caches.open('xuper-home-v1');
      const saved = await cache.match(key);
      if (saved && Number(saved.headers.get('expires-at')) > Date.now()) return await saved.json();
    } catch { /* Storage can be unavailable in restricted profiles. */ }
    const data = await request();
    if (cache && data?.returnValue && Array.isArray(data.items) && data.items.length) {
      try {
        await cache.put(key, new Response(JSON.stringify(data), {
          headers: {'expires-at': String(Date.now() + homeFreshMs)}
        }));
      } catch { /* Storage quota must never prevent displaying fresh results. */ }
    }
    return data;
  }
  if (!navigator.locks) return readOrFetch();
  return navigator.locks.request('xuper-home-' + root, readOrFetch);
}

window.desktop = {
  browserFullscreen: true,
  playbackOnDemand: location.protocol === 'https:',
  service(method, parameters = {}) {
    const request = () => this.requestService(method, parameters);
    if (this.playbackOnDemand && method === 'home' && homeSections.has(parameters.root) &&
        Object.keys(parameters).length === 1) return sharedHome(parameters.root, request);
    return request();
  },
  async requestService(method, parameters, retried = false) {
    const response = await fetch('/api/' + encodeURIComponent(method), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parameters)
    });
    if (!response.ok) {
      const plain = (response.headers.get('content-type') || '').startsWith('text/plain');
      const detail = plain && (await response.text()).trim().slice(0, 150);
      if (!retried && response.status === 403 && detail === 'Vuelve a abrir la página de inicio.') {
        if (!restoringSession) restoringSession = fetch('/', {cache:'no-store',credentials:'same-origin'}).then(r => r.ok)
          .finally(() => { restoringSession = null; });
        if (await restoringSession) return this.requestService(method, parameters, true);
      }
      if (retried && detail === 'Vuelve a abrir la página de inicio.')
        return {returnValue:false,errorText:'Para reproducir, permite las cookies de este sitio en el navegador del televisor.'};
      return {returnValue: false, errorText: detail || 'Error HTTP ' + response.status};
    }
    return response.json();
  },
  fullscreen() {
    return document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  },
  openYoutube(value) {
    const url = new URL(value);
    if (url.protocol === 'https:' && /(^|\.)(youtube\.com|youtu\.be)$/.test(url.hostname))
      window.open(url.href, '_blank', 'noopener,noreferrer');
  },
  onAction() {}
};
