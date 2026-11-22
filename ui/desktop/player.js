(function () {
  'use strict';
  // Chromium needs MediaSource/HLS.js for HLS and raw MPEG-TS. Keep all of
  // the upstream player's controls, progress, episode and subtitle handlers.
  var nativeLoad = HTMLMediaElement.prototype.load;
  var nativePlay = HTMLMediaElement.prototype.play;
  var currentHls = null;
  var attachedUrl = '';
  var ready = null;
  function timeline(video, kind, complete, duration) {
    duration = Number(duration);
    video._xuperTimeline = {
      kind: kind, complete: !!complete,
      duration: complete && isFinite(duration) && duration > 0 ? duration : 0
    };
    // A generated TS playlist grows while its index is built. Its current
    // end is a transport boundary, not the full movie/episode duration.
    document.dispatchEvent(new CustomEvent('xuper:timeline', { detail: video._xuperTimeline }));
  }
  function reset() {
    if (currentHls) currentHls.destroy();
    currentHls = null;
    attachedUrl = '';
    ready = null;
  }
  HTMLMediaElement.prototype.load = function () {
    if (this.id !== 'player-video') return nativeLoad.call(this);
    var media = this;
    this._xuperResetTimeline = function () {
      reset();
      timeline(media, 'none', false, 0);
    };
    var source = this.querySelector('source');
    var url = source && source.getAttribute('src');
    if (!url) { reset(); timeline(this, 'none', false, 0); return nativeLoad.call(this); }
    var isHls = /\.m3u8(?:\?|$)/i.test(url);
    var internalPath = url.indexOf(location.origin + '/reproducir/') === 0
      ? url.slice((location.origin + '/reproducir/').length).replace(/^(proxy|relay)\//, '/')
      : url.replace(/^http:\/\/127\.0\.0\.1:\d+\//, '/');
    var isProxyTs = /^\/media\/[a-f0-9]+\/stream\.ts(?:\?|$)/i.test(internalPath);
    if (!isHls && !isProxyTs) {
      reset();
      var isRelay = internalPath.indexOf('/s/') === 0;
      timeline(this, isRelay ? 'relay' : 'native', !isRelay, 0);
      source.type = 'video/mp4';
      return nativeLoad.call(this);
    }
    if (!window.Hls || !Hls.isSupported()) {
      reset(); timeline(this, 'hls', false, 0);
      return nativeLoad.call(this);
    }
    var hlsUrl = isProxyTs ? url.replace('/stream.ts', '/stream.m3u8') : url;
    if (currentHls && attachedUrl === hlsUrl) return;
    reset();
    var video = this;
    video._xuperLevels = null;
    video._xuperSetLevel = null;
    video._xuperLevelNow = null;
    timeline(video, 'hls', false, 0);
    attachedUrl = hlsUrl;
    /* 3 min por delante y 90 s por detrás: saltos de hasta ~3 min o volver un
       poco atrás quedan dentro de lo ya descargado (salto instantáneo).
       maxBufferSize sube para que los títulos de más calidad no se queden
       en el límite de 60 MB de hls.js. */
    currentHls = new Hls({ enableWorker: true, maxBufferLength: 180,
      maxMaxBufferLength: 240, maxBufferSize: 150 * 1000 * 1000, backBufferLength: 90,
      xhrSetup: function (xhr) { xhr.withCredentials = false; } });
    var instance = currentHls;
    instance.on(Hls.Events.LEVEL_LOADED, function (_, data) {
      if (currentHls !== instance || !data || !data.details) return;
      var details = data.details;
      timeline(video, 'hls', details.live === false, details.totalduration);
    });
    /* Videoteca only (app.js sets video._xuperVt = { height }): its HLS lists
       real qualities (480p and 720p measured 13/11/2026). hls.js starts with
       the first one in the list (480p); start at the saved height instead
       (0 = Automática, starting at up to 720p) and let the player panel
       switch them. Every other source keeps hls.js defaults. */
    var vtPrefs = video._xuperVt;
    if (vtPrefs) {
      var levelFor = function (levels, height) {
        var best = -1, lowest = -1;
        for (var i = 0; i < levels.length; i++) {
          var h = levels[i].height || 0;
          if (lowest < 0 || h < (levels[lowest].height || 0)) lowest = i;
          if (h <= height && (best < 0 || h > (levels[best].height || 0))) best = i;
        }
        return best >= 0 ? best : lowest;
      };
      var announce = function () {
        if (currentHls === instance) document.dispatchEvent(new CustomEvent('xuper:hls-levels'));
      };
      instance.on(Hls.Events.MANIFEST_PARSED, function (_, data) {
        if (currentHls !== instance || !data || !data.levels || !data.levels.length) return;
        var levels = data.levels;
        video._xuperLevels = levels.map(function (l, i) { return { index: i, height: l.height || 0, bitrate: l.bitrate || 0 }; });
        var pref = Number(vtPrefs.height) || 0;
        var start = levelFor(levels, pref || 720);
        if (start >= 0) {
          if (pref) {
            instance.loadLevel = start;          // fixed quality
          } else {
            instance.startLevel = start;         // Automática: start here,
            instance.nextLoadLevel = start;      // then adapt as usual
          }
        }
        video._xuperSetLevel = function (height) {
          if (currentHls !== instance) return;
          vtPrefs.height = Number(height) || 0;
          instance.currentLevel = vtPrefs.height ? levelFor(instance.levels, vtPrefs.height) : -1;
          announce();
        };
        video._xuperLevelNow = function () {
          if (currentHls !== instance) return null;
          var index = instance.currentLevel >= 0 ? instance.currentLevel : instance.loadLevel;
          var level = instance.levels && instance.levels[index];
          return { auto: instance.autoLevelEnabled, height: level ? level.height || 0 : 0 };
        };
        announce();
      });
      instance.on(Hls.Events.LEVEL_SWITCHED, announce);
    }
    ready = new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () { finish(false); }, 20000);
      function finish(ok) { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } }
      instance.on(Hls.Events.MANIFEST_PARSED, function () { finish(true); });
      instance.on(Hls.Events.ERROR, function (_, data) {
        if (!data.fatal || currentHls !== instance) return;
        finish(false);
        var status = document.getElementById('player-status');
        /* Qué pasó y qué hacer: sin internet, el servidor o el propio vídeo. */
        var net = window.__xuperNet;
        var text = (net && !net.online) || navigator.onLine === false
          ? 'Sin conexión a internet: el vídeo se detuvo. Revisa tu wifi o el cable y pulsa Reintentar cuando vuelva.'
          : data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? 'Se perdió la conexión con el servidor del vídeo (tu internet funciona). Pulsa Reintentar en un momento.'
            : 'Este vídeo no se pudo leer. Pulsa Reintentar o prueba Modo Fluido.';
        if (status) { status.textContent = text; status.classList.add('is-active'); }
        if (net && data.type === Hls.ErrorTypes.NETWORK_ERROR) { document.dispatchEvent(new CustomEvent('xuper:net-failure')); }
        /* Let the app try another version of the title (app.js tryOtherVersion). */
        if (!((net && !net.online) || navigator.onLine === false)) {
          document.dispatchEvent(new CustomEvent('xuper:hls-fatal', { detail: { type: data.type, details: data.details } }));
        }
      });
      instance.on(Hls.Events.MEDIA_ATTACHED, function () { instance.loadSource(hlsUrl); });
      instance.attachMedia(video);
    });
  };
  HTMLMediaElement.prototype.play = function () {
    var video = this;
    if (this.id === 'player-video' && ready) {
      var instance = currentHls;
      return ready.then(function (ok) {
        if (!ok || currentHls !== instance) {
          /* Not an autoplay block: hls.js could not open this video (fatal
             error or no manifest in 20 s), or another video replaced it.
             app.js reads xuperUnavailable to show a real error message. */
          var unavailable = new DOMException('El vídeo no está disponible', 'AbortError');
          unavailable.xuperUnavailable = ok === false && currentHls === instance;
          unavailable.xuperReplaced = currentHls !== instance;
          throw unavailable;
        }
        return nativePlay.call(video);
      });
    }
    return nativePlay.call(this);
  };
})();
