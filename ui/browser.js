'use strict';
window.desktop = {
  async service(method, parameters = {}) {
    const response = await fetch('/api/' + encodeURIComponent(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parameters)
    });
    if (!response.ok) {
      const plain = (response.headers.get('content-type') || '').startsWith('text/plain');
      const detail = plain && (await response.text()).trim().slice(0, 150);
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
