/* =============================================================================
   XuperTV 4.34.4  ->  LG webOS 4 (Chromium 53) fidelity reconstruction
   -----------------------------------------------------------------------------
   All geometry comes from the decoded Android resources:
     res/layout/*.xml, res/values/{colors,dimens,styles}.xml, values-es/strings.xml
   Scale: design_width 1920 / design_width_in_dp 1280  =>  1dp = 1.5px
   Content that the APK loads from its backend (posters, channel logos, QR,
   tab icons/order, home logo) is represented with the original "no data"
   assets and flagged in the audit documents. VOD data may additionally come
   from a separately configured, authorized API; no APK endpoint, credential
   or DRM logic is reproduced here.
   ============================================================================= */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ utils */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = text; }
    return n;
  }
  function $(id) { return document.getElementById(id); }
  function clear(n) { while (n.firstChild) { n.removeChild(n.firstChild); } }
  function abs(n, x, y, w, h) {
    n.style.position = 'absolute';
    n.style.left = x + 'px';
    n.style.top = y + 'px';
    if (w !== undefined) { n.style.width = w + 'px'; }
    if (h !== undefined) { n.style.height = h + 'px'; }
    return n;
  }
  function closest(node, sel) {
    while (node && node !== document) {
      if (node.nodeType === 1 && node.matches && node.matches(sel)) { return node; }
      node = node.parentNode;
    }
    return null;
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function norm(s) {
    s = String(s).toLowerCase();
    if (s.normalize) {
      s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    return s;
  }
  function each(list, fn) { for (var i = 0; i < list.length; i++) { fn(list[i], i); } }

  /* ------------------------------------------------------------- demo data */
  /* Server-driven in the real APK. These records only exercise the layouts. */
  var GENRES = ['Acción', 'Drama', 'Comedia', 'Suspenso', 'Aventura',
                'Animación', 'Familiar', 'Ciencia ficción'];

  var VOD = [];
  var CATEGORY_BY_PREFIX = {
    'Destacado': 'destacado', 'Película': 'pelicula', 'Serie': 'serie',
    'Gratis': 'gratis', 'Infantil': 'infantil', 'UHD': 'uhd', 'Extra': 'extra'
  };
  function addVod(prefix, count, base) {
    for (var i = 1; i <= count; i++) {
      var g1 = GENRES[(base + i) % GENRES.length];
      var g2 = GENRES[(base + i + 3) % GENRES.length];
      VOD.push({
        id: VOD.length + 1,
        title: prefix + ' demo ' + pad2(i),
        category: CATEGORY_BY_PREFIX[prefix] || '',
        score: (7.9 + ((base + i) % 16) / 10).toFixed(1),
        year: 2018 + ((base + i) % 7),
        duration: (1 + ((base + i) % 2)) + ' h ' + (10 + ((base * 7 + i * 5) % 45)) + ' min',
        genres: g1 === g2 ? [g1] : [g1, g2],
        director: 'Director demo ' + pad2(i),
        actors: 'Actor demo ' + pad2(i) + ', Actriz demo ' + pad2(i + 1),
        synopsis: 'Sinopsis de demostración para ' + prefix.toLowerCase() + ' demo ' + pad2(i) +
          '. Este texto sólo existe para comprobar el recorte a dos líneas, el interlineado y ' +
          'la sangría de la etiqueta "Sinopsis :" definidos en activity_voddetails.',
        kind: prefix.toLowerCase()
      });
    }
  }
  addVod('Destacado', 5, 1);
  addVod('Película', 7, 2);
  addVod('Serie', 7, 3);
  addVod('Gratis', 5, 4);
  addVod('Infantil', 8, 5);
  addVod('UHD', 4, 6);
  addVod('Extra', 4, 7);

  /* ------------------------------------------------------------- VOD API
     XMLHttpRequest is used deliberately: it works on Chromium 53, where
     fetch/async functions are not a safe webOS 4 baseline. */
  var vodApi = window.XUPERTV_API || {};
  /* Desktop harness override: ?service=http://127.0.0.1:8910 */
  var devServiceParam = /[?&]service=([^&]+)/.exec(window.location.search || '');
  if (devServiceParam) { vodApi.devServiceUrl = decodeURIComponent(devServiceParam[1]); }
  var vodApiState = { loading: false, source: 'demo', error: null };
  var portalState = { refreshing: false, lastSync: 0, roots: 0, error: null };
  var PORTAL_ROOTS = ['featured', 'movies', 'series', 'anime', 'kids', 'free'];
  /* Portal rows as sent ({root, name, ids}). A title can sit in several rows,
     but the merged catalogue keeps only one `row`, so the rankings (TOP15)
     and the yearly rows are kept here for the search screen. */
  var portalRows = [];

  function apiArray(payload) {
    if (Object.prototype.toString.call(payload) === '[object Array]') { return payload; }
    if (!payload) { return []; }
    var keys = ['items', 'movies', 'results', 'recommendList', 'movieList',
                'totalMovieList', 'programList', 'data'];
    for (var i = 0; i < keys.length; i++) {
      if (Object.prototype.toString.call(payload[keys[i]]) === '[object Array]') {
        return payload[keys[i]];
      }
      if (payload[keys[i]] && typeof payload[keys[i]] === 'object') {
        var nested = apiArray(payload[keys[i]]);
        if (nested.length) { return nested; }
      }
    }
    return [];
  }

  function apiError(payload) {
    if (!payload || typeof payload !== 'object') { return ''; }
    var code = payload.returnCode || payload.code || payload.errorCode || '';
    var message = payload.errorMessage || payload.message || payload.msg || '';
    if (!code && !message) { return ''; }
    return (code ? String(code) + ': ' : '') + (message ? String(message) : 'La API rechazó la petición');
  }

  function apiUrl(kind) {
    var direct = vodApi[kind + 'Url'];
    if (direct) { return String(direct); }
    var base = String(vodApi.baseUrl || '').replace(/\/$/, '');
    var path = String(vodApi[kind + 'Path'] || '');
    return base && path ? base + (path.charAt(0) === '/' ? path : '/' + path) : '';
  }

  function xuperSession() {
    var session = vodApi.session || {};
    return {
      userId: String(session.userId || ''),
      userToken: String(session.userToken || ''),
      portalCode: String(session.portalCode || ''),
      homePageCode: String(session.homePageCode || ''),
      version: String(session.version || '4.34.4')
    };
  }

  function hasXuperSession() {
    var session = xuperSession();
    return !!(session.userId && session.userToken && session.portalCode);
  }

  function xuperPayload(kind, value) {
    var session = xuperSession();
    if (kind === 'catalog') {
      return {
        userId: session.userId,
        userToken: session.userToken,
        portalCode: session.portalCode,
        homePageCode: session.homePageCode,
        version: session.version
      };
    }
    if (kind === 'search') {
      return {
        userToken: session.userToken,
        userId: session.userId,
        portalCode: session.portalCode,
        columnId: '',
        value: value || '',
        type: '',
        pageSize: 20,
        pageNum: 1,
        filter: ''
      };
    }
    return {
      userToken: session.userToken,
      userId: session.userId,
      portalCode: session.portalCode,
      programId: value
    };
  }

  function apiImage(value) {
    if (!value) { return ''; }
    value = String(value);
    if (/^https?:\/\//i.test(value) || value.indexOf('data:') === 0) { return value; }
    if (!vodApi.imageBaseUrl) { return value; }
    return String(vodApi.imageBaseUrl).replace(/\/$/, '') + '/' + value.replace(/^\//, '');
  }

  function apiText(value, fallback) {
    return value === undefined || value === null || value === '' ? fallback : String(value);
  }

  function isSeriesItem(item) {
    if (!item) { return false; }
    return item.type === 'teleplay' || item.type === 'series' || item.kind === 'serie' ||
           (item.category && item.category.indexOf('serie') !== -1) ||
           (item.episodes && item.episodes.length > 0) ||
           (item.seasons && item.seasons.length > 0) ||
           (item.volumeCount && parseInt(item.volumeCount, 10) > 1);
  }

  function normalizeVod(raw, index) {
    raw = raw || {};
    var genres = raw.genres || raw.genre || [];
    if (typeof genres === 'string') { genres = genres.split(','); }
    if (Object.prototype.toString.call(genres) !== '[object Array]') { genres = []; }
    var names = [];
    for (var i = 0; i < genres.length; i++) {
      names.push(typeof genres[i] === 'string' ? genres[i] : (genres[i].name || ''));
    }
    var runtime = raw.duration || raw.runtimeSeconds || '';
    if (!durationToSeconds(runtime) && raw.runtimeMinutes) runtime = Number(raw.runtimeMinutes) * 60;
    if (!durationToSeconds(runtime) && raw.runtime) runtime = typeof raw.runtime === 'number' ? raw.runtime * 60 : raw.runtime;
    var type = apiText(raw.type || raw.programType, '');
    var isSeries = type === 'teleplay' || type === 'series' || norm(apiText(raw.kind || '', '')) === 'serie' ||
                   norm(apiText(raw.category || '', '')).indexOf('serie') !== -1 ||
                   (raw.episodes && raw.episodes.length > 0) ||
                   (raw.seasons && raw.seasons.length > 0) ||
                   (raw.volumeCount && parseInt(raw.volumeCount, 10) > 1) ||
                   (raw.volumnCount && parseInt(raw.volumnCount, 10) > 1);
    return {
      id: apiText(raw.id || raw.vodId || raw.programId || raw.program_id || raw.tmdb_id, 'api-' + index),
      title: apiText(raw.title || raw.name || raw.programName || raw.programTitle || raw.original_title, 'Sin título'),
      category: norm(apiText(raw.category || raw.section || raw.collection || raw.homeSection, '')),
      score: apiText(raw.score || raw.vote_average || raw.rating || raw.movieRate || raw.programScore, '—'),
      year: apiText(raw.year || raw.release_year || raw.programYear || (raw.releaseDate || raw.releaseTime || raw.release_date || '').slice(0, 4), '—'),
      duration: apiText(runtime, '—'),
      genres: names.length ? names : ['Sin clasificar'],
      director: apiText(raw.director, '—'),
      actors: apiText(raw.actors || raw.actorDisplay || raw.cast, '—'),
      synopsis: apiText(raw.synopsis || raw.overview || raw.description || raw.programUpdateContent, 'Sin sinopsis disponible.'),
      kind: isSeries ? 'serie' : apiText(raw.kind || raw.media_type, 'película'),
      poster: apiImage(raw.posterUrl || raw.poster_url || raw.poster || raw.poster_path || raw.image || raw.imageUrl || raw.cover || raw.coverUrl || raw.programPoster || raw.programImage),
      landscape: apiImage(raw.landscapeUrl || raw.landscape_url || raw.landscape || raw.wideImage || raw.bannerImage),
      backdrop: apiImage(raw.backdropUrl || raw.backdrop_url || raw.backdrop || raw.backdrop_path),
      streamUrl: raw.streamUrl || raw.stream_url || '',
      /* Magis portal records (service / snapshot). */
      type: type || (isSeries ? 'teleplay' : 'movie'),
      row: apiText(raw.row, ''),
      shelveTime: apiText(raw.shelveTime, ''),
      alias: apiText(raw.alias, ''),
      country: apiText(raw.country || raw.originalCountry, ''),
      releaseDate: apiText(raw.releaseDate || raw.releaseTime, ''),
      tagline: apiText(raw.tagline || raw.viewPoint, ''),
      volumeCount: parseInt(raw.volumeCount || raw.volumnCount, 10) || 0,
      updateCount: parseInt(raw.updateCount, 10) || 0,
      episodes: raw.episodes || [],
      seasons: raw.seasons || [],
      moreAudio: raw.moreAudio !== undefined ? raw.moreAudio : 0,
      moreSubtitle: raw.moreSubtitle !== undefined ? raw.moreSubtitle : 0,
      _portal: raw.portal === true || raw._portal === true || (vodApi && vodApi.mode === 'portal' && String(raw.id || '').length > 10)
    };
  }

  function apiRequest(url, done, options) {
    options = options || {};
    var xhr = new XMLHttpRequest();
    var finished = false;
    var timeout = parseInt(vodApi.timeoutMs, 10) || 10000;
    function finish(error, payload) {
      if (finished) { return; }
      finished = true;
      done(error, payload);
    }
    xhr.open(options.method || 'GET', url, true);
    xhr.timeout = timeout;
    var headers = vodApi.headers || {};
    for (var name in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, name)) { xhr.setRequestHeader(name, headers[name]); }
    }
    if (options.body !== undefined && !headers['Content-Type'] && !headers['content-type']) {
      xhr.setRequestHeader('Content-Type', 'application/json;charset=utf-8');
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) { return; }
      if (xhr.status < 200 || xhr.status >= 300) { finish('HTTP ' + xhr.status); return; }
      try { finish(null, JSON.parse(xhr.responseText)); }
      catch (err) { finish('La API no devolvió JSON válido'); }
    };
    xhr.onerror = function () { finish('Error de red o CORS'); };
    xhr.ontimeout = function () { finish('Tiempo de espera agotado'); };
    try { xhr.send(options.body === undefined ? null : JSON.stringify(options.body)); }
    catch (err) { finish(err.message || 'No se pudo iniciar la petición'); }
  }

  /* Some portal catalogues publish every season as a separate series card
     ("The Walking Dead T1", "The Walking Dead T2", ...).  Treat only an
     explicit trailing season marker as a grouping signal; ordinary titles
     such as spin-offs are left untouched. */
  function catalogSeasonMarker(item) {
    if (!item || !isSeriesItem(item)) { return null; }
    var title = String(item.title || item.alias || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    var match = /^(.*?)(?:\s*[-–:|]?\s*(?:temporada|season)\s*(\d+)|\s*[-–:|]?\s*[st]\s*0?(\d+))\s*$/i.exec(title);
    if (!match || !match[1]) { return null; }
    var number = parseInt(match[2] || match[3], 10);
    if (!number || number > 99) { return null; }
    return { title: match[1].replace(/\s+$/, ''), number: number };
  }

  function groupCatalogSeasons(items) {
    var groups = {}, out = [];
    for (var i = 0; i < items.length; i++) {
      var marker = catalogSeasonMarker(items[i]);
      if (!marker) { out.push(items[i]); continue; }
      var key = norm(marker.title);
      if (!groups[key]) { groups[key] = { title: marker.title, items: [] }; }
      groups[key].items.push({ item: items[i], number: marker.number });
    }
    for (var key in groups) {
      if (!groups.hasOwnProperty(key)) { continue; }
      var group = groups[key];
      if (group.items.length < 2) {
        out.push(group.items[0].item);
        continue;
      }
      group.items.sort(function (a, b) { return a.number - b.number; });
      var main = group.items[0].item;
      var allCats = {};
      main._catalogSeasons = [];
      main._seriesGroup = true;
      main._seriesTitle = group.title;
      main.title = group.title;
      main.alias = group.title;
      main.seasons = [];
      for (var s = 0; s < group.items.length; s++) {
        var part = group.items[s];
        var cats = String(part.item.category || '').split(',');
        for (var c = 0; c < cats.length; c++) { if (cats[c]) { allCats[cats[c]] = true; } }
        var season = { id: part.item.id, number: part.number, title: group.title };
        main._catalogSeasons.push(season);
        main.seasons.push(season);
      }
      main.category = Object.keys(allCats).join(',');
      out.push(main);
    }
    return out;
  }

  function replaceVod(records, source, portal) {
    if (!records.length) { return false; }
    var previous = {};
    for (var p = 0; p < VOD.length; p++) { previous[String(VOD[p].id)] = VOD[p]; }
    VOD.splice(0, VOD.length);
    var normalizedItems = [];
    for (var i = 0; i < records.length; i++) {
      var item = normalizeVod(records[i], i + 1);
      if (portal && records[i].portal !== false) { item._portal = true; }
      var old = previous[String(item.id)];
      if (old) {
        /* Keep what the detail/player already learned about this title. */
        if (old.episodes) { item.episodes = old.episodes; }
        if (old.seasons) { item.seasons = old.seasons; }
        if (old._detailsLoaded) { item._detailsLoaded = true; }
        if (!item.streamUrl && old.streamUrl) { item.streamUrl = old.streamUrl; }
      }
      normalizedItems.push(item);
    }
    var catalogItems = groupCatalogSeasons(normalizedItems);
    for (var n = 0; n < catalogItems.length; n++) {
      VOD.push(catalogItems[n]);
    }
    document.dispatchEvent(new Event('xuper:catalog-updated'));
    if (state.detail) {
      var foundDetail = false;
      for (var d = 0; d < VOD.length; d++) {
        if (String(VOD[d].id) === String(state.detail.id)) {
          state.detail = VOD[d];
          foundDetail = true;
          break;
        }
      }
      if (!foundDetail) { state.detail = VOD[0]; }
    }
    vodApiState.source = source;
    vodApiState.error = null;
    refreshVodViews();
    return true;
  }

  /* A real catalog may not have every home section. Prefer the declared
     category, then fall back to positional demo slices so the reconstructed
     layouts always have content to show. */
  function vodFor(category, count, fallbackStart) {
    var out = [], i;
    if (category) {
      for (i = 0; i < VOD.length; i++) {
        var cats = norm(VOD[i].category || '').split(',');
        if (cats.indexOf(category) !== -1) { out.push(VOD[i]); }
      }
    }
    if (!out.length) { out = VOD.slice(fallbackStart, fallbackStart + count); }
    if (!out.length) { out = VOD.slice(0, count); }
    /* Fill short sections with other catalog entries so the sample never shows
       one poster repeated across a whole mosaic. A real backend normally sends
       enough items per section; this only affects the bundled demo catalog. */
    if (out.length < count && VOD.length) {
      var seen = {};
      for (i = 0; i < out.length; i++) { seen[String(out[i].id)] = true; }
      var cursor = 0;
      while (out.length < count && cursor < VOD.length * 2) {
        var cand = VOD[cursor % VOD.length];
        cursor++;
        if (!seen[String(cand.id)]) {
          out.push(cand);
          seen[String(cand.id)] = true;
        }
      }
    }
    return out;
  }

  function refreshVodViews() {
    if (homeBuilt) {
      var rail = $('home-tabs');
      var railWasExpanded = !!(rail && rail.classList.contains('is-expanded') && !rail.classList.contains('is-collapsed'));
      var focusWasTab = !!(state.focus && state.focus._tab !== undefined);
      var focusWasNotify = !!(state.focus && closest(state.focus, '#home-notify'));
      var hadContentFocus = !!(state.focus && closest(state.focus, '.home-page'));
      pages = [];
      tabEls = [];
      buildHome();
      selectTab(state.tab, false);
      if (state.screen === 'home') {
        if (focusWasTab && tabEls[state.tab]) { setFocus(tabEls[state.tab], true); }
        else if (focusWasNotify) {
          var n = firstIn($('home-notify'));
          if (n) { setFocus(n, true); }
        } else if (hadContentFocus) {
          var page = pages[TABS[state.tab].page];
          var f = page ? firstIn(page) : null;
          if (f) { setFocus(f, true); }
        }
        if (railWasExpanded && rail) {
          /* The reference keeps the full labels on the first paint even while
             the content holds focus; preserve that across a catalog refresh. */
          rail.classList.add('is-expanded');
          rail.classList.remove('is-collapsed');
          var railBg = document.querySelector('.home-sidebar-bg');
          if (railBg) { railBg.classList.add('is-on'); }
        }
      }
    }
    if (searchKeyboard) { buildSearch(); if (state.searchQuery) { runSearch(); } }
    if (state.detail) { buildDetail(state.detail); }
  }

  function bundledCatalog() {
    var data = window.XUPERTV_CATALOG;
    return data ? apiArray(data) : [];
  }

  /* ------------------------------------------------------ portal service
     The Magis portal answers no CORS preflight, so the page cannot call it.
     The bundled Node service speaks the encrypted protocol and returns plain
     JSON over Luna; devServiceUrl mirrors the same methods for desktop tests. */
  function hasLuna() {
    if (window.PalmServiceBridge && (!window.webOS || !window.webOS.service)) {
      window.webOS = window.webOS || {};
      window.webOS.service = {
        request: function (uri, opts) {
          opts = opts || {};
          var bridge = new window.PalmServiceBridge();
          bridge.onservicecallback = function (msg) {
            var res;
            try { res = JSON.parse(msg); } catch (e) { res = { returnValue: false, errorText: msg }; }
            if (res.returnValue === false) {
              if (opts.onFailure) { opts.onFailure(res); }
            } else {
              if (opts.onSuccess) { opts.onSuccess(res); }
            }
          };
        var fullUri = opts.method ? (uri.replace(/\/$/, '') + '/' + opts.method) : uri;
        bridge.call(fullUri, JSON.stringify(opts.parameters || {}));
        return bridge;
      }
    };
  }
  return !!(window.webOS && window.webOS.service && window.webOS.service.request);
}

function queryString(params) {
  var parts = [];
  for (var k in params) {
    if (Object.prototype.hasOwnProperty.call(params, k)) {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
  }
  return parts.join('&');
}

/* ls-hubd refuses a call when the app is missing from the service ACL, which
   happens when the installed manifest is stale after an update.  "Denied
   method netdiag for category /" means nothing to a viewer, so translate it
   into the two things that actually fix it and keep the raw text in brackets
   for whoever supports the TV. */
var SERVICE_BLOCKED_HINT = 'La TV tiene bloqueado el servicio de XuperTV. ' +
  'Desenchufa la TV 10 segundos y vuelve a abrir la app; si sigue igual, ' +
  'reinstala con el instalador.';
function describeServiceError(text) {
  var raw = String(text == null ? '' : text);
  if (window.XUPER_DESKTOP) { return raw; }
  if (/denied|permission|not permitted/i.test(raw)) {
    return SERVICE_BLOCKED_HINT + ' (' + raw + ')';
  }
  return raw;
}

/* ------------------------------------------------------------------
   Conexión a internet (escritorio). Separa los dos problemas que el
   usuario puede tener: "no tengo internet" (lo arregla él: wifi, cable) y
   "el servidor de Xuper TV no responde" (no es culpa suya: esperar).
   Se comprueba con una petición mínima a sitios grandes (sin datos del usuario).
   ------------------------------------------------------------------ */
var xuperNet = { online: true, checkedAt: 0, probing: null, serverAt: 0 };
window.__xuperNet = xuperNet;
var NET_PROBE_URLS = ['https://www.gstatic.com/generate_204', 'https://www.cloudflare.com/cdn-cgi/trace'];
function netOnline() { return xuperNet.online && navigator.onLine !== false; }
function netProbe(done) {
  if (!window.XUPER_DESKTOP || !window.fetch) { if (done) { done(true); } return; }
  if (xuperNet.probing) { if (done) { xuperNet.probing.push(done); } return; }
  xuperNet.probing = done ? [done] : [];
  var finished = false, pending = NET_PROBE_URLS.length;
  function finish(on) {
    if (finished) { return; }
    finished = true;
    var cbs = xuperNet.probing || [];
    xuperNet.probing = null;
    xuperNet.checkedAt = Date.now();
    netSetOnline(on);
    for (var c = 0; c < cbs.length; c++) { try { cbs[c](on); } catch (eCb) { /* ignore */ } }
  }
  if (navigator.onLine === false) { finish(false); return; }
  NET_PROBE_URLS.forEach(function (u) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) { ctrl.abort(); } }, 6000);
    fetch(u + '?_=' + Date.now(), { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
      .then(function () { clearTimeout(timer); finish(true); })
      .catch(function () { clearTimeout(timer); if (--pending === 0) { finish(false); } });
  });
}
function netSetOnline(on) {
  if (xuperNet.online === on) { return; }
  xuperNet.online = on;
  document.documentElement.classList.toggle('is-net-offline', !on);
  var wifi = document.querySelector('.notify-wifi');
  if (wifi) { wifi.title = on ? 'Conectado a internet' : 'Sin conexión a internet'; }
  netBanner(on ? 'back' : 'offline');
  document.dispatchEvent(new CustomEvent('xuper:net', { detail: { online: on } }));
}
/* Aviso arriba, en el centro. "offline" se queda hasta que vuelve internet. */
var netBannerEl = null, netBannerTimer = null;
function netBanner(kind) {
  if (!window.XUPER_DESKTOP || !document.body) { return; }
  if (!netBannerEl) {
    netBannerEl = document.createElement('div');
    netBannerEl.id = 'net-banner';
    netBannerEl.setAttribute('role', 'status');
    netBannerEl.setAttribute('aria-live', 'polite');
    netBannerEl.innerHTML = '<i class="nb-icon"></i><div class="nb-text"><b class="nb-title"></b><span class="nb-hint"></span></div>' +
      '<button type="button" class="nb-close" aria-label="Cerrar aviso" title="Cerrar aviso">×</button>';
    netBannerEl.querySelector('.nb-close').addEventListener('click', function (e) {
      e.stopPropagation();
      netBannerEl.classList.remove('is-shown');
    });
    document.body.appendChild(netBannerEl);
  }
  var texts = {
    offline: ['Sin conexión a internet', 'Revisa tu wifi o el cable de red. Cuando vuelva, la app se reconecta sola.'],
    back: ['Conexión recuperada', 'Volviendo a cargar lo que faltaba…'],
    server: ['El servidor de Xuper TV no responde', 'Tu internet funciona: el problema es del servidor. Espera un momento y vuelve a intentarlo.']
  };
  if (kind === 'server' && !netOnline()) { kind = 'offline'; }
  /* Mientras no hay internet, el aviso del servidor no lo tapa. */
  if (kind === 'server' && netBannerEl.classList.contains('is-offline') && netBannerEl.classList.contains('is-shown')) { return; }
  var t = texts[kind];
  if (!t) { return; }
  netBannerEl.className = 'is-shown is-' + kind;
  netBannerEl.querySelector('.nb-title').textContent = t[0];
  netBannerEl.querySelector('.nb-hint').textContent = t[1];
  if (netBannerTimer) { clearTimeout(netBannerTimer); netBannerTimer = null; }
  if (kind !== 'offline') {
    netBannerTimer = setTimeout(function () { netBannerTimer = null; netBannerEl.classList.remove('is-shown'); }, kind === 'back' ? 3500 : 9000);
  }
}
/* Fallos de red de una petición: se comprueba internet para decir de quién es la culpa. */
var NET_FAILURE_RE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket hang up|timeout|timed out|no respondió|tiempo de espera|network|red o CORS|\b409\b|\b5\d\d\b/i;
function netReportFailure(err) {
  if (!window.XUPER_DESKTOP || !NET_FAILURE_RE.test(String(err || ''))) { return; }
  netProbe(function (on) {
    if (on && Date.now() - xuperNet.serverAt > 60000) { xuperNet.serverAt = Date.now(); netBanner('server'); }
  });
}
/* Texto claro de un fallo: qué pasó y qué hacer. what = "la señal", "el vídeo"… */
/* Errores de canal en vivo que no se arreglan reintentando: el servidor no
   ofrece el canal, o está limitando peticiones (cada reintento empeora el 429). */
function liveErrorIsFinal(err) {
  return /Canal no disponible|HTTP 429|limita temporalmente/i.test(String(err || ''));
}
/* The service dropped this request because a newer playback was asked for.
   Nothing failed: ignore it silently (no message, no retry, or the preview and
   the player could keep replacing each other). */
function playbackSuperseded(err) {
  return /reemplazada por otra/i.test(String(err || ''));
}
function netExplain(err, what) {
  var raw = String(err || '');
  if (/Canal no disponible/i.test(raw)) { return 'Este canal no está disponible ahora en el servidor. Recarga la lista de canales o prueba otro.'; }
  if (/HTTP 429|limita temporalmente/i.test(raw)) { return 'El servidor está limitando las peticiones. Espera un minuto antes de volver a intentar.'; }
  if (!netOnline()) { return 'Sin conexión a internet. Revisa tu wifi o el cable; se reintentará solo cuando vuelva.'; }
  if (/\b409\b|ocupad|too many/i.test(raw)) { return 'El servidor está ocupado (muchos cambios de canal seguidos). Espera unos segundos y pulsa Reintentar.'; }
  if (/timeout|timed out|no respondió|tiempo de espera|ETIMEDOUT|no terminó/i.test(raw)) { return 'El servidor de Xuper TV tarda en responder (tu internet funciona). Espera unos segundos y pulsa Reintentar.'; }
  return 'El servidor de Xuper TV no pudo entregar ' + (what || 'el contenido') + '. Pulsa Reintentar en un momento o prueba otro.';
}
if (window.XUPER_DESKTOP) {
  window.addEventListener('offline', function () { netSetOnline(false); });
  window.addEventListener('online', function () { netProbe(); });
  /* El reproductor perdió la conexión con el vídeo: ¿es internet o el servidor? */
  document.addEventListener('xuper:net-failure', function () { netReportFailure('network'); });
  /* Sin internet: se mira cada 5 s si volvió. Con internet: una vez por minuto. */
  setInterval(function () {
    if (!xuperNet.online || Date.now() - xuperNet.checkedAt > 60000) { netProbe(); }
  }, 5000);
  setTimeout(function () { netProbe(); }, 4000);
}

/* The network test can only judge the carrier by touching the real CDN, so the
   page remembers the last raw CDN URLs the portal handed out.  Loopback proxy
   URLs are useless here: they always answer, even when the carrier drops the
   upstream connection. */
var lastCdnProbe = { live: null, vod: null };
var lastVodAttempt = { phase: 'sin intento', status: 'sin datos', error: '' };
function vodFailure(phase, message) {
  var safe = reportSafeText(String(message || 'El servicio no devolvió los datos necesarios'));
  lastVodAttempt = { phase: phase, status: 'error', error: safe };
  // A country block is not a loading fault: show the service's advice as is.
  state.streamError = /no está disponible en tu región/.test(safe) ? safe
    : (window.XUPER_DESKTOP ? 'No se pudo cargar ' + phase + '. ' + netExplain(safe, phase) : 'No se pudo cargar ' + phase + ': ' + safe);
  setPlayerStatus(state.streamError);
}
/* Set further down, next to the version fallback: tries another version of the
   title after a loading timeout.  Returns 'switched', 'exhausted' or ''. */
var vodTimeoutFallback = null;
document.addEventListener('xuper:playback-timeout', function () {
  if (state.playerMode === 'vod' && (state.screen === 'detail' || state.screen === 'player')) {
    /* With internet, a version that does not load in 30 s is the case the
       version fallback exists for.  Without internet no version would load. */
    var outcome = (vodTimeoutFallback && xuperNet.online) ? vodTimeoutFallback() : '';
    if (outcome === 'switched') { return; }
    vodFailure(lastVodAttempt.phase, outcome === 'exhausted'
      ? 'Ningún servidor de este título respondió a tiempo (se probaron todas las versiones)'
      : 'La carga no terminó dentro de 30 segundos');
  }
});
function rememberCdnProbe(kind, payload) {
  try {
    if (!payload) { return; }
    var url = payload.url || '';
    if (!/^https?:\/\//i.test(url)) { return; }
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(url)) { return; }
    lastCdnProbe[kind] = { url: url, headers: payload.headers || {} };
  } catch (eProbe) { /* ignore */ }
}

/* Diagnóstico de tiempos (solo consola; visible con ELECTRON_ENABLE_LOGGING=1).
   Mide desde que la interfaz pide el enlace hasta la primera imagen y cuenta
   las pausas por falta de datos. No registra URLs ni datos de la cuenta. */
var playTiming = { at: 0, label: '', answered: 0, firstFrame: false, waits: 0 };
function playTimingLog(text) {
  try { console.log('[tiempos-ui] ' + text); } catch (eLog) { /* ignore */ }
}
function playTimingSince() { return playTiming.at ? (Date.now() - playTiming.at) + 'ms' : '?'; }
(function () {
  function videoName(target) {
    return target && target.tagName === 'VIDEO' ? (target.id || target.className || 'video') : '';
  }
  /* Saltos: punto pedido, punto real y tiempo hasta que la imagen vuelve a avanzar. */
  var seekWatch = null;
  document.addEventListener('seeking', function (event) {
    var v = event.target;
    if (!videoName(v) || !playTiming.at || !playTiming.firstFrame) { return; }
    seekWatch = { v: v, target: v.currentTime, at: Date.now(), seekedAt: 0 };
  }, true);
  document.addEventListener('seeked', function (event) {
    if (seekWatch && event.target === seekWatch.v) { seekWatch.seekedAt = Date.now(); }
  }, true);
  document.addEventListener('timeupdate', function (event) {
    var w = seekWatch;
    if (!w || event.target !== w.v || !w.seekedAt || w.v.paused) { return; }
    if (w.v.currentTime < w.target + 0.25) { return; }
    seekWatch = null;
    playTimingLog(playTiming.label + ' | SALTO a ' + w.target.toFixed(1) + 's: imagen de nuevo a los ' + (Date.now() - w.at) +
      'ms (seeked a los ' + (w.seekedAt - w.at) + 'ms) [' + videoName(w.v) + ']');
  }, true);
  ['playing', 'waiting', 'error', 'stalled'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      var name = videoName(event.target);
      if (!name || !playTiming.at) { return; }
      if (type === 'playing' && !playTiming.firstFrame) {
        playTiming.firstFrame = true;
        playTimingLog(playTiming.label + ' | PRIMERA IMAGEN a los ' + playTimingSince() +
          ' de pulsar (servicio respondió a los ' + (playTiming.answered || '?') + 'ms) [' + name + '] ' +
          'resolución real ' + (event.target.videoWidth || '?') + '×' + (event.target.videoHeight || '?'));
      } else if (type === 'waiting' || type === 'stalled') {
        playTiming.waits++;
        playTimingLog(playTiming.label + ' | ' + (type === 'waiting' ? 'pausa esperando datos' : 'descarga detenida') +
          ' #' + playTiming.waits + ' a los ' + playTimingSince() + (playTiming.firstFrame ? '' : ' (aún sin imagen)') + ' [' + name + ']');
      } else if (type === 'error') {
        var code = event.target.error && event.target.error.code;
        playTimingLog(playTiming.label + ' | ERROR del reproductor código ' + (code || '?') + ' a los ' + playTimingSince() + ' [' + name + ']');
      }
    }, true);
  });
})();

/* Background work (params.background) waits behind everything the viewer asks
   for; its slowness says nothing about the server, so it never raises the
   "servidor no responde" notice.  Same limit as desktop/main.cjs. */
var BACKGROUND_CALL_MS = 180000;
function portalServiceCall(method, params, done, customTimeout) {
  var serviceId = vodApi.serviceId || 'com.webosflux.xuptertv.fidelity.service';
  var settled = false;
  var timeoutMs = customTimeout || parseInt(vodApi.timeoutMs, 10) || 20000;
  var callTimer = null;
  var timedCall = method === 'resolve' || method === 'resolveSmooth' || method === 'resolveLive' || method === 'videotecaPlay';
  var tCall = Date.now();
  if (timedCall) {
    var isRetry = playTiming.at && !playTiming.firstFrame && (tCall - playTiming.at) < 120000;
    var label = (method === 'resolveLive' ? 'vivo canal=' + (params && (params.channelCode || 'm3u')) :
      method === 'videotecaPlay' ? 'videoteca título=' + String(params && params.id || '').replace(/^vt:lamovie:/, '') :
      'película/serie contenido=' + (params && params.contentId));
    if (isRetry && playTiming.label === label) {
      playTimingLog(label + ' | REINTENTO de la interfaz a los ' + playTimingSince() + ' (' + method + ')');
    } else {
      playTiming = { at: tCall, label: label, answered: 0, firstFrame: false, waits: 0 };
      playTimingLog(label + ' | pedido (' + method + ')');
    }
  }
  function finish(error, payload) {
    if (settled) { return; }
    settled = true;
    if (callTimer) { clearTimeout(callTimer); callTimer = null; }
    if (timedCall) {
      if (!error) { playTiming.answered = Date.now() - playTiming.at; }
      playTimingLog(playTiming.label + ' | servicio respondió en ' + (Date.now() - tCall) + 'ms' +
        (error ? ' con ERROR: ' + String(error).replace(/https?:\/\/\S+/gi, '<url>').slice(0, 160) : ''));
    }
    /* Mis listas: un servidor de una lista del usuario que falla no es "el
       servidor de Xuper TV" (no se avisa en la cabecera). */
    if (error && !playbackSuperseded(error) && !(params && params.background) && !userListCall) { netReportFailure(error); }
    done(error ? describeServiceError(error) : error, payload);
  }
  var userListCall = /^myLists/.test(method);
  callTimer = setTimeout(function () {
    finish(userListCall ? 'El servidor de la lista no respondió a tiempo (' + Math.round(timeoutMs / 1000) + ' s)' :
      window.XUPER_DESKTOP
      ? 'El servidor de Xuper TV no respondió a tiempo (' + Math.round(timeoutMs / 1000) + ' s)'
      : 'El servicio de la TV no respondió en ' + Math.round(timeoutMs / 1000) + ' s. Cierra y vuelve a abrir la aplicación de Windows.', null);
  }, timeoutMs + 1000);
  /* webOSTV.js defines webOS.service.request even in a plain browser; without
     the native bridge it only reports an error, so the desktop harness must
     skip the Luna branch entirely. */
  if (hasLuna() && window.PalmServiceBridge) {
    try {
      window.webOS.service.request('luna://' + serviceId, {
        method: method,
        parameters: params || {},
        timeout: customTimeout || parseInt(vodApi.timeoutMs, 10) || 20000,
        onSuccess: function (payload) { finish(null, payload); },
        onFailure: function (error) {
          finish((error && error.errorText) || 'Error del servicio XuperTV', null);
        }
      });
      return true;
    } catch (e) {
      if (!vodApi.devServiceUrl) {
        finish('Error comunicando con el servicio: ' + (e.message || e), null);
        return false;
      }
    }
  }
  /* Desktop harness: reach the same methods over plain HTTP when the Luna
     bridge is missing or rejected the request (webOSTV.js on a browser). */
  if (vodApi.devServiceUrl) {
    apiRequest(String(vodApi.devServiceUrl).replace(/\/$/, '') + '/' + method + '?' + queryString(params || {}),
      function (error, payload) { finish(error, payload); }, null);
    return true;
  }
  finish('El servicio XuperTV no está disponible', null);
  return false;
}

  function startServiceKeepAlive() {
    if (!hasLuna()) { return; }
    var serviceId = vodApi.serviceId || 'com.webosflux.xuptertv.fidelity.service';
    try {
      window.webOS.service.request('luna://' + serviceId, {
        method: 'keepAlive',
        parameters: { subscribe: true },
        resubscribe: true,
        onSuccess: function () {},
        onFailure: function () {}
      });
    } catch (eSub) { /* ignore */ }

    setInterval(function () {
      try {
        window.webOS.service.request('luna://' + serviceId, {
          method: 'heartbeat',
          parameters: {},
          onSuccess: function () {},
          onFailure: function () {}
        });
      } catch (eHb) { /* ignore */ }
    }, 15000);
  }

  function portalSnapshot() {
    var data = window.XUPERTV_PORTAL;
    return data ? apiArray(data) : [];
  }

  /* Open movies are kept only to exercise the detail -> player pipeline; they
     are not portal titles, so they never go through the resolver. */
  function openSamples() {
    var all = bundledCatalog();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].streamUrl) {
        var rec = {};
        for (var k in all[i]) {
          if (Object.prototype.hasOwnProperty.call(all[i], k)) { rec[k] = all[i][k]; }
        }
        rec.category = 'demo';
        rec.portal = false;
        out.push(rec);
      }
    }
    return out;
  }

  function applyPortalRefresh(roots) {
    var byId = {}, order = [], cats = {};
    function absorb(item) {
      if (!item || !item.id) { return; }
      var id = String(item.id);
      if (!byId[id]) { byId[id] = item; order.push(id); }
      else {
        var cur = byId[id];
        for (var k in item) {
          if (Object.prototype.hasOwnProperty.call(item, k) &&
              item[k] !== '' && item[k] !== '—' && item[k] !== null && item[k] !== undefined) {
            cur[k] = item[k];
          }
        }
      }
      var list = String(item.category || '').split(',');
      cats[id] = cats[id] || {};
      for (var c = 0; c < list.length; c++) { if (list[c]) { cats[id][list[c]] = true; } }
    }
    var rows = [], rowAt = {};
    for (var r = 0; r < PORTAL_ROOTS.length; r++) {
      var list = roots[PORTAL_ROOTS[r]] || [];
      for (var i = 0; i < list.length; i++) {
        var rowName = String(list[i].row || '');
        var rowKey = PORTAL_ROOTS[r] + '|' + rowName;
        if (rowName && list[i].id) {
          if (!rowAt[rowKey]) { rowAt[rowKey] = { root: PORTAL_ROOTS[r], name: rowName, ids: [] }; rows.push(rowAt[rowKey]); }
          rowAt[rowKey].ids.push(String(list[i].id));
        }
        list[i].portal = true; absorb(list[i]);
      }
    }
    if (rows.length) { portalRows = rows; setTimeout(warmRankPages, 1500); }
    if (!order.length) {
      /* Refresh received no items (service offline or slow): preserve snapshot catalog! */
      return;
    }
    var records = [];
    for (var o = 0; o < order.length; o++) {
      var rec = byId[order[o]];
      rec.category = Object.keys(cats[order[o]]).join(',');
      records.push(rec);
    }
    var demo = openSamples();
    for (var d = 0; d < demo.length; d++) { records.push(demo[d]); }
    if (records.length) { replaceVod(records, 'portal', true); }
  }

  var catalogRetryTimer;
  var catalogRetryDelay = 5000;
  function resumeCatalog() {
    if (portalState.error && !document.hidden && navigator.onLine !== false) refreshPortalCatalog();
  }
  window.addEventListener('online', resumeCatalog);
  document.addEventListener('visibilitychange', resumeCatalog);
  function refreshPortalCatalog() {
    if (portalState.refreshing) { return; }
    clearTimeout(catalogRetryTimer);
    portalState.refreshing = true;
    portalState.error = null;
    portalState.roots = 0;
    var fresh = {};
    var index = 0;
    function next() {
      if (index >= PORTAL_ROOTS.length) {
        portalState.refreshing = false;
        if (portalState.error || !portalState.roots) {
          catalogRetryTimer = setTimeout(refreshPortalCatalog, catalogRetryDelay);
          catalogRetryDelay = Math.min(60000, catalogRetryDelay * 2);
        } else { catalogRetryDelay = 5000; }
        if (portalState.roots > 0) {
          portalState.lastSync = Date.now();
          applyPortalRefresh(fresh);
        } else {
          portalState.error = portalState.error || 'No se pudo actualizar el catálogo del servicio';
        }
        return;
      }
      var root = PORTAL_ROOTS[index++];
      portalServiceCall('home', { root: root }, function (error, payload) {
        if (!error && payload && payload.returnValue !== false && payload.items && payload.items.length) {
          fresh[root] = payload.items;
          portalState.roots++;
        } else if (error) {
          portalState.error = error;
        }
        next();
      });
    }
    next();
  }

  /* Desktop: rankings change on the portal every few days; refresh the
     catalogue once a day while the app stays open.  Home is rebuilt by the
     refresh, so it waits until Home is not on screen. */
  var DAILY_REFRESH_MS = 20 * 3600 * 1000;
  function startDailyCatalogRefresh() {
    if (!window.XUPER_DESKTOP || startDailyCatalogRefresh.started) { return; }
    startDailyCatalogRefresh.started = true;
    setInterval(function () {
      if (vodApi.mode !== 'portal' || portalState.refreshing || !portalState.lastSync) { return; }
      if (Date.now() - portalState.lastSync < DAILY_REFRESH_MS) { return; }
      if (state.screen === 'home') { return; }
      refreshPortalCatalog();
    }, 30 * 60 * 1000);
  }

  function loadPortalCatalog() {
    startDailyCatalogRefresh();
    var snap = portalSnapshot();
    if (snap.length) {
      replaceVod(snap, 'portal-snapshot', true);
    }
    if (vodApi.refresh === false) {
      if (!snap.length) { vodApiState.error = 'Sin snapshot del portal'; }
      return;
    }
    refreshPortalCatalog();
  }

  function useBundledCatalog(source, error) {
    var records = bundledCatalog();
    if (!replaceVod(records, source || 'bundled')) {
      vodApiState.error = error || 'No hay catálogo local ni remoto';
      return false;
    }
    if (error) { vodApiState.error = error; }
    return true;
  }

  function loadVodCatalog() {
    if (!vodApi.enabled) { return; }
    if (vodApi.mode === 'portal') { loadPortalCatalog(); return; }
    if (vodApi.mode === 'static') { useBundledCatalog('bundled', null); return; }
    var url = apiUrl('catalog');
    if (vodApi.mode === 'xuper' && !hasXuperSession()) {
      vodApiState.error = 'Falta la sesión XuperTV (userId, userToken y portalCode)';
      return;
    }
    if (!url) {
      if (vodApi.useBundledCatalog) { useBundledCatalog('bundled', null); }
      else { vodApiState.error = 'Falta baseUrl/catalogUrl del catálogo autorizado'; }
      return;
    }
    vodApiState.loading = true;
    apiRequest(url, function (error, payload) {
      vodApiState.loading = false;
      var responseError = apiError(payload);
      if (!error && !responseError && replaceVod(apiArray(payload), 'api')) { return; }
      var message = error || responseError || 'La API no devolvió películas';
      /* A remote endpoint that is offline must not leave the port empty. */
      if (!useBundledCatalog('bundled-fallback', message)) {
        vodApiState.error = message;
      }
    }, vodApi.mode === 'xuper' ? { method: 'POST', body: xuperPayload('catalog') } : null);
  }

  function mergeDetail(item, raw) {
    var groupedId = item && item._seriesGroup ? item.id : null;
    var groupedTitle = item && item._seriesGroup ? item._seriesTitle : null;
    var full = normalizeVod(raw, item.id);
    /* Catalog values remain useful when a detail response omits a field. */
    for (var key in full) {
      /* An empty list in the answer (seasons, episodes…) must not wipe what
         the title already knows: it removed every season from the dropdown
         after switching season in House M.D. */
      if (Object.prototype.hasOwnProperty.call(full, key) && full[key] !== '—' && full[key] !== '' &&
          full[key] !== 'Sin sinopsis disponible.' && !(Array.isArray(full[key]) && !full[key].length)) {
        item[key] = full[key];
      }
    }
    if (groupedId !== null) {
      item.id = groupedId;
      item.title = groupedTitle;
      item.alias = groupedTitle;
      item.seasons = item._catalogSeasons || item.seasons;
    }
  }

  function loadVodDetail(item, done) {
    done = done || function () {};
    if (!item) { return done(null); }
    if (item._detailsLoaded) { return done(item); }
    if (item._detailLoading) {
      item._detailWait = item._detailWait || [];
      item._detailWait.push(done);
      return;
    }
    if (vodApi.mode === 'portal' && item._portal) {
      item._detailLoading = true;
      item._detailWait = [done];
      portalServiceCall('detail', { contentId: item.id, title: item._seriesTitle || item.title || '' }, function (error, payload) {
        item._detailLoading = false;
        if (error || !payload || payload.returnValue === false || !payload.item) {
          item._detailError = error || (payload && payload.errorText) || 'El servidor no devolvió la ficha ni los capítulos';
          var failedWaiters = item._detailWait || [];
          item._detailWait = [];
          if ((state.screen === 'detail' && state.detail === item) ||
              (state.screen === 'player' && state.playerItem === item)) vodFailure('la ficha o los capítulos', item._detailError);
          for (var failed = 0; failed < failedWaiters.length; failed++) failedWaiters[failed](null);
          return;
        }
        item._detailError = '';
        if (!error && payload && payload.returnValue !== false && payload.item) {
          mergeDetail(item, payload.item);
          item.episodes = payload.episodes || [];
          item.seasons = item._catalogSeasons || payload.seasons || [];
          /* The portal keys episodes by the season container, so remember
             which container this list came from (item.id stays the series). */
          if (!item.seasonId) { item.seasonId = item.id; }

          /* Ordenar temporadas ascendentemente por numero */
          if (item.seasons && item.seasons.length) {
            item.seasons.sort(function (a, b) {
              var na = parseInt(a.number, 10) || 0;
              var nb = parseInt(b.number, 10) || 0;
              return na - nb;
            });
          }

          /* Si no hay temporadas pero el titulo o alias tiene T/S, asegurar al menos una temporada */
          if ((!item.seasons || !item.seasons.length) && isSeriesItem(item)) {
            var sNum = 1;
            var sm = /S(\d+)/i.exec(item.alias || '') || /T(\d+)/i.exec(item.title || '');
            if (sm) { sNum = parseInt(sm[1], 10) || 1; }
            item.seasons = [{ id: item.id, number: sNum }];
          }

          /* Sincronizar indice de temporada activa con item.id */
          if (item.seasons && item.seasons.length) {
            var activeIdx = 0;
            for (var s = 0; s < item.seasons.length; s++) {
              if (item.seasons[s].id === item.id) {
                activeIdx = s;
                break;
              }
            }
            state.detailSeason = activeIdx;
          }

          /* Episodio por defecto si no hay uno seleccionado */
          if (item.episodes && item.episodes.length && !state.detailEpisode) {
            state.detailEpisode = item.episodes[0];
          }
          applyPendingHistoryEpisode(item);

          item._detailsLoaded = true;
        }
        var wait = item._detailWait || [];
        item._detailWait = [];
        var hadWaiters = wait.length > 0;
        for (var i = 0; i < wait.length; i++) { wait[i](item); }
        if (state.detail === item && state.screen === 'detail') {
          buildDetail(item);
          if (!hadWaiters && (!playerVideo || !playerVideo.src || playerVideo.paused) && autoPreviewAllowed(item)) {
            startPlayerVideo(item, state.detailEpisode);
          }
        }
      });
      return;
    }
    var endpoint = apiUrl('detail');
    if (!vodApi.enabled || !endpoint) { return done(item); }
    if (vodApi.mode === 'xuper' && !hasXuperSession()) { return done(item); }
    item._detailLoading = true;
    var url = endpoint.replace('{id}', encodeURIComponent(item.id));
    apiRequest(url, function (error, payload) {
      item._detailLoading = false;
      if (!error) {
        var records = apiArray(payload);
        var raw = records.length ? records[0] : (payload && (payload.item || payload.movie || payload));
        if (raw && typeof raw === 'object') {
          mergeDetail(item, raw);
          item._detailsLoaded = true;
          if (state.detail === item && state.screen === 'detail') {
            buildDetail(item);
            if ((!playerVideo || !playerVideo.src || playerVideo.paused) && autoPreviewAllowed(item)) {
              startPlayerVideo(item, state.detailEpisode);
            }
          }
        }
      }
      done(item);
    }, vodApi.mode === 'xuper' ? { method: 'POST', body: xuperPayload('detail', item.id) } : null);
  }

  /* Live TV is portal-driven.  Do not draw fictitious rows while the local
     service starts: they looked like real channels until the user left and
     returned to the TV tab. */
  var CHANNELS = [];

  /* Tab order and labels observed on the running app (WSA, 1920x1080).
     The APK builds this list from its backend, so the icon artwork is not a
     drawable in the APK; these glyphs are reconstructions of the observed
     shapes (documented in DIFERENCIAS_PENDIENTES.md). */
  var TAB_ICONS = {
    tv: '<svg viewBox="0 0 33 33"><rect x="3.5" y="7" width="26" height="17" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M11 24.5v3h11v-3" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
    thumb: '<svg viewBox="0 0 33 33"><path d="M12 15.5V28H7.6A2.6 2.6 0 0 1 5 25.4v-7.3a2.6 2.6 0 0 1 2.6-2.6H12z" fill="currentColor"/><path d="M14 15.6l4.3-9.2a2.2 2.2 0 0 1 4 1.6V13h5.6a2.9 2.9 0 0 1 2.8 3.6l-2 9A3.4 3.4 0 0 1 25.4 28H14z" fill="currentColor"/></svg>',
    film: '<svg viewBox="0 0 33 33"><circle cx="16.5" cy="16.5" r="11.5" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="16.5" cy="16.5" r="2.4" fill="currentColor"/><circle cx="16.5" cy="9.5" r="2.1" fill="currentColor"/><circle cx="16.5" cy="23.5" r="2.1" fill="currentColor"/><circle cx="9.5" cy="16.5" r="2.1" fill="currentColor"/><circle cx="23.5" cy="16.5" r="2.1" fill="currentColor"/></svg>',
    strip: '<svg viewBox="0 0 33 33"><rect x="4" y="7" width="25" height="19" rx="2" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M9 7v19M24 7v19" stroke="currentColor" stroke-width="1.8"/><rect x="5.6" y="9" width="2.4" height="2.6" fill="currentColor"/><rect x="5.6" y="15.2" width="2.4" height="2.6" fill="currentColor"/><rect x="5.6" y="21.4" width="2.4" height="2.6" fill="currentColor"/><rect x="25" y="9" width="2.4" height="2.6" fill="currentColor"/><rect x="25" y="15.2" width="2.4" height="2.6" fill="currentColor"/><rect x="25" y="21.4" width="2.4" height="2.6" fill="currentColor"/></svg>',
    kids: '<svg viewBox="0 0 33 33"><circle cx="8.6" cy="8.6" r="4" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="24.4" cy="8.6" r="4" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="16.5" cy="18" r="9.6" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="13" cy="17" r="1.5" fill="currentColor"/><circle cx="20" cy="17" r="1.5" fill="currentColor"/><ellipse cx="16.5" cy="21.6" rx="2.4" ry="1.7" fill="currentColor"/></svg>',
    anime: '<svg viewBox="0 0 33 33"><circle cx="8.5" cy="9" r="4.5" fill="currentColor"/><circle cx="24.5" cy="9" r="4.5" fill="currentColor"/><path d="M16.5 9c5.8 0 10.5 4.6 10.5 10.3 0 5.7-4.7 9.7-10.5 9.7S6 25 6 19.3C6 13.6 10.7 9 16.5 9z" fill="currentColor"/><circle cx="12.5" cy="18" r="1.6" fill="#0b0b0b"/><circle cx="20.5" cy="18" r="1.6" fill="#0b0b0b"/><ellipse cx="16.5" cy="23" rx="3" ry="2" fill="#0b0b0b"/></svg>',
    compass: '<svg viewBox="0 0 33 33"><circle cx="16.5" cy="16.5" r="11.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M22 11l-3.2 7.8L11 22l3.2-7.8z" fill="currentColor"/></svg>',
    novel: '<svg viewBox="0 0 33 33"><path d="M5 6.5h9.5c2.2 0 3.7 1 4.5 2.3.8-1.3 2.3-2.3 4.5-2.3H28v20h-5.5c-2.1 0-3.4.6-4.5 1.8-1.1-1.2-2.4-1.8-4.5-1.8H5z" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M18 9v19" stroke="currentColor" stroke-width="2.2"/></svg>',
    history: '<svg viewBox="0 0 33 33"><circle cx="16.5" cy="17" r="10.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M16.5 10.5V17l5 3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M8 7v6h6" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
    music: '<svg viewBox="0 0 33 33"><path d="M12.5 24.5V8.5l14-3v15.5" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round"/><ellipse cx="9.2" cy="24.6" rx="3.6" ry="3" fill="currentColor"/><ellipse cx="23.2" cy="21.2" rx="3.6" ry="3" fill="currentColor"/><path d="M12.5 13l14-3" stroke="currentColor" stroke-width="2.3"/></svg>',
    radio: '<svg viewBox="0 0 33 33"><rect x="4" y="11.5" width="25" height="16" rx="3.2" fill="none" stroke="currentColor" stroke-width="2.3"/><path d="M9.5 11.5 23 5.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="11.5" cy="19.5" r="3.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M19 17.5h6M19 21.5h6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
  };

  /* Orden de la barra lateral: Destacados (se abre al iniciar), TV, YouMusic, Radio… */
  var TABS = [
    { label: 'DESTACADOS', desk: 'Destacados', short: 'Destacados', page: 1, icon: 'thumb' },
    { label: 'TV', desk: 'TV en vivo', short: 'TV', page: 0, icon: 'tv' },
    { label: 'YOUMUSIC', desk: 'YouMusic', short: 'YouMusic', page: 9, icon: 'music', needs: 'music' },
    { label: 'RADIO', desk: 'Radio', short: 'Radio', page: 8, icon: 'radio' },
    /* En la barra lateral: "IPTV" (antes "Mis listas", que no decía para qué era). */
    { label: 'MIS LISTAS', desk: 'IPTV', short: 'IPTV', page: 10, icon: 'tv', deskIcon: 'mylists', needs: 'desktop' },
    { label: 'VIDEOTECA', desk: 'Videoteca', short: 'Videoteca', page: 11, icon: 'film', deskIcon: 'videoteca', needs: 'desktop' },
    { label: 'PELICULA', desk: 'Películas', short: 'Películas', page: 2, icon: 'film', deskIcon: 'clapper' },
    { label: 'SERIES', desk: 'Series', short: 'Series', page: 3, icon: 'strip', deskIcon: 'stack' },
    { label: 'KIDS', desk: 'Infantil', short: 'Infantil', page: 4, icon: 'kids' },
    { label: 'ANIME', desk: 'Anime', short: 'Anime', page: 5, icon: 'anime', deskIcon: 'sparkle' },
    { label: 'HISTORIAL', desk: 'Historial', short: 'Historial', page: -1, icon: 'history', action: 'history' }
  ];
  /* "Música" (YouTube Music en una vista aparte) solo existe en Electron. */
  if (!(window.desktop && window.desktop.music)) {
    TABS = TABS.filter(function (t) { return t.needs !== 'music'; });
  }
  /* "Mis listas" (M3U del usuario) solo existe en la versión de escritorio. */
  if (!window.XUPER_DESKTOP) {
    TABS = TABS.filter(function (t) { return t.needs !== 'desktop'; });
  }
  /* Pestaña de inicio (Destacados) y pestaña de TV, por su página y no por su posición. */
  function tabOfPage(page) {
    for (var i = 0; i < TABS.length; i++) { if (TABS[i].page === page) { return i; } }
    return 0;
  }
  var TAB_HOME = tabOfPage(1);
  function onTvTab() { return !!(TABS[state.tab] && TABS[state.tab].page === 0); }
  /* The portal sends many genres in English: show them in Spanish. */
  var GENRE_ES = {
    'action': 'Acción', 'adventure': 'Aventura', 'action & adventure': 'Acción y aventura',
    'animation': 'Animación', 'anime': 'Anime', 'biography': 'Biografía', 'comedy': 'Comedia',
    'crime': 'Crimen', 'documentary': 'Documental', 'drama': 'Drama', 'family': 'Familiar',
    'fantasy': 'Fantasía', 'history': 'Historia', 'horror': 'Terror', 'kids': 'Infantil',
    'music': 'Música', 'musical': 'Musical', 'mystery': 'Misterio', 'news': 'Noticias',
    'reality': 'Reality', 'romance': 'Romance', 'science fiction': 'Ciencia ficción',
    'sci-fi': 'Ciencia ficción', 'sci-fi & fantasy': 'Ciencia ficción y fantasía',
    'soap': 'Telenovela', 'sport': 'Deporte', 'sports': 'Deporte', 'talk': 'Entrevistas',
    'thriller': 'Suspenso', 'suspense': 'Suspenso', 'tv movie': 'Película de TV',
    'war': 'Bélica', 'war & politics': 'Bélica y política', 'western': 'Western'
  };
  function displayGenres(list) {
    var out = [], seen = {};
    list = list || [];
    for (var i = 0; i < list.length; i++) {
      var raw = String(list[i] || '').trim();
      if (!raw) { continue; }
      var name = (window.XUPER_DESKTOP && GENRE_ES[raw.toLowerCase()]) || raw;
      if (seen[name]) { continue; }
      seen[name] = true;
      out.push(name);
    }
    return out;
  }

  /* ------------------------------------------------------------------
     Audio languages per title (desktop).  The portal lists no language in
     search or catalogue rows, so each title is asked once (audio
     "por,spa,eng", subtitles "es,en") and remembered for a week.  Used for
     the card labels and the "Priorizar español" order of the search.
     ------------------------------------------------------------------ */
  var AUDIO_STORE_KEY = 'xuper_audio_info_v2';
  var AUDIO_STORE_DAYS = 7;
  var AUDIO_PARALLEL = 3;
  var audioStore = (function () {
    /* v1 kept audio only; without subtitles it cannot rank, so drop it. */
    try { localStorage.removeItem('xuper_audio_info_v1'); } catch (eOld) { /* storage disabled */ }
    try { return JSON.parse(localStorage.getItem(AUDIO_STORE_KEY) || '{}') || {}; } catch (eStore) { return {}; }
  })();
  var audioQueue = [], audioRunning = 0, audioWaiters = {}, audioMovie = {}, audioSaveTimer = null;

  function saveAudioStore() {
    if (audioSaveTimer) { return; }
    audioSaveTimer = setTimeout(function () {
      audioSaveTimer = null;
      try {
        var keys = Object.keys(audioStore);
        if (keys.length > 4000) {
          keys.sort(function (a, b) { return audioStore[a].t - audioStore[b].t; });
          for (var k = 0; k < keys.length - 3000; k++) { delete audioStore[keys[k]]; }
        }
        localStorage.setItem(AUDIO_STORE_KEY, JSON.stringify(audioStore));
      } catch (eSave) { /* storage full or disabled */ }
    }, 800);
  }
  /* Known languages of a title ({a: audio, s: subtitles}), or null when it
     has not been asked yet. */
  function knownLang(item) {
    if (!item || !item.id) { return null; }
    var rec = audioStore[item.id];
    if (rec && Date.now() - rec.t < AUDIO_STORE_DAYS * 86400000) { return { a: rec.a, s: rec.s || '' }; }
    return null;
  }
  /* Known audio for a title, or null when it has not been asked yet. */
  function knownAudio(item) {
    var lang = knownLang(item);
    if (lang) { return lang.a; }
    if (item && item.streamAudioInfo) { return item.streamAudioInfo; }
    return null;
  }
  function audioCodes(audio) {
    var out = [], parts = String(audio || '').split(/[,\/]/);
    for (var i = 0; i < parts.length; i++) {
      var c = parts[i].trim().toLowerCase();
      if (c && out.indexOf(c) === -1) { out.push(c); }
    }
    return out;
  }
  function isSpanishCode(c) { return /^(spa|es|esp|es-\w+|lat|cas)$/.test(c); }
  function audioHasSpanish(audio) {
    var codes = audioCodes(audio);
    for (var i = 0; i < codes.length; i++) { if (isSpanishCode(codes[i])) { return true; } }
    return false;
  }
  var AUDIO_SHORT = { spa: 'ES', es: 'ES', lat: 'ES', cas: 'ES', eng: 'EN', en: 'EN', por: 'PT', pt: 'PT',
    jpn: 'JA', ja: 'JA', kor: 'KO', ko: 'KO', fra: 'FR', fre: 'FR', fr: 'FR', ita: 'IT', deu: 'DE', ger: 'DE',
    chi: 'ZH', zho: 'ZH', cmn: 'ZH', hin: 'HI', rus: 'RU', tur: 'TR' };
  /* "ES · EN · PT" with Spanish first; unknown codes ("und") are left out. */
  function audioShortLabel(audio) {
    var seen = {}, out = [];
    var codes = audioCodes(audio).sort(function (a, b) { return (isSpanishCode(b) ? 1 : 0) - (isSpanishCode(a) ? 1 : 0); });
    for (var i = 0; i < codes.length; i++) {
      var s = AUDIO_SHORT[codes[i]] || (/^[a-z]{3}$/.test(codes[i]) && codes[i] !== 'und' ? codes[i].slice(0, 2).toUpperCase() : '');
      if (s && !seen[s]) { seen[s] = true; out.push(s); }
    }
    return out.join(' · ');
  }
  /* "Priorizar español" (search switch and Configuración global, same
     setting): on by default.  Stored as noSpanish: 0 = on, 1 = off. */
  function spanishFirst() {
    return !!window.XUPER_DESKTOP && Number(state.playback.noSpanish) !== 1;
  }
  /* Search order: 0 Spanish audio, 1 Spanish subtitles, 2 not known yet,
     3 other languages, 4 Portuguese without Spanish. */
  function langRank(lang) {
    if (!lang) { return 2; }
    if (audioHasSpanish(lang.a)) { return 0; }
    if (audioHasSpanish(lang.s)) { return 1; }
    var codes = audioCodes(lang.a);
    for (var i = 0; i < codes.length; i++) { if (/^(por|pt|pt-\w+)$/.test(codes[i])) { return 4; } }
    return 3;
  }
  function requestLang(item, cb) {
    var known = knownLang(item);
    if (known) { if (cb) { cb(known); } return; }
    var id = item.id;
    if (audioWaiters[id]) { if (cb) { audioWaiters[id].push(cb); } return; }
    audioWaiters[id] = cb ? [cb] : [];
    audioMovie[id] = !isSeriesItem(item);
    audioQueue.push(id);
    pumpAudioQueue();
  }
  function requestAudio(item, cb) {
    requestLang(item, function (lang) { if (cb) { cb(lang ? lang.a : null); } });
  }
  /* A new search: titles still waiting from the previous one go to the back. */
  function dropQueuedAudio() {
    for (var i = 0; i < audioQueue.length; i++) { delete audioWaiters[audioQueue[i]]; }
    audioQueue = [];
  }
  function pumpAudioQueue() {
    while (audioRunning < AUDIO_PARALLEL && audioQueue.length) {
      (function (id) {
        audioRunning++;
        var movie = audioMovie[id] === true;
        delete audioMovie[id];
        portalServiceCall('audioInfo', { contentId: id, movie: movie }, function (error, payload) {
          audioRunning--;
          var ok = !error && payload && payload.returnValue !== false;
          var lang = ok ? { a: String(payload.audio || ''), s: String(payload.subs || '') } : null;
          if (ok) { audioStore[id] = { a: lang.a, s: lang.s, t: Date.now() }; saveAudioStore(); }
          var waiting = audioWaiters[id] || [];
          delete audioWaiters[id];
          for (var w = 0; w < waiting.length; w++) {
            try { waiting[w](lang); } catch (eCb) { /* one card must not stop the rest */ }
          }
          pumpAudioQueue();
        });
      })(audioQueue.shift());
    }
  }
  /* Small label on a card: "ES · EN", "SUB ES" (Spanish subtitles only) or
     "Sin español" in amber.  `lang` is {a, s} from knownLang/requestLang. */
  function setAudioTag(host, lang) {
    if (!host) { return; }
    var tag = host.querySelector('.audio-tag');
    if (!lang || !audioCodes(lang.a).length) { if (tag) { tag.parentNode.removeChild(tag); } return; }
    if (!tag) { tag = el('div', 'audio-tag'); host.appendChild(tag); }
    var rank = langRank(lang);
    tag.className = 'audio-tag' + (rank === 1 ? ' is-sub' : rank > 1 ? ' is-missing' : '');
    tag.textContent = rank === 0 ? audioShortLabel(lang.a) : rank === 1 ? 'SUB ES' : 'Sin español';
    tag.title = 'Audio: ' + audioShortLabel(lang.a) + (lang.s ? ' · Subtítulos: ' + audioShortLabel(lang.s) : '');
  }

  /* Desktop: distinct icons where the TV set used near-identical ones. */
  var DESKTOP_TAB_ICONS = {
    clapper: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11h16v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 11l-.6-3.2a1 1 0 0 1 .8-1.2l13.8-2.5a1 1 0 0 1 1.2.8L19.7 8 4 11z"/><path d="M8.5 6.4l2.6 3.4M13.5 5.5l2.6 3.4"/></svg>',
    stack: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7.5" width="18" height="12.5" rx="2"/><path d="M6 4.5h12"/><path d="M10.5 11.2v5.1l4.3-2.55z" fill="currentColor"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5l1.7 4.8 4.8 1.7-4.8 1.7L10 16.5l-1.7-4.8-4.8-1.7 4.8-1.7z"/><path d="M17.5 13.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/></svg>',
    /* IPTV: una tele con una lista dentro (el mismo dibujo que la cabecera de la página). */
    mylists: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="13" rx="2"/><path d="M7 9.5h6M7 13h4"/><path d="M15.5 11.5l3 1.75-3 1.75z" fill="currentColor"/><path d="M9 21h6"/></svg>',
    videoteca: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 4l-2 5M14 4l-2 5M20 4l-2 5"/><path d="M10.5 12.5v5l4-2.5z" fill="currentColor"/></svg>'
  };

  var SETTINGS_ITEMS = [
    { id: 'profile', label: 'Mi cuenta' },
    { id: 'history', label: 'Mi lista' },
    { id: 'share', label: 'Compartir APP' },
    { id: 'parent', label: 'Bloqueo' },
    { id: 'playback', label: 'Configuración global' },
    { id: 'netdiag', label: 'Diagnóstico' },
    { id: 'feedback', label: 'Ayuda y Feedback' },
    { id: 'about', label: 'Sobre nosotros' }
  ];

  var SETTINGS_MENU_ICONS = {
    profile: '<svg viewBox="0 0 32 32"><circle cx="16" cy="10" r="5"/><path d="M6 27c.7-6 4.3-9 10-9s9.3 3 10 9"/></svg>',
    history: '<svg viewBox="0 0 32 32"><rect x="4" y="4" width="9" height="9"/><rect x="19" y="4" width="9" height="9"/><rect x="4" y="19" width="9" height="9"/><rect x="19" y="19" width="9" height="9"/></svg>',
    share: '<svg viewBox="0 0 32 32"><circle cx="8" cy="16" r="3"/><circle cx="24" cy="7" r="3"/><circle cx="24" cy="25" r="3"/><path d="M10.6 14.5l10.8-6M10.6 17.5l10.8 6"/></svg>',
    parent: '<svg viewBox="0 0 32 32"><rect x="7" y="14" width="18" height="14" rx="2"/><path d="M11 14V10a5 5 0 0 1 10 0v4"/><path d="M16 19v4"/></svg>',
    playback: '<svg viewBox="0 0 32 32"><rect x="4" y="6" width="24" height="20" rx="3"/><path d="M13 11l8 5-8 5z"/></svg>',
    netdiag: '<svg viewBox="0 0 32 32"><path d="M3 13a19 19 0 0 1 26 0"/><path d="M8 18a12 12 0 0 1 16 0"/><path d="M13 23a6 6 0 0 1 6 0"/><circle cx="16" cy="27.5" r="1.2"/></svg>',
    feedback: '<svg viewBox="0 0 32 32"><path d="M6 4h15l5 5v19H6z"/><path d="M20 4v6h6M10 16h12M10 21h8"/></svg>',
    about: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="12"/><path d="M16 14v8M16 10h.1"/></svg>'
  };

  /* ---------------------------------------------------------------- state */
  var state = {
    screen: 'welcome',
    tab: TAB_HOME,
    channel: 0,
    focus: null,
    detail: null,
    detailReturn: null,
    detailRange: 0,
    detailSeason: 0,
    detailNeedsRebuild: false,
    playerReturn: null,
    playerMode: 'live',
    playerItem: null,
    playerEpisode: null,
    playerSeasonIndex: 0,
    episodeBrowserOpen: false,
    categoryPickerOpen: false,
    browserSeason: 0,
    streamError: '',
    streamMode: 'normal',
    trackIndex: 0,
    channelsOpen: false,
    infobar: true,
    infoTimer: null,
    searchQuery: '',
    searchNumeric: false,
    searchSeq: 0,
    searchFocus: null,
    playback: {
      streamMode: 'normal',
      screen: 0,
      audio: 0,
      subLang: 0,
      size: 0,
      style: 0,
      subtitle: true,
      noSpanish: 0,         /* 0 = Spanish first in search results (desktop) */
      fluidHw: 0,           /* Modo fluido: 0 = tarjeta gráfica si hay, 1 = solo CPU */
      fluidQuality: 0,      /* Modo fluido: 0 = original, 1 = 720p, 2 = 480p */
      searchKeyboard: 0     /* Teclado en pantalla del buscador: 0 = automático, 1 = mostrar, 2 = ocultar */
    },
    crOn: false,
    favs: {}
  };

  /* A profile belongs to this TV only: no registration, credentials or
     network account is required.  It intentionally stays small because old
     webOS models have limited persistent storage. */
  var LOCAL_PROFILE_KEY = 'xuper_local_profile_v1';
  var LOCAL_PLAYBACK_KEY = 'xuper_global_playback_v1';
  var localProfile = { id: '', createdAt: 0, history: [] };

  function safeLocalRead(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (eRead) { return fallback; }
  }

  function safeLocalWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (eWrite) { /* storage unavailable */ }
  }

  function loadLocalProfile() {
    var savedPlayback = safeLocalRead(LOCAL_PLAYBACK_KEY, null);
    if (savedPlayback) {
      for (var pKey in state.playback) {
        if (state.playback.hasOwnProperty(pKey) && savedPlayback[pKey] !== undefined) {
          state.playback[pKey] = savedPlayback[pKey];
        }
      }
    }
    /* Desktop: Directo is the default. Older profiles saved Fluido globally;
       reset that once. Later choices in Ajustes are kept as usual. */
    if (window.XUPER_DESKTOP && !safeLocalRead('xuper_direct_default_v1', false)) {
      state.playback.streamMode = 'normal';
      safeLocalWrite(LOCAL_PLAYBACK_KEY, state.playback);
      safeLocalWrite('xuper_direct_default_v1', true);
    }
    var savedProfile = safeLocalRead(LOCAL_PROFILE_KEY, null);
    if (savedProfile && savedProfile.id) {
      localProfile = savedProfile;
      if (!localProfile.history || !localProfile.history.length) { localProfile.history = []; }
    } else {
      localProfile.id = 'TV-' + String(Date.now()).slice(-8);
      localProfile.createdAt = Date.now();
      safeLocalWrite(LOCAL_PROFILE_KEY, localProfile);
    }
    if (!localProfile.favs) { localProfile.favs = {}; }
    state.favs = localProfile.favs;
  }

  function saveGlobalPlayback() {
    safeLocalWrite(LOCAL_PLAYBACK_KEY, state.playback);
  }

  function toggleFavorite(item) {
    if (!item || !item.id) { return false; }
    var key = String(item.id);
    var on = !state.favs[key];
    if (on) { state.favs[key] = true; }
    else { delete state.favs[key]; }
    localProfile.favs = state.favs;
    safeLocalWrite(LOCAL_PROFILE_KEY, localProfile);
    return on;
  }

  loadLocalProfile();

  var homeBuilt = false;
  var pagesEl, pages = [], tabEls = [], notifyEl;
  var liveRows = [], liveInfoText, liveMain, liveFocus, liveList;
  var detailLeft, detailPlayer, detailButtons, detailBottom;
  var searchKeyboard, searchHot, searchResults, searchEmpty, searchHotGrid,
      searchResultGrid, searchInput, searchNav, searchKeys = [];
  var settingsMenu, settingsRight, settingsPanels = {}, settingsItems = [];
  var historyViewTab = 'history';
  var playerStage, playerInfo, playerChannels, playerVideo, playerFrame, playerStatus, nextEpisodeLoading, playerChannelRows = {};
  /* Live category picker (all portal columns in one grid). */
  var categoryPicker = null, pcatGrid = null, pcatSub = null;
  /* Key of the category list currently painted in the rail, so switching a
     category only updates classes instead of rebuilding (and detaching) the
     focused pill. */
  var renderedCategoryKey = '';
  /* Older webOS models cannot keep a full 500–1000-row channel category in
     memory.  The side panel therefore owns only this small moving window. */
  var LIVE_PANEL_WINDOW = 48;
  var playerVodInfo, vodInfobarPoster, vodInfobarTitle, vodTimeCurrent, vodTimeTotal, vodSeekbar, vodSeekProgress, vodSeekBuffered, vodSeekThumb, playerOsdIcon;
  var vodScrubbing = false, vodScrubTime = 0;
  var welcomeTimer = null;

  /* ------------------------------------------------------------ focus core */
  function isVisible(node) {
    if (!node || !node.getBoundingClientRect) { return false; }
    if (node.disabled || node.getAttribute('aria-disabled') === 'true') { return false; }
    if (node.offsetParent === null) { return false; }
    var r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { return false; }
    if (historyDrawerOpen) { return !!closest(node, '.history-drawer'); }
    if (dialogAddonsOpen) { return !!closest(node, '#dialog-addons'); }
    if (state.episodeBrowserOpen) {
      return !!closest(node, '#player-episodes');
    }
    if (state.categoryPickerOpen) {
      return !!closest(node, '#player-categories');
    }
    if (dialogPlaySettingsOpen) {
      return !!closest(node, '#dialog-playsettings');
    }
    if (playSettingViewOpen) {
      return !!closest(node, '#player-playsetting-view');
    }
    var page = closest(node, '.home-page');
    if (page && !page.classList.contains('is-current')) { return false; }
    var panel = closest(node, '.settings-panel');
    if (panel && !panel.classList.contains('is-active')) { return false; }
    var hot = closest(node, '.search-hot');
    if (hot && hot.classList.contains('is-hidden')) { return false; }
    var res = closest(node, '.search-results');
    if (res && !res.classList.contains('is-active')) { return false; }
    var pc = closest(node, '.player-channels');
    if (pc && !pc.classList.contains('is-active')) { return false; }
    var ib = closest(node, '.player-infobar');
    if (ib && !ib.classList.contains('is-active')) { return false; }
    return true;
  }

  function focusables() {
    var nodes = document.querySelectorAll('.focusable');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (isVisible(nodes[i])) { out.push(nodes[i]); }
    }
    return out;
  }

  function reveal(node) {
    var box = closest(node, '.scrollable');
    while (box) {
      var er = node.getBoundingClientRect();
      var br = box.getBoundingClientRect();
      if (er.top < br.top) {
        box.scrollTop -= (br.top - er.top) + 12;
      } else if (er.bottom > br.bottom) {
        box.scrollTop += (er.bottom - br.bottom) + 12;
      }
      if (box.scrollWidth > box.clientWidth + 1) {
        if (er.left < br.left) {
          box.scrollLeft -= (br.left - er.left) + 12;
        } else if (er.right > br.right) {
          box.scrollLeft += (er.right - br.right) + 12;
        }
      }
      box = closest(box.parentNode, '.scrollable');
    }
  }

  function setFocus(node, silent) {
    if (!node) { return; }
    if (state.focus === node) {
      if (!silent) { reveal(node); }
      return;
    }
    if (state.focus) { state.focus.classList.remove('is-focused'); }
    state.focus = node;
    node.classList.add('is-focused');
    if (node._onFocus) { node._onFocus(); }
    renderPlaySettingRowFocus();
    /* The tab rail expands while it holds focus and collapses to icons as soon
       as the content takes focus (observed on the running app). */
    var rail = $('home-tabs');
    if (rail && state.screen === 'home') {
      var inRail = closest(node, '.home-tabs');
      rail.classList.toggle('is-expanded', !!inRail);
      rail.classList.toggle('is-collapsed', !inRail);
      var railBg = document.querySelector('.home-sidebar-bg');
      if (railBg) { railBg.classList.toggle('is-on', !!inRail); }
      var homeScreen = $('screen-home');
      if (homeScreen) { homeScreen.classList.toggle('is-rail-open', !!inRail); }
    }
    if (!silent) { reveal(node); }
    schedulePosterMemoryPass();
  }

  function firstIn(container) {
    var nodes = container.querySelectorAll('.focusable');
    for (var i = 0; i < nodes.length; i++) {
      if (isVisible(nodes[i])) { return nodes[i]; }
    }
    return null;
  }

  function moveFocus(dir) {
    if (!state.focus) {
      var f = focusables();
      if (f.length) { setFocus(f[0]); }
      return;
    }
    if (state.focus._onMove && state.focus._onMove(dir)) { return; }

    var inPage = state.screen === 'home' && closest(state.focus, '.home-page');
    var inSidebar = state.screen === 'home' && closest(state.focus, '.home-tabs');

    var list = focusables();
    var fr = state.focus.getBoundingClientRect();
    var fx = fr.left + fr.width / 2;
    var fy = fr.top + fr.height / 2;
    var best = null;
    var bestScore = 1e9;

    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c === state.focus) { continue; }
      /* Don't let sidebar tabs intercept left navigation while inside page content */
      if (inPage && closest(c, '.home-tabs')) { continue; }
      /* Don't let page content intercept navigation while inside sidebar tabs */
      if (inSidebar && !closest(c, '.home-tabs')) { continue; }

      var r = c.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      var dx = cx - fx;
      var dy = cy - fy;
      var primary, secondary, overlap;

      if (dir === 'left') {
        if (dx > -4) { continue; }
        primary = Math.max(0, fr.left - r.right);
        secondary = Math.abs(dy);
        overlap = (r.bottom > fr.top + 2 && r.top < fr.bottom - 2);
      } else if (dir === 'right') {
        if (dx < 4) { continue; }
        primary = Math.max(0, r.left - fr.right);
        secondary = Math.abs(dy);
        overlap = (r.bottom > fr.top + 2 && r.top < fr.bottom - 2);
      } else if (dir === 'up') {
        if (dy > -4) { continue; }
        primary = Math.max(0, fr.top - r.bottom);
        secondary = Math.abs(dx);
        overlap = (r.right > fr.left + 2 && r.left < fr.right - 2);
      } else {
        if (dy < 4) { continue; }
        primary = Math.max(0, r.top - fr.bottom);
        secondary = Math.abs(dx);
        overlap = (r.right > fr.left + 2 && r.left < fr.right - 2);
      }
      var score = primary + secondary * 2 + (overlap ? 0 : 320);
      if (score < bestScore) { bestScore = score; best = c; }
    }

    if (best) {
      setFocus(best);
      return;
    }

    /* Leftmost limit reached in page content: now focus sidebar tab */
    if (dir === 'left' && inPage) {
      if (tabEls[state.tab]) { setFocus(tabEls[state.tab]); }
    }
  }

  /* ---------------------------------------------------------------- screen */
  function showScreen(name) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) {
      screens[i].classList.remove('is-active');
    }
    var target = $('screen-' + name);
    if (target) { target.classList.add('is-active'); }
    var previousScreen = state.screen;
    state.screen = name;
    if (historyDrawerOpen) { closeHistoryDrawer(true); }
    if (window.XUPER_DESKTOP) {
      if (name === 'home') {
        /* Back from the full-screen TV player: keep the same video playing
           in the home preview instead of reloading the channel. */
        if (liveHandoff && liveHandoff.type === 'preview') { returnPreviewHome(); }
        else if (previousScreen === 'player') { borrowPlayerIntoHome(); }
      } else if (name !== 'player') {
        /* The home preview must not keep playing (with sound) behind other screens. */
        stopLivePreview();
      }
    }
    if (name !== 'player' && state.episodeBrowserOpen) { closeEpisodeBrowser(true); }
    if (name !== 'player' && state.categoryPickerOpen) { closeCategoryPicker(true); }
    if (name !== 'player' && name !== 'detail') {
      if (dialogPlaySettingsOpen) { closePlaySettingsDialog(); }
      if (playSettingViewOpen) { closePlaySettingView(); }
      var scrPlayer = $('screen-player');
      if (scrPlayer) {
        scrPlayer.classList.remove('is-mini');
        scrPlayer.classList.remove('is-active');
      }
      /* PiP keeps playing while browsing; a TV channel handed to the home
         preview keeps playing there. */
      if (!keepFloatingVideo() && !(liveHandoff && liveHandoff.type === 'player')) { stopPlayerVideo(); }
      /* Really leaving the player: drop the subtitle cues as well. */
      subtitleSeq++;
      activeSubtitleCues = [];
      if (playerSubtitles) { playerSubtitles.innerHTML = ''; }
    }
    radioOnScreen(name);
    if (typeof musicOnTab === 'function' && musicSupported()) {
      if (name !== 'home') { closeMusic(); }
      else if (TABS[state.tab] && TABS[state.tab].needs === 'music') { openMusic(); }
    }
    schedulePosterMemoryPass();
  }

  var lastBackTime = 0;
  function back() {
    var now = Date.now();
    if (now - lastBackTime < 250) { return; }
    lastBackTime = now;
    /* "Volver" while "¿Seguir viendo?" is open only closes the question. */
    if (resumePrompt) { resumePrompt.cancel(); return; }
    if (historyDrawerOpen) { closeHistoryDrawer(); return; }
    if (radio.pickerOpen) { closeRadioPicker(); return; }
    if (ml.dialogOpen) { if (!ml.dlgBusy) { mlCloseDialog(); } return; }
    if (state.screen === 'home' && vtBack()) { return; }
    if (music.open && !musicMiniOn) {
      selectTab(TAB_HOME, false);
      if (tabEls[TAB_HOME]) { setFocus(tabEls[TAB_HOME]); }
      return;
    }
    /* The audio/subtitle dialog can now open from the details screen too. */
    if (dialogPlaySettingsOpen) {
      closePlaySettingsDialog();
      return;
    }
    if (state.screen === 'player') {
      if (vodScrubbing) {
        leaveVodScrub(false);
        return;
      }
      if (state.categoryPickerOpen) {
        lastBackTime = Date.now();
        closeCategoryPicker();
        return;
      }
      if (state.episodeBrowserOpen) {
        lastBackTime = Date.now();
        closeEpisodeBrowser();
        return;
      }
      if (playSettingViewOpen) {
        closePlaySettingView();
        return;
      }
      if (state.channelsOpen) {
        closeChannelPanel();
      } else if (state.infobar) {
        hideInfobar();
      } else if (state.vodInfobarVisible) {
        hideVodInfobar();
      } else {
        restorePlayerReturn();
      }
      return;
    }
    if (state.screen === 'detail') {
      if (typeof closeSeasonPopup === 'function' && seasonPopup) {
        closeSeasonPopup();
        var sBtn = detailBottom ? detailBottom.querySelector('.detail-season') : null;
        if (sBtn) { setFocus(sBtn); }
        return;
      }
      var scr = $('screen-detail');
      if (scr && scr.classList.contains('is-synopsis-open')) {
        toggleSynopsis();
        return;
      }
      if (!keepFloatingVideo()) { stopPlayerVideo(); }  /* PiP keeps playing while browsing */
      var scrPlayer = $('screen-player');
      if (scrPlayer) {
        scrPlayer.classList.remove('is-mini');
        scrPlayer.classList.remove('is-active');
      }
      var ret = state.detailReturn;
      if (ret && ret.screen === 'search') {
        showScreen('search');
        setFocus(ret.focus);
      } else {
        showScreen('home');
        selectTab(state.tab, false);
        if (ret && ret.focus && isVisible(ret.focus)) { setFocus(ret.focus); }
        else if (tabEls[state.tab]) { setFocus(tabEls[state.tab]); }
      }
      return;
    }
    if (state.screen === 'search') {
      clearSearchState();
      closeFilterPage();
      showScreen('home');
      selectTab(state.tab, false);
      if (tabEls[state.tab]) { setFocus(tabEls[state.tab]); }
      return;
    }
    if (state.screen === 'settings') {
      showScreen('home');
      selectTab(state.tab, false);
      if (tabEls[state.tab]) { setFocus(tabEls[state.tab]); }
      return;
    }
    if (state.screen === 'home') {
      if (state.tab !== TAB_HOME) {
        selectTab(TAB_HOME, true);
        if (tabEls[TAB_HOME]) { setFocus(tabEls[TAB_HOME]); }
        return;
      }
      if (window.webOSTV && window.webOSTV.platformBack) {
        window.webOSTV.platformBack();
      } else if (window.PalmSystem && window.PalmSystem.platformBack) {
        window.PalmSystem.platformBack();
      }
    }
  }

  function activate() {
    if (!state.focus) { return; }
    if (state.focus.disabled || state.focus.getAttribute('aria-disabled') === 'true') { return; }
    if (state.focus._activate) { state.focus._activate(); }
  }

  function handleKey(e) {
    if (window.XUPER_DESKTOP && e.target && closest(e.target, '.desktop-native-control') &&
        (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32)) { return; }
    /* Let real desktop text fields keep their caret, selection, paste and
       Backspace behaviour instead of treating them as TV remote commands. */
    if (window.XUPER_DESKTOP && e.target &&
        (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
      return;
    }
    var k = e.keyCode || e.which;
    var key = e.key || '';
    var handled = true;

    /* Desktop player shortcuts (no panel open, no Ctrl/Alt). */
    if (window.XUPER_DESKTOP && state.screen === 'player' && !e.ctrlKey && !e.altKey && !e.metaKey &&
        !dialogPlaySettingsOpen && !playSettingViewOpen && !state.episodeBrowserOpen &&
        !state.categoryPickerOpen && !state.channelsOpen && !dialogAddonsOpen &&
        !($('screen-player') && $('screen-player').classList.contains('is-mini'))) {
      var lk = key.length === 1 ? key.toLowerCase() : '';
      var shortcut = true;
      if (lk === 'm') { togglePlayerMute(); }
      else if (lk === 'f') { setWindowFullscreen(!isWindowFullscreen()); }
      else if (state.playerMode === 'vod' && (lk === 'k' ||
               (k === 32 && (!state.focus || state.focus === playerStage || state.focus === vodSeekbar)))) { togglePlayerPlayPause(); }
      else if (state.playerMode === 'vod' && lk === 'n' && isSeriesItem(state.playerItem)) { advanceToNextEpisode(); }
      else if (state.playerMode === 'vod' && lk === 'c') { openPlaySettingsDialog(); }
      else if (state.playerMode === 'vod' && lk === 's') { openPlaySettingView(); }
      else if (state.playerMode === 'vod' && !vodScrubbing && (k === 38 || k === 40)) {
        setPlayerVolume((liveAudio.muted ? 0 : liveAudio.volume) + (k === 38 ? 0.05 : -0.05), true);
        showInfobar();
      } else { shortcut = false; }
      if (shortcut) {
        if (e.preventDefault) { e.preventDefault(); }
        return;
      }
    }

    /* Back buttons */
    var isBack = (k === 461 || k === 27 || k === 8 || key === 'Back' || key === 'GoBack' || key === 'Escape');
    if (isBack) {
      if (state.categoryPickerOpen) {
        closeCategoryPicker();
        if (e.preventDefault) { e.preventDefault(); }
        if (e.stopPropagation) { e.stopPropagation(); }
        return;
      }
      if (state.episodeBrowserOpen) {
        closeEpisodeBrowser();
        if (e.preventDefault) { e.preventDefault(); }
        if (e.stopPropagation) { e.stopPropagation(); }
        return;
      }
      if (dialogAddonsOpen) {
        lastBackTime = Date.now();
        closeAddonsDialog();
        if (e.preventDefault) { e.preventDefault(); }
        if (e.stopPropagation) { e.stopPropagation(); }
        return;
      }
      if (dialogPlaySettingsOpen) {
        /* LG sends a keyup after this keydown.  Mark it consumed, otherwise
           that second event sees the dialog closed and exits the detail page. */
        lastBackTime = Date.now();
        closePlaySettingsDialog();
        if (e.preventDefault) { e.preventDefault(); }
        if (e.stopPropagation) { e.stopPropagation(); }
        return;
      }
      if (playSettingViewOpen) {
        lastBackTime = Date.now();
        closePlaySettingView();
        if (e.preventDefault) { e.preventDefault(); }
        if (e.stopPropagation) { e.stopPropagation(); }
        return;
      }
      back();
      if (e.preventDefault) { e.preventDefault(); }
      if (e.stopPropagation) { e.stopPropagation(); }
      return;
    }

    /* Live category picker: a full-screen grid owns the d-pad while open. */
    if (state.categoryPickerOpen) {
      if (k === 37) { moveFocus('left'); }
      else if (k === 38) { moveFocus('up'); }
      else if (k === 39) { moveFocus('right'); }
      else if (k === 40) { moveFocus('down'); }
      else if (k === 13 || k === 32) { activate(); }
      else { handled = false; }
      if (handled && e.preventDefault) { e.preventDefault(); }
      return;
    }

    /* Season/episode browser: it owns the d-pad while open. */
    if (state.episodeBrowserOpen) {
      var inSeasons = closest(state.focus, '#pe-seasons');
      var inEpisodes = closest(state.focus, '#pe-episodes');
      if (k === 37) {
        if (inEpisodes && peSeasonsCol && peSeasonsCol.style.display !== 'none') {
          var selSeason = peSeasons ? (peSeasons.children[state.browserSeason] || firstIn(peSeasons)) : null;
          if (selSeason) { setFocus(selSeason); }
        }
      } else if (k === 39) {
        if (inSeasons) {
          var curEp = peEpisodes ? (peEpisodes.querySelector('.pe-ep.is-current') || firstIn(peEpisodes)) : null;
          if (curEp) { setFocus(curEp); }
        }
      } else if (k === 38) {
        moveFocus('up');
      } else if (k === 40) {
        moveFocus('down');
      } else if (k === 13 || k === 32) {
        activate();
      } else {
        handled = false;
      }
      if (handled && e.preventDefault) { e.preventDefault(); }
      return;
    }

    /* Media Play / Pause / Seek keys on webOS & Android TV remotes */
    var isPlay = (k === 415 || key === 'MediaPlay' || key === 'Play');
    var isPause = (k === 19 || key === 'MediaPause' || key === 'Pause');
    var isPlayPause = (k === 10252 || key === 'MediaPlayPause');
    var isFwd = (k === 417 || key === 'MediaFastForward' || key === 'FastForward');
    var isRwd = (k === 412 || key === 'MediaRewind' || key === 'Rewind');
    var isStop = (k === 413 || key === 'MediaStop' || key === 'Stop');

    if (state.screen === 'player') {
      if (isPlay) {
        if (playerVideo && playerVideo.paused) {
          resumePlayerPlayback();
          showOsdIcon('none');
          showInfobar();
        }
        if (e.preventDefault) { e.preventDefault(); }
        return;
      }
      if (isPause) {
        if (playerVideo && !playerVideo.paused) {
          try { playerVideo.pause(); } catch (ePause) {}
          showOsdIcon('pause');
          showInfobar();
        }
        if (e.preventDefault) { e.preventDefault(); }
        return;
      }
      if (isPlayPause) {
        togglePlayerPlayPause();
        if (e.preventDefault) { e.preventDefault(); }
        return;
      }
      if (isFwd) {
        playerSeek(15);
        if (e.preventDefault) { e.preventDefault(); }
        return;
      }
      if (isRwd) {
        playerSeek(-15);
        if (e.preventDefault) { e.preventDefault(); }
        return;
      }
      if (isStop) {
        back();
        if (e.preventDefault) { e.preventDefault(); }
        return;
      }
    }

    /* Menu / ContextMenu button to open in-player settings */
    var isMenu = (k === 457 || k === 93 || k === 467 || key === 'Menu' || key === 'ContextMenu');
    if (state.screen === 'player' && state.playerMode === 'vod' && isMenu) {
      if (dialogPlaySettingsOpen) {
        closePlaySettingsDialog();
      } else if (playSettingViewOpen) {
        closePlaySettingView();
      } else {
        openPlaySettingView();
      }
      if (e.preventDefault) { e.preventDefault(); }
      return;
    }

    if (state.screen === 'player' && (k === 37 || k === 38 || k === 39 || k === 40)) {
      if (dialogPlaySettingsOpen) {
        if (k === 37) { moveFocus('left'); }
        else if (k === 38) { moveFocus('up'); }
        else if (k === 39) { moveFocus('right'); }
        else if (k === 40) { moveFocus('down'); }
        if (e.preventDefault) { e.preventDefault(); }
        return;
      }
      if (playSettingViewOpen) {
        schedulePlaySettingHide();
        if (k === 37) { moveFocus('left'); }
        else if (k === 38) { moveFocus('up'); }
        else if (k === 39) { moveFocus('right'); }
        else if (k === 40) { moveFocus('down'); }
        if (e.preventDefault) { e.preventDefault(); }
        return;
      }
      if (state.playerMode === 'vod') {
        if (state.focus === vodSeekbar && vodScrubbing) {
          if (k === 37) { moveVodScrub(-1); if (e.preventDefault) { e.preventDefault(); } return; }
          if (k === 39) { moveVodScrub(1); if (e.preventDefault) { e.preventDefault(); } return; }
          if (k === 38 || k === 40) { leaveVodScrub(false); if (e.preventDefault) { e.preventDefault(); } return; }
        }
        if (k === 37) { playerSeek(-10); if (e.preventDefault) { e.preventDefault(); } return; }
        if (k === 39) { playerSeek(10); if (e.preventDefault) { e.preventDefault(); } return; }
        if (k === 40) {
          openPlaySettingView();
          if (e.preventDefault) { e.preventDefault(); }
          return;
        }
        if (k === 38) {
          enterVodScrub();
          if (e.preventDefault) { e.preventDefault(); }
          return;
        }
      } else {
        /* Some webOS remote events arrive after the panel has painted but
           before its boolean state is restored.  Focus inside the visible
           panel is the authoritative signal, so Up never zaps from channel 1
           to the last channel while the channel list is on screen. */
        var channelPanelHasFocus = state.focus && closest(state.focus, '.player-channels');
        if (state.channelsOpen || channelPanelHasFocus) {
          /* The category rail is a real focus area, not a channel row.  It
             must receive the arrows first; otherwise Right was interpreted as
             "close panel" and Down reused the currently playing channel. */
          var focusIsCategory = state.focus && state.focus.classList &&
            state.focus.classList.contains('pc-cat-pill');
          if (focusIsCategory) {
            if (k === 37) { moveFocus('left'); }
            else if (k === 38) { moveFocus('up'); }
            else if (k === 39) { moveFocus('right'); }
            else if (k === 40) { moveFocus('down'); }
            if (e.preventDefault) { e.preventDefault(); }
            return;
          }
          if (k === 38) {
            var curIdx = (state.focus && state.focus._channel !== undefined) ? state.focus._channel : state.channel;
            if (curIdx === 0) {
              var selCat = playerChannels ? (playerChannels.querySelector('.pc-cat-pill.is-selected') || playerChannels.querySelector('.pc-cat-pill')) : null;
              if (selCat) { setFocus(selCat); }
            } else {
              var prev = curIdx - 1;
              focusPlayerChannel(prev);
            }
            if (e.preventDefault) { e.preventDefault(); }
            return;
          }
          if (k === 40) {
            var curIdx = (state.focus && state.focus._channel !== undefined) ? state.focus._channel : state.channel;
            var next = Math.min(CHANNELS.length - 1, curIdx + 1);
            focusPlayerChannel(next);
            if (e.preventDefault) { e.preventDefault(); }
            return;
          }
          if (k === 39) { closeChannelPanel(); if (e.preventDefault) { e.preventDefault(); } return; }
        } else {
          if (k === 38) {
            if (state.channel > 0) { setChannel(state.channel - 1, false); }
            else if (CHANNELS.length) { setChannel(CHANNELS.length - 1, false); }
            showInfobar();
            if (e.preventDefault) { e.preventDefault(); }
            return;
          }
          if (k === 40) {
            if (state.channel < CHANNELS.length - 1) { setChannel(state.channel + 1, false); }
            else if (CHANNELS.length) { setChannel(0, false); }
            showInfobar();
            if (e.preventDefault) { e.preventDefault(); }
            return;
          }
          if (k === 37) {
            openChannelPanel();
            if (e.preventDefault) { e.preventDefault(); }
            return;
          }
          if (state.infobar) { scheduleInfoHide(); } else { showInfobar(); }
        }
      }
    }

    if (k === 37) { moveFocus('left'); }
    else if (k === 38) { moveFocus('up'); }
    else if (k === 39) { moveFocus('right'); }
    else if (k === 40) { moveFocus('down'); }
    else if (k === 13 || k === 32) {
      if (state.episodeBrowserOpen) {
        activate();
        return;
      }
      if (dialogPlaySettingsOpen) {
        activate();
      } else if (playSettingViewOpen) {
        schedulePlaySettingHide();
        activate();
      } else if (state.screen === 'player' && state.playerMode === 'vod' &&
                 state.focus === vodSeekbar && vodScrubbing) {
        /* OK belongs to the focused timeline, not to Play/Pause. */
        leaveVodScrub(true);
      } else if (state.screen === 'player' && state.streamError && playerVideo && playerVideo.src &&
                 !closest(state.focus, '.player-channels')) {
        /* OK retries the failed stream, but only from the video surface: with
           the channel panel open it must activate the focused row/pill, or a
           dead channel made every category unfilterable. */
        resumePlayerPlayback();
        state.streamError = '';
        setPlayerStatus('');
      } else if (state.screen === 'player' && state.playerMode === 'vod') {
        togglePlayerPlayPause();
      } else {
        activate();
      }
    }
    else { handled = false; }
    if (handled && e.preventDefault) { e.preventDefault(); }
  }

  /* ================================================================ WELCOME */
  function startWelcome() {
    var img = $('welcome-loading-img');
    var frame = 1;
    welcomeTimer = setInterval(function () {
      frame++;
      if (frame > 16) { finishWelcome(); return; }
      img.src = 'assets/original/welcome/img_welcome_loading' + frame + '.png';
    }, 250);
  }

  function finishWelcome() {
    if (welcomeTimer) { clearInterval(welcomeTimer); welcomeTimer = null; }
    if (!homeBuilt) { buildHome(); }
    showScreen('home');
    selectTab(TAB_HOME, false);
    if (tabEls[TAB_HOME]) { setFocus(tabEls[TAB_HOME]); }
    /* The first launch shows the full tab labels even though the video holds
       focus; the rail collapses on the first focus change. */
    var rail = $('home-tabs');
    if (rail) { rail.classList.add('is-expanded'); rail.classList.remove('is-collapsed'); }
    var railBg = document.querySelector('.home-sidebar-bg');
    if (railBg) { railBg.classList.add('is-on'); }
    var homeScreen = $('screen-home');
    if (homeScreen) { homeScreen.classList.add('is-rail-open'); }
  }

  /* ================================================================ RADIO
     Emisoras en vivo de Radio Browser (servicio "radioStations"), por país y
     categoría.  Suena en un <audio> propio, así sigue mientras se navega; una
     barra "Escuchando ahora" la controla.  Al abrir una película o un canal
     en el reproductor la radio se pausa; la vista previa de TV se silencia. */
  var RADIO_STORE_KEY = 'xuper_radio_v1';
  var RADIO_COUNTRIES = [
    ['PE', 'Perú'], ['MX', 'México'], ['AR', 'Argentina'], ['CO', 'Colombia'], ['CL', 'Chile'],
    ['EC', 'Ecuador'], ['BO', 'Bolivia'], ['VE', 'Venezuela'], ['UY', 'Uruguay'], ['PY', 'Paraguay'],
    ['ES', 'España'], ['US', 'EE. UU. (en español)', 'spanish'], ['GT', 'Guatemala'], ['CR', 'Costa Rica'],
    ['PA', 'Panamá'], ['DO', 'Rep. Dominicana'], ['PR', 'Puerto Rico'], ['CU', 'Cuba'], ['HN', 'Honduras'],
    ['SV', 'El Salvador'], ['NI', 'Nicaragua']
  ];
  /* Categorías por etiquetas y nombre de la emisora (una puede estar en varias). */
  var RADIO_CATEGORIES = [
    { key: 'all', label: 'Todas' },
    { key: 'fav', label: '★ Mis radios' },
    { key: 'news', label: 'Noticias', re: /noticia|news|informativ|actualidad|talk|hablada|politic|periodis/ },
    { key: 'sports', label: 'Deportes', re: /deport|sport|f[uú]tbol|soccer/ },
    { key: 'cumbia', label: 'Cumbia', re: /cumbia|chicha|tropical/ },
    { key: 'salsa', label: 'Salsa', re: /salsa|merengue|bachata|timba/ },
    { key: 'romantic', label: 'Baladas', re: /balada|rom[aá]ntic|love|bolero|amor\b/ },
    { key: 'pop', label: 'Pop', re: /(^|[^a-z])pop([^a-z]|$)|hits|top ?40|[ée]xitos/ },
    { key: 'rock', label: 'Rock', re: /rock|metal|alternativ|indie|punk/ },
    { key: 'urban', label: 'Urbano', re: /urban|reggaet|regueton|reguet[oó]n|trap|hip ?hop|(^|[^a-z])rap([^a-z]|$)/ },
    { key: 'oldies', label: 'Recuerdos', re: /recuerdo|oldies|cl[aá]sicos|retro|\b(60|70|80|90)s\b|inolvidable|noventer|ochenter/ },
    { key: 'folk', label: 'Folclore', re: /folcl|folkl|(^|[^a-z])folk|andin|huayno|criolla|vals|ranchera|mariachi|regional|banda|norte[ñn]|cuarteto|tango|llanera|vallenato/ },
    { key: 'christian', label: 'Cristiana', re: /cristian|christian|cat[oó]lic|cathol|religi|gospel|evang|iglesia|adoraci/ },
    { key: 'electronic', label: 'Electrónica', re: /electr|techno|house|(^|[^a-z])dance|edm|trance/ },
    { key: 'classical', label: 'Clásica y jazz', re: /classical|m[uú]sica cl[aá]sica|orquest|sinf[oó]n|[oó]pera|jazz|instrumental/ }
  ];
  var radioStore = safeLocalRead(RADIO_STORE_KEY, null) || {};
  if (!radioStore.favs || typeof radioStore.favs !== 'object') { radioStore.favs = {}; }
  var radio = {
    page: null, country: radioStore.country || 'PE', stations: [], favStations: [], loading: false, error: '',
    category: 'all', current: null, status: 'idle', audio: null, hls: null, watchdog: null, seq: 0,
    bar: null, pickerOpen: false, volume: typeof radioStore.volume === 'number' ? radioStore.volume : 0.8
  };
  function saveRadioStore() {
    radioStore.country = radio.country;
    radioStore.volume = radio.volume;
    safeLocalWrite(RADIO_STORE_KEY, radioStore);
  }
  function radioCountry(code) {
    for (var i = 0; i < RADIO_COUNTRIES.length; i++) { if (RADIO_COUNTRIES[i][0] === code) { return RADIO_COUNTRIES[i]; } }
    return RADIO_COUNTRIES[0];
  }
  function radioHay(st) { return norm((st.tags || '') + ' ' + (st.name || '')); }
  function radioInCategory(st, key) {
    if (key === 'all') { return true; }
    if (key === 'fav') { return !!radioStore.favs[st.id]; }
    for (var i = 0; i < RADIO_CATEGORIES.length; i++) {
      var c = RADIO_CATEGORIES[i];
      if (c.key === key) { return !!(c.re && c.re.test(radioHay(st))); }
    }
    return false;
  }
  function radioFirstCategory(st) {
    var hay = radioHay(st);
    for (var i = 2; i < RADIO_CATEGORIES.length; i++) {
      if (RADIO_CATEGORIES[i].re.test(hay)) { return RADIO_CATEGORIES[i].label; }
    }
    return 'Variada';
  }
  function radioHue(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) { h = (h * 31 + name.charCodeAt(i)) % 360; }
    return h;
  }
  function radioInitials(name) {
    var words = String(name || '').replace(/^radio\s+/i, '').replace(/[^\wÁÉÍÓÚÑáéíóúñ ]+/g, ' ').trim().split(/\s+/);
    return ((words[0] || 'R').charAt(0) + (words[1] ? words[1].charAt(0) : '')).toUpperCase();
  }
  function radioActive() { return !!(radio.current && (radio.status === 'playing' || radio.status === 'loading')); }
  var RADIO_ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.8l10.2-6.8a1 1 0 0 0 0-1.6L9.6 4.4C8.9 3.9 8 4.4 8 5.2z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4.2" height="15" rx="1.2"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
    starOn: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
    mini: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="currentColor" stroke="none"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.2v11.6c0 .8-.9 1.2-1.5.8l-8.6-5.8a1 1 0 0 1 0-1.6l8.6-5.8c.6-.4 1.5 0 1.5.8z"/><rect x="4.7" y="5" width="2.8" height="14" rx="1"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 6.2v11.6c0 .8.9 1.2 1.5.8l8.6-5.8a1 1 0 0 0 0-1.6L6.5 5.4C5.9 5 5 5.4 5 6.2z"/><rect x="16.5" y="5" width="2.8" height="14" rx="1"/></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/></svg>'
  };
  function radioEq() {
    var eq = el('div', 'radio-eq');
    for (var i = 0; i < 4; i++) { eq.appendChild(el('i')); }
    return eq;
  }

  function buildRadioPage(page) {
    radio.page = page;
    page.classList.add('radio-page');
    var wrap = el('div', 'radio-wrap');
    abs(wrap, 192, BENTO.bigY, 1664);
    wrap.style.height = 'auto';

    var hero = el('div', 'radio-hero');
    var waves = el('div', 'radio-waves');
    for (var w = 0; w < 56; w++) {
      var bar = el('i');
      bar.style.animationDelay = (-((w * 137) % 1200) / 1000).toFixed(2) + 's';
      bar.style.animationDuration = (0.9 + ((w * 53) % 70) / 100).toFixed(2) + 's';
      waves.appendChild(bar);
    }
    hero.appendChild(waves);
    hero.appendChild(el('div', 'radio-orb a'));
    hero.appendChild(el('div', 'radio-orb b'));
    var text = el('div', 'radio-hero-text');
    var kicker = el('div', 'radio-kicker');
    kicker.appendChild(el('span', 'radio-live-dot'));
    kicker.appendChild(document.createTextNode('EN VIVO'));
    text.appendChild(kicker);
    text.appendChild(el('div', 'radio-title', 'Radio'));
    radio.subEl = el('div', 'radio-sub', '');
    text.appendChild(radio.subEl);
    hero.appendChild(text);
    var countryBtn = el('div', 'radio-country focusable');
    countryBtn.setAttribute('role', 'button');
    countryBtn._activate = openRadioPicker;
    radio.countryBtn = countryBtn;
    hero.appendChild(countryBtn);
    wrap.appendChild(hero);

    radio.catsEl = el('div', 'radio-cats');
    wrap.appendChild(radio.catsEl);
    radio.stateEl = el('div', 'radio-state');
    wrap.appendChild(radio.stateEl);
    radio.gridEl = el('div', 'radio-grid');
    wrap.appendChild(radio.gridEl);

    radio.picker = el('div', 'radio-picker');
    var pickPanel = el('div', 'radio-picker-panel');
    pickPanel.appendChild(el('div', 'radio-picker-title', 'Elige un país'));
    var pickGrid = el('div', 'radio-picker-grid');
    for (var c = 0; c < RADIO_COUNTRIES.length; c++) {
      var chip = el('div', 'radio-chip focusable', RADIO_COUNTRIES[c][1]);
      chip._code = RADIO_COUNTRIES[c][0];
      chip._activate = (function (code) {
        return function () { closeRadioPicker(); if (code !== radio.country) { radio.country = code; radio.category = 'all'; saveRadioStore(); loadRadioStations(); } };
      })(RADIO_COUNTRIES[c][0]);
      pickGrid.appendChild(chip);
    }
    pickPanel.appendChild(pickGrid);
    radio.picker.appendChild(pickPanel);
    radio.picker.addEventListener('click', function (event) { if (event.target === radio.picker) { closeRadioPicker(); } });
    page.appendChild(radio.picker);

    page.appendChild(wrap);
    radio.wrap = wrap;
    renderRadioCountry();
    loadRadioStations();
  }

  function renderRadioCountry() {
    if (!radio.countryBtn) { return; }
    var c = radioCountry(radio.country);
    radio.countryBtn.innerHTML = RADIO_ICONS.globe + '<span>' + c[1] + '</span><b>▾</b>';
    radio.countryBtn.title = 'Cambiar de país';
  }
  function openRadioPicker() {
    if (!radio.picker) { return; }
    radio.pickerOpen = true;
    radio.picker.classList.add('is-open');
    var chips = radio.picker.querySelectorAll('.radio-chip');
    for (var i = 0; i < chips.length; i++) { chips[i].classList.toggle('is-selected', chips[i]._code === radio.country); }
    var sel = radio.picker.querySelector('.radio-chip.is-selected') || chips[0];
    if (sel) { setFocus(sel); }
  }
  function closeRadioPicker() {
    if (!radio.picker) { return; }
    radio.pickerOpen = false;
    radio.picker.classList.remove('is-open');
    if (radio.countryBtn) { setFocus(radio.countryBtn); }
  }

  function loadRadioStations() {
    var seq = ++radio.seq;
    var c = radioCountry(radio.country);
    renderRadioCountry();
    radio.loading = true;
    radio.error = '';
    radio.stations = [];
    if (radio.subEl) { radio.subEl.textContent = 'Buscando emisoras de ' + c[1] + '…'; }
    renderRadioCats();
    renderRadioSkeleton();
    portalServiceCall('radioStations', { country: c[0], language: c[2] || '' }, function (error, payload) {
      if (seq !== radio.seq) { return; }
      radio.loading = false;
      if (error || !payload || payload.returnValue === false || !payload.stations) {
        radio.error = netOnline()
          ? 'El servidor de radios no respondió (tu internet funciona). Vuelve a intentarlo en un momento.'
          : 'Sin conexión a internet: no se pudo cargar la lista de emisoras. Revisa tu wifi o el cable.';
        if (radio.subEl) { radio.subEl.textContent = c[1]; }
        renderRadioCats();
        renderRadioGrid();
        return;
      }
      radio.stations = payload.stations;
      if (radio.subEl) { radio.subEl.textContent = 'Emisoras de ' + c[1] + ' · ' + radio.stations.length + ' en línea'; }
      renderRadioCats();
      renderRadioGrid();
    }, 25000);
  }

  function radioCategoryCounts() {
    var counts = {};
    for (var i = 0; i < radio.stations.length; i++) {
      for (var k = 2; k < RADIO_CATEGORIES.length; k++) {
        if (radioInCategory(radio.stations[i], RADIO_CATEGORIES[k].key)) { counts[RADIO_CATEGORIES[k].key] = (counts[RADIO_CATEGORIES[k].key] || 0) + 1; }
      }
    }
    return counts;
  }
  function renderRadioCats() {
    if (!radio.catsEl) { return; }
    clear(radio.catsEl);
    var counts = radioCategoryCounts();
    var favCount = Object.keys(radioStore.favs).length;
    for (var i = 0; i < RADIO_CATEGORIES.length; i++) {
      var cat = RADIO_CATEGORIES[i];
      var n = cat.key === 'all' ? radio.stations.length : cat.key === 'fav' ? favCount : (counts[cat.key] || 0);
      if (cat.key === 'fav' && !n) { continue; }
      if (cat.key !== 'all' && cat.key !== 'fav' && n < 2) { continue; }
      var chip = el('div', 'radio-cat focusable' + (radio.category === cat.key ? ' is-selected' : ''));
      chip.appendChild(el('span', null, cat.label));
      if (!radio.loading) { chip.appendChild(el('em', null, String(n))); }
      chip._cat = cat.key;
      chip._activate = (function (key) {
        return function () {
          if (radio.category === key) { return; }
          radio.category = key;
          renderRadioCats();
          renderRadioGrid();
          var again = radio.catsEl.querySelector('.radio-cat.is-selected');
          if (again) { setFocus(again, true); }
        };
      })(cat.key);
      radio.catsEl.appendChild(chip);
    }
  }
  function renderRadioSkeleton() {
    if (!radio.gridEl) { return; }
    clear(radio.gridEl);
    if (radio.stateEl) { radio.stateEl.textContent = ''; }
    for (var i = 0; i < 12; i++) {
      var sk = el('div', 'radio-card is-skeleton');
      sk.appendChild(el('div', 'rc-art'));
      sk.appendChild(el('div', 'rc-name'));
      sk.appendChild(el('div', 'rc-meta'));
      radio.gridEl.appendChild(sk);
    }
  }
  function radioVisibleStations(done) {
    if (radio.category !== 'fav') { return done(radio.stations.filter(function (s) { return radioInCategory(s, radio.category); })); }
    var ids = Object.keys(radioStore.favs);
    if (!ids.length) { return done([]); }
    /* Favoritas de cualquier país, con direcciones recién pedidas. */
    portalServiceCall('radioStations', { uuids: ids.join(',') }, function (error, payload) {
      done(!error && payload && payload.stations ? payload.stations : []);
    }, 25000);
  }
  function renderRadioGrid() {
    if (!radio.gridEl) { return; }
    if (radio.loading) { return; }
    var seq = radio.seq;
    var category = radio.category;
    if (radio.error) {
      clear(radio.gridEl);
      radio.stateEl.textContent = radio.error;
      var retry = el('div', 'radio-retry focusable', 'Reintentar');
      retry._activate = loadRadioStations;
      radio.stateEl.appendChild(retry);
      return;
    }
    radioVisibleStations(function (list) {
      if (seq !== radio.seq || category !== radio.category) { return; }
      clear(radio.gridEl);
      radio.list = list;
      radio.stateEl.textContent = list.length ? '' :
        (category === 'fav' ? 'Aún no tienes radios favoritas. Pulsa ★ en la barra de abajo mientras escuchas una.' : 'No hay emisoras en esta categoría.');
      for (var i = 0; i < list.length; i++) { radio.gridEl.appendChild(makeRadioCard(list[i], i)); }
      syncRadioCards();
    });
  }
  function makeRadioCard(st, index) {
    var card = el('div', 'radio-card focusable');
    card.style.animationDelay = Math.min(index, 30) * 22 + 'ms';
    var hue = radioHue(st.name);
    var art = el('div', 'rc-art');
    art.style.setProperty('--h', hue);
    var initials = el('div', 'rc-initial', radioInitials(st.name));
    art.appendChild(initials);
    if (st.logo) {
      var img = el('img', 'rc-logo');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.onload = function () { if (this.naturalWidth > 8) { art.classList.add('has-logo'); } else { this.remove(); } };
      img.onerror = function () { this.remove(); };
      img.src = st.logo;
      art.appendChild(img);
    }
    art.appendChild(radioEq());
    if (radioStore.favs[st.id]) { art.appendChild(el('div', 'rc-fav', '★')); }
    card.appendChild(art);
    card.appendChild(el('div', 'rc-name', st.name));
    var meta = radioFirstCategory(st) + (st.city ? ' · ' + st.city : '');
    card.appendChild(el('div', 'rc-meta', meta));
    card.title = st.name + (st.bitrate ? ' · ' + st.bitrate + ' kbps' : '');
    card._station = st;
    card._activate = function () {
      if (radio.current && radio.current.id === st.id && radio.current.stream === st.stream) { radioToggle(); return; }
      radioPlay(st);
    };
    return card;
  }
  function syncRadioCards() {
    if (!radio.gridEl) { return; }
    var cards = radio.gridEl.querySelectorAll('.radio-card');
    for (var i = 0; i < cards.length; i++) {
      var st = cards[i]._station;
      var on = !!(st && radio.current && radio.current.id === st.id);
      cards[i].classList.toggle('is-current', on);
      cards[i].classList.toggle('is-playing', on && radio.status === 'playing');
      cards[i].classList.toggle('is-loading', on && radio.status === 'loading');
    }
  }

  /* ---- Reproducción ---- */
  function radioEngine() {
    if (radio.audio) { return radio.audio; }
    var a = new Audio();
    a.preload = 'none';
    a.volume = radio.volume;
    a.addEventListener('playing', function () { radioSetStatus('playing'); });
    a.addEventListener('waiting', function () { if (radio.current && !a.paused) { radioSetStatus('loading'); } });
    a.addEventListener('pause', function () { if (radio.current && radio.status !== 'error' && radio.status !== 'idle') { radioSetStatus('paused'); } });
    a.addEventListener('error', function () { if (radio.current && a.getAttribute('src')) { radioFail(); } });
    radio.audio = a;
    return a;
  }
  function radioReleaseEngine() {
    if (radio.watchdog) { clearTimeout(radio.watchdog); radio.watchdog = null; }
    if (radio.hls) { try { radio.hls.destroy(); } catch (eH) { /* ignore */ } radio.hls = null; }
    if (radio.audio) {
      try { radio.audio.pause(); } catch (eP) { /* ignore */ }
      radio.audio.removeAttribute('src');
      try { radio.audio.load(); } catch (eL) { /* ignore */ }
    }
  }
  function radioPlay(st) {
    radioReleaseEngine();
    radio.current = st;
    radioSetStatus('loading');
    /* Solo suena una cosa: la TV y cualquier vídeo fuera del reproductor quedan en silencio. */
    radioEnforce();
    if (window.desktop && window.desktop.music && music.playing) { musicPauseNow(); }
    nowSource = 'radio';
    renderMusicBar();
    var a = radioEngine();
    a.volume = radio.volume;
    if (st.hls && window.Hls && window.Hls.isSupported()) {
      var hls = new window.Hls({ enableWorker: true, maxBufferLength: 20, liveSyncDurationCount: 3 });
      radio.hls = hls;
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () { a.play().catch(function () {}); });
      hls.on(window.Hls.Events.ERROR, function (_, data) { if (data && data.fatal && radio.hls === hls) { radioFail(); } });
      hls.loadSource(st.stream);
      hls.attachMedia(a);
    } else {
      a.src = st.stream;
      a.play().catch(function () { /* 'error' informa */ });
    }
    radio.watchdog = setTimeout(function () {
      radio.watchdog = null;
      if (radio.current === st && radio.status === 'loading') { radioFail(); }
    }, 15000);
    radioStore.last = { id: st.id, name: st.name };
    saveRadioStore();
    portalServiceCall('radioClick', { id: st.id }, function () {}, 15000);
  }
  function radioFail() {
    radioReleaseEngine();
    radioSetStatus('error');
  }
  function radioToggle() {
    if (!radio.current) { return; }
    var a = radioEngine();
    if (radio.status === 'error') { radioPlay(radio.current); return; }
    if (a.paused) {
      /* Una radio en vivo pausada se reanuda en directo, no desde lo guardado. */
      radioPlay(radio.current);
    } else {
      a.pause();
    }
  }
  function radioStop() {
    radioReleaseEngine();
    radioSetStatus('idle');
    radio.current = null;
    renderRadioBar();
  }
  /* Algo con sonido va a sonar (película, canal): la radio se pausa. */
  function radioYield() {
    if (!radio.current || !radioActive()) { return; }
    if (radio.watchdog) { clearTimeout(radio.watchdog); radio.watchdog = null; }
    if (radio.hls) { try { radio.hls.stopLoad(); } catch (eStop) { /* ignore */ } }
    if (radio.audio) { try { radio.audio.pause(); } catch (eP) { /* ignore */ } }
    /* En el acto (el evento "pause" llega después): así nada vuelve a silenciar la TV. */
    radioSetStatus('paused');
  }
  function radioSetStatus(status) {
    var was = radioActive();
    radio.status = status;
    if (status === 'playing' && radio.watchdog) { clearTimeout(radio.watchdog); radio.watchdog = null; }
    if (radioActive()) { radioEnforce(); }
    else if (was && !musicSounding()) { radioRestoreOthers(); }
    syncRadioCards();
    renderRadioBar();
  }

  /* ---- Solo suena uno: la radio o el vídeo ----
     Mientras la radio suena, todo vídeo con sonido fuera del reproductor (vista
     previa de TV, canal devuelto a Inicio, vista previa de una ficha) se
     silencia, también si algo le devuelve el sonido después.  Si el usuario
     abre el reproductor o activa el sonido de la TV, la radio se pausa. */
  function radioEnforce() {
    if (!radioActive() && !musicSounding()) { return; }
    var media = document.querySelectorAll('video, audio');
    for (var i = 0; i < media.length; i++) {
      var m = media[i];
      if (m === radio.audio || m.muted || m.volume === 0) { continue; }
      if (m === playerVideo && state.screen === 'player') { radioYield(); musicPauseNow(); return; }
      m.muted = true;
      m._radioMuted = true;
    }
  }
  function radioRestoreOthers() {
    var media = document.querySelectorAll('video, audio');
    var live = false;
    for (var i = 0; i < media.length; i++) {
      var m = media[i];
      if (!m._radioMuted) { continue; }
      m._radioMuted = false;
      if (m === livePreviewVideo || (m === playerVideo && liveHandoff && liveHandoff.type === 'player')) { live = true; }
      else { m.muted = false; }
    }
    /* La TV vuelve con su propio ajuste de sonido (puede estar silenciada a propósito). */
    if (live || livePreviewVideo) { applyLiveAudio(false); }
  }
  /* Cualquier vídeo que empiece o recupere el sonido mientras suena la radio. */
  document.addEventListener('playing', function () { radioEnforce(); }, true);
  document.addEventListener('volumechange', function (event) {
    if (event.target !== radio.audio) { radioEnforce(); }
  }, true);
  function radioSetVolume(v) {
    radio.volume = Math.max(0, Math.min(1, Math.round(v * 20) / 20));
    if (radio.audio) { radio.audio.volume = radio.volume; }
    saveRadioStore();
    renderRadioBar();
  }
  function radioToggleFav() {
    var st = radio.current;
    if (!st || !st.id) { return; }
    if (radioStore.favs[st.id]) { delete radioStore.favs[st.id]; }
    else { radioStore.favs[st.id] = { name: st.name, at: Date.now() }; }
    saveRadioStore();
    renderRadioBar();
    if (radio.gridEl && radio.category !== 'fav') {
      renderRadioCats();
      var cards = radio.gridEl.querySelectorAll('.radio-card');
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i]._station;
        if (!c || c.id !== st.id) { continue; }
        var art = cards[i].querySelector('.rc-art');
        var badge = art.querySelector('.rc-fav');
        if (radioStore.favs[st.id] && !badge) { art.appendChild(el('div', 'rc-fav', '★')); }
        if (!radioStore.favs[st.id] && badge) { badge.remove(); }
      }
    }
  }

  /* ---- Barra "Escuchando ahora" (en todas las pantallas menos el reproductor) ---- */
  function buildRadioBar() {
    if (radio.bar) { return radio.bar; }
    var bar = el('div', 'radio-now');
    var art = el('div', 'rn-art');
    bar.appendChild(art);
    var info = el('div', 'rn-info');
    info.appendChild(el('div', 'rn-name'));
    var status = el('div', 'rn-status');
    status.appendChild(el('span', 'radio-live-dot'));
    status.appendChild(el('span', 'rn-status-text'));
    info.appendChild(status);
    bar.appendChild(info);
    bar.appendChild(radioEq());
    function button(cls, title, fn) {
      var b = el('div', 'rn-btn focusable ' + cls);
      b.setAttribute('role', 'button');
      b.title = title;
      b.setAttribute('aria-label', title);
      b._activate = fn;
      bar.appendChild(b);
      return b;
    }
    radio.barFav = button('rn-fav', 'Añadir a Mis radios', radioToggleFav);
    radio.barPlay = button('rn-play', 'Pausa', radioToggle);
    if (window.XUPER_DESKTOP && window.desktop && window.desktop.miniMode) {
      var mini = button('rn-mini', 'Mini radio: controles en una ventanita (Ctrl+P)', function () { setRadioMini(true); });
      mini.innerHTML = RADIO_ICONS.mini;
    }
    var vol = el('div', 'rn-vol');
    var range = document.createElement('input');
    range.type = 'range'; range.min = '0'; range.max = '100'; range.step = '5';
    range.className = 'rn-range';
    range.setAttribute('aria-label', 'Volumen de la radio');
    range.addEventListener('input', function () { radioSetVolume(Number(range.value) / 100); });
    range.addEventListener('keydown', function (event) { event.stopPropagation(); });
    vol.appendChild(range);
    vol.appendChild(el('span', 'rn-pct'));
    bar.appendChild(vol);
    radio.barRange = range;
    /* X al final: apaga la radio y cierra la barra. */
    radio.barStop = button('rn-close', 'Cerrar la radio', radioStop);
    radio.barStop.innerHTML = RADIO_ICONS.close;
    bar.addEventListener('wheel', function (event) {
      event.preventDefault();
      radioSetVolume(radio.volume + (event.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });
    var host = $('app') || document.body;
    host.appendChild(bar);
    radio.bar = bar;
    return bar;
  }
  function renderRadioBar() {
    radioMediaSession();
    if (radioMiniOn) { renderRadioMini(); }
    if (!radio.current) {
      if (radio.bar) { radio.bar.classList.remove('is-shown'); }
      radioBarSpace(false);
      return;
    }
    var bar = buildRadioBar();
    var st = radio.current;
    bar.querySelector('.rn-name').textContent = st.name;
    var art = bar.querySelector('.rn-art');
    if (art._for !== st.id) {
      art._for = st.id;
      clear(art);
      art.style.setProperty('--h', radioHue(st.name));
      art.appendChild(el('div', 'rc-initial', radioInitials(st.name)));
      if (st.logo) {
        var img = el('img', 'rc-logo');
        img.onload = function () { if (this.naturalWidth > 8) { art.classList.add('has-logo'); } else { this.remove(); } };
        img.onerror = function () { this.remove(); };
        art.classList.remove('has-logo');
        img.src = st.logo;
        art.appendChild(img);
      }
    }
    var texts = { loading: 'Conectando…', playing: 'En vivo', paused: 'En pausa', error: netOnline() ? 'No responde ahora · prueba otra emisora' : 'Sin internet · revisa tu conexión', idle: '' };
    bar.querySelector('.rn-status-text').textContent = texts[radio.status] || '';
    bar.classList.toggle('is-playing', radio.status === 'playing');
    bar.classList.toggle('is-loading', radio.status === 'loading');
    bar.classList.toggle('is-error', radio.status === 'error');
    var playing = radio.status === 'playing' || radio.status === 'loading';
    radio.barPlay.innerHTML = playing ? RADIO_ICONS.pause : RADIO_ICONS.play;
    radio.barPlay.title = playing ? 'Pausa' : 'Escuchar';
    var fav = !!radioStore.favs[st.id];
    radio.barFav.innerHTML = fav ? RADIO_ICONS.starOn : RADIO_ICONS.star;
    radio.barFav.classList.toggle('is-on', fav);
    radio.barFav.title = fav ? 'Quitar de Mis radios' : 'Añadir a Mis radios';
    radio.barRange.value = String(Math.round(radio.volume * 100));
    radio.barRange.style.setProperty('--p', Math.round(radio.volume * 100) + '%');
    bar.querySelector('.rn-pct').textContent = Math.round(radio.volume * 100) + '%';
    var shown = state.screen !== 'player' && state.screen !== 'welcome' && !musicBarWanted();
    bar.classList.toggle('is-shown', shown);
    radioBarSpace(shown);
    if (music.open) { musicScheduleLayout(); }
  }
  /* Con la barra visible, las páginas dejan su hueco abajo para que no tape nada. */
  function radioBarSpace(on) {
    var root = document.documentElement;
    /* Hueco para la barra que esté a la vista: la de la radio o la de YouMusic. */
    on = !!(on || (music.bar && music.bar.classList.contains('is-shown')) ||
            (radio.bar && radio.bar.classList.contains('is-shown')));
    if (root.classList.contains('has-radio-bar') === on) { return; }
    root.classList.toggle('has-radio-bar', on);
    schedulePosterMemoryPass();
  }
  /* Emisora anterior / siguiente dentro de la lista que se está viendo. */
  function radioStep(dir) {
    var list = (radio.list && radio.list.length) ? radio.list : radio.stations;
    if (!list.length) { return; }
    var at = -1;
    for (var i = 0; i < list.length; i++) { if (radio.current && list[i].id === radio.current.id) { at = i; break; } }
    radioPlay(list[(at + dir + list.length) % list.length]);
  }

  /* ---- Controles del sistema (Media Session) ----
     Windows: panel multimedia y teclas multimedia (⏯ ⏭ ⏮).  Linux: MPRIS
     (GNOME, KDE).  Mientras se ve un vídeo en el reproductor, las teclas
     vuelven a ser del vídeo. */
  var RADIO_MS_ACTIONS = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'];
  var radioMsOwned = false;
  function radioMediaSession() {
    var ms = navigator.mediaSession;
    if (!ms || !window.MediaMetadata) { return; }
    var st = radio.current;
    if (!st || radio.status === 'idle' || state.screen === 'player') {
      if (radioMsOwned) {
        radioMsOwned = false;
        radio._msFor = '';
        try { ms.metadata = null; ms.playbackState = 'none'; } catch (eClear) { /* ignore */ }
        for (var c = 0; c < RADIO_MS_ACTIONS.length; c++) {
          try { ms.setActionHandler(RADIO_MS_ACTIONS[c], null); } catch (eNull) { /* ignore */ }
        }
        /* La ventana flotante del vídeo vuelve a registrar sus teclas. */
        pipMediaSessionReady = false;
      }
      return;
    }
    if (!radioMsOwned) {
      radioMsOwned = true;
      var handlers = {
        play: function () { if (!radioActive()) { radioToggle(); } },
        pause: function () { radioYield(); },
        stop: function () { radioStop(); },
        nexttrack: function () { radioStep(1); },
        previoustrack: function () { radioStep(-1); }
      };
      for (var h = 0; h < RADIO_MS_ACTIONS.length; h++) {
        try { ms.setActionHandler(RADIO_MS_ACTIONS[h], handlers[RADIO_MS_ACTIONS[h]]); } catch (eSet) { /* acción no admitida */ }
      }
    }
    if (radio._msFor !== st.id) {
      radio._msFor = st.id;
      try {
        ms.metadata = new MediaMetadata({
          title: st.name,
          artist: 'Radio en vivo · ' + radioFirstCategory(st),
          album: 'Xuper',
          artwork: st.logo ? [{ src: st.logo, sizes: '512x512' }] : []
        });
      } catch (eMeta) { /* opcional */ }
    }
    try { ms.playbackState = radioActive() ? 'playing' : 'paused'; } catch (eState) { /* ignore */ }
  }

  /* ---- Mini radio: la ventana se encoge a una tarjeta con los controles ----
     Mismo mecanismo que la ventanita del vídeo (siempre encima, esquina),
     con un tamaño más bajo. Controles en píxeles reales, fuera del lienzo. */
  var radioMiniOn = false, radioMiniUi = null;
  var RADIO_MINI_SIZE = { w: 500, h: 180 };
  function buildRadioMini() {
    if (radioMiniUi) { return radioMiniUi; }
    var root = el('div', 'rmini');
    root.innerHTML =
      '<div class="rmini-art"></div>' +
      '<div class="rmini-main">' +
        '<div class="rmini-top">' +
          '<div class="rmini-name"></div>' +
          '<button type="button" class="rmini-btn rmini-small" data-act="restore" title="Volver a la ventana completa (Esc)" aria-label="Volver a la ventana completa">' + RADIO_ICONS.restore + '</button>' +
          '<button type="button" class="rmini-btn rmini-small rmini-close" data-act="close" title="Cerrar la ventanita (la radio sigue sonando)" aria-label="Cerrar la ventanita">' + RADIO_ICONS.close + '</button>' +
        '</div>' +
        '<div class="rmini-status"><span class="radio-live-dot"></span><span class="rmini-status-text"></span></div>' +
        '<div class="rmini-ctrl">' +
          '<button type="button" class="rmini-btn" data-act="prev" title="Emisora anterior (←)" aria-label="Emisora anterior">' + RADIO_ICONS.prev + '</button>' +
          '<button type="button" class="rmini-btn rmini-play" data-act="play" aria-label="Escuchar o pausar"></button>' +
          '<button type="button" class="rmini-btn" data-act="next" title="Emisora siguiente (→)" aria-label="Emisora siguiente">' + RADIO_ICONS.next + '</button>' +
          '<button type="button" class="rmini-btn rmini-fav" data-act="fav" aria-label="Mis radios"></button>' +
          '<input class="rmini-range" type="range" min="0" max="100" step="5" aria-label="Volumen">' +
          '<span class="rmini-pct"></span>' +
        '</div>' +
      '</div>';
    root.querySelector('.rmini-main').insertBefore(radioEq(), root.querySelector('.rmini-ctrl'));
    if (window.desktop && window.desktop.miniNativeFrame) { root.classList.add('is-native-frame'); }
    var range = root.querySelector('.rmini-range');
    range.addEventListener('input', function () { radioSetVolume(Number(range.value) / 100); });
    root.addEventListener('click', function (event) {
      event.stopPropagation();
      var btn = closest(event.target, '[data-act]');
      if (!btn) { return; }
      var act = btn.getAttribute('data-act');
      if (act === 'play') { radioToggle(); }
      else if (act === 'prev') { radioStep(-1); }
      else if (act === 'next') { radioStep(1); }
      else if (act === 'fav') { radioToggleFav(); }
      else if (act === 'restore') { setRadioMini(false); }
      /* Cerrar la ventanita no apaga la radio: se vuelve a la ventana completa con la misma emisora. */
      else if (act === 'close') { setRadioMini(false); }
    });
    /* Mover la ventanita arrastrando desde cualquier parte que no sea un control. */
    root.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || closest(event.target, 'button, input')) { return; }
      try { if (window.desktop.miniDrag) { window.desktop.miniDrag(); } } catch (eDrag) { /* ignore */ }
    });
    root.addEventListener('dblclick', function (event) {
      if (!closest(event.target, 'button, input')) { setRadioMini(false); }
    });
    root.addEventListener('wheel', function (event) {
      event.preventDefault();
      radioSetVolume(radio.volume + (event.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });
    document.body.appendChild(root);
    radioMiniUi = root;
    return root;
  }
  function renderRadioMini() {
    if (!radioMiniOn || !radioMiniUi) { return; }
    var st = radio.current;
    /* Radio apagada desde la mini: volver a la ventana completa. */
    if (!st) { setRadioMini(false); return; }
    var root = radioMiniUi;
    root.querySelector('.rmini-name').textContent = st.name;
    var art = root.querySelector('.rmini-art');
    if (art._for !== st.id) {
      art._for = st.id;
      clear(art);
      art.classList.remove('has-logo');
      art.style.setProperty('--h', radioHue(st.name));
      art.appendChild(el('div', 'rc-initial', radioInitials(st.name)));
      if (st.logo) {
        var img = el('img', 'rc-logo');
        img.onload = function () { if (this.naturalWidth > 8) { art.classList.add('has-logo'); } else { this.remove(); } };
        img.onerror = function () { this.remove(); };
        img.src = st.logo;
        art.appendChild(img);
      }
      try { window.desktop.miniTitle(st.name); } catch (eTitle) { /* ignore */ }
    }
    var texts = { loading: 'Conectando…', playing: 'En vivo', paused: 'En pausa', error: netOnline() ? 'No responde · prueba otra' : 'Sin internet', idle: '' };
    root.querySelector('.rmini-status-text').textContent = texts[radio.status] || '';
    root.classList.toggle('is-playing', radio.status === 'playing');
    root.classList.toggle('is-loading', radio.status === 'loading');
    root.classList.toggle('is-error', radio.status === 'error');
    var playing = radioActive();
    var play = root.querySelector('.rmini-play');
    play.innerHTML = playing ? RADIO_ICONS.pause : RADIO_ICONS.play;
    play.title = playing ? 'Pausa (Espacio)' : 'Escuchar (Espacio)';
    var fav = !!radioStore.favs[st.id];
    var favBtn = root.querySelector('.rmini-fav');
    favBtn.innerHTML = fav ? RADIO_ICONS.starOn : RADIO_ICONS.star;
    favBtn.classList.toggle('is-on', fav);
    favBtn.title = fav ? 'Quitar de Mis radios' : 'Añadir a Mis radios';
    var range = root.querySelector('.rmini-range');
    range.value = String(Math.round(radio.volume * 100));
    range.style.setProperty('--p', Math.round(radio.volume * 100) + '%');
    root.querySelector('.rmini-pct').textContent = Math.round(radio.volume * 100) + '%';
  }
  function radioMiniKeys(event) {
    if (!radioMiniOn) { return; }
    var k = event.key;
    if (k === 'Escape') { setRadioMini(false); }
    else if (k === ' ' || k === 'k' || k === 'K' || k === 'Enter') { radioToggle(); }
    else if (k === 'ArrowLeft') { radioStep(-1); }
    else if (k === 'ArrowRight') { radioStep(1); }
    else if (k === 'ArrowUp') { radioSetVolume(radio.volume + 0.05); }
    else if (k === 'ArrowDown') { radioSetVolume(radio.volume - 0.05); }
    /* Rust quita el menú en la ventanita: Ctrl+P lo atiende la página. */
    else if ((k === 'p' || k === 'P') && event.ctrlKey && !(window.desktop && window.desktop.miniNativeFrame)) { setRadioMini(false); }
    else if (k === 'p' || k === 'P') { return; }
    event.preventDefault();
    event.stopPropagation();
  }
  function setRadioMini(on) {
    if (!window.XUPER_DESKTOP || !window.desktop || !window.desktop.miniMode) { return; }
    if (on === radioMiniOn || (on && (!radio.current || miniOn))) { return; }
    radioMiniOn = on;
    if (on) {
      if (typeof closeMusic === 'function') { closeMusic(); }
      buildRadioMini();
      radioMiniUi._shownTitle = '';
      document.documentElement.classList.add('is-mini-radio');
      window.addEventListener('keydown', radioMiniKeys, true);
      renderRadioMini();
    } else {
      window.removeEventListener('keydown', radioMiniKeys, true);
      document.documentElement.classList.remove('is-mini-radio');
      if (radioMiniUi) { radioMiniUi.querySelector('.rmini-art')._for = ''; }
    }
    Promise.resolve(window.desktop.miniMode(on, on ? radio.current.name : null, on ? RADIO_MINI_SIZE : null))
      .catch(function () {})
      .then(function () {
        setTimeout(function () {
          fitDesignViewport();
          if (!on && radio.bar) { renderRadioBar(); }
        }, 120);
      });
  }

  /* Cambio de pantalla: el reproductor tiene prioridad sobre la radio. */
  function radioOnScreen(name) {
    if (name === 'player') {
      radioYield();
      /* El vídeo que la radio silenció como vista previa recupera el sonido. */
      if (playerVideo && playerVideo._radioMuted) { playerVideo.muted = false; playerVideo._radioMuted = false; }
    }
    if (radio.current) { renderRadioBar(); }
    musicOnScreen(name);
  }

  /* ================================================================ MÚSICA
     YouMusic: YouTube Music dentro de Xuper.  El escritorio (Electron o Rust)
     lo muestra en una vista web aparte, colocada exactamente sobre el hueco
     ".music-stage" de esta página: la barra lateral y la cabecera de Xuper
     siguen visibles, y al cambiar de sección se cierra (y se pausa).  Encima,
     una sola búsqueda de Xuper: "Música" busca en YouTube Music y "Películas
     y series" abre la búsqueda de Xuper.  Solo suena uno: si YouTube Music
     empieza a sonar, la radio se pausa; si suena la radio, YouMusic se pausa. */
  var music = { open: false, title: '', playing: false, active: false, page: null, stage: null, input: null, mode: 'music', events: false, layoutTimer: null, bar: null };
  /* Lo último que se puso a sonar: 'radio' o 'music'. Solo se ve su barra. */
  var nowSource = '';
  function musicSupported() { return !!(window.desktop && window.desktop.music); }
  /* YouMusic suena (en su pestaña o por detrás, con la barra de abajo). */
  function musicSounding() { return !!(music && music.playing); }
  function musicPauseNow() {
    if (!musicSupported() || !music.playing) { return; }
    music.playing = false;
    Promise.resolve(window.desktop.music.pause()).catch(function () {});
    /* Lo que se silenció por YouMusic (TV, vídeo del reproductor) recupera el sonido. */
    if (!radioActive()) { radioRestoreOthers(); }
    if (music.page) { music.page.classList.remove('is-playing'); }
    renderMusicBar();
    renderMusicMini();
  }
  function musicTabIndex() {
    for (var i = 0; i < TABS.length; i++) { if (TABS[i].needs === 'music') { return i; } }
    return -1;
  }
  /* La barra de YouMusic: cuando ya sonó algo, fuera de su pestaña. */
  function musicBarWanted() {
    return !!(musicSupported() && music.active && nowSource === 'music');
  }
  function buildMusicBar() {
    if (music.bar) { return music.bar; }
    var bar = el('div', 'radio-now music-now');
    var art = el('div', 'rn-art mn-art');
    art.innerHTML = TAB_ICONS.music || '';
    bar.appendChild(art);
    var info = el('div', 'rn-info');
    info.appendChild(el('div', 'rn-name'));
    var status = el('div', 'rn-status');
    status.appendChild(el('span', 'radio-live-dot'));
    status.appendChild(el('span', 'rn-status-text'));
    info.appendChild(status);
    bar.appendChild(info);
    bar.appendChild(radioEq());
    function button(cls, title, html, fn) {
      var b = el('div', 'rn-btn focusable ' + cls);
      b.setAttribute('role', 'button');
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = html;
      b._activate = fn;
      bar.appendChild(b);
      return b;
    }
    button('mn-prev', 'Anterior', RADIO_ICONS.prev, function () { musicBarControl('prev'); });
    music.barPlay = button('rn-play mn-play', 'Pausa', RADIO_ICONS.pause, function () { musicBarControl('toggle'); });
    button('mn-next', 'Siguiente', RADIO_ICONS.next, function () { musicBarControl('next'); });
    if (musicMiniSupported()) {
      button('rn-mini', 'Ventanita flotante (Ctrl+P)', RADIO_ICONS.mini, function () { setMusicMini(true); });
    }
    button('mn-open', 'Volver a YouMusic', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4"/></svg>', goToMusic);
    button('rn-close', 'Cerrar YouMusic (se detiene)', RADIO_ICONS.close, musicBarClose);
    var host = $('app') || document.body;
    host.appendChild(bar);
    music.bar = bar;
    return bar;
  }
  function musicBarControl(act) {
    if (act === 'toggle' && !music.playing) {
      /* Vuelve a sonar YouMusic: la radio se calla. */
      if (radioActive()) { radioYield(); }
      nowSource = 'music';
    }
    Promise.resolve(window.desktop.music.control(act)).catch(function () {});
    if (act === 'toggle') {
      music.playing = !music.playing;
      if (music.playing) { radioEnforce(); }
      else if (!radioActive()) { radioRestoreOthers(); }
      renderMusicBar();
    }
  }
  function musicBarClose() {
    musicPauseNow();
    music.active = false;
    nowSource = radio.current ? 'radio' : '';
    renderMusicBar();
    if (radio.current) { renderRadioBar(); }
  }
  /* Botón "Volver a YouMusic": desde cualquier pantalla a su pestaña. */
  function goToMusic() {
    var idx = musicTabIndex();
    if (idx < 0) { return; }
    if (state.screen === 'search') { clearSearchState(); }
    if (state.screen === 'detail' && !keepFloatingVideo()) { stopPlayerVideo(); }
    if (state.screen !== 'home') { showScreen('home'); }
    selectTab(idx, false);
    if (tabEls[idx]) { setFocus(tabEls[idx]); }
  }
  function renderMusicBar() {
    if (!musicSupported()) { return; }
    var shown = musicBarWanted() && !music.open && !musicMiniOn &&
      state.screen !== 'player' && state.screen !== 'welcome';
    if (!shown && !music.bar) { return; }
    var bar = buildMusicBar();
    bar.querySelector('.rn-name').textContent = music.title || 'YouMusic';
    bar.querySelector('.rn-status-text').textContent = (music.artist ? music.artist + ' · ' : 'YouMusic · ') + (music.playing ? 'sonando' : 'en pausa');
    var art = bar.querySelector('.mn-art');
    if (art._for !== (music.art || '')) {
      art._for = music.art || '';
      var old = art.querySelector('img');
      if (old) { old.remove(); }
      art.classList.remove('has-cover');
      if (music.art) {
        var img = el('img', 'mn-cover');
        img.onload = function () { art.classList.add('has-cover'); };
        img.onerror = function () { this.remove(); };
        img.src = music.art;
        art.appendChild(img);
      }
    }
    bar.classList.toggle('is-playing', !!music.playing);
    music.barPlay.innerHTML = music.playing ? RADIO_ICONS.pause : RADIO_ICONS.play;
    music.barPlay.title = music.playing ? 'Pausa' : 'Reproducir';
    var was = bar.classList.contains('is-shown');
    bar.classList.toggle('is-shown', shown);
    if (was !== shown) {
      /* Una sola barra a la vista: la de la radio se esconde o vuelve. */
      if (radio.current) { renderRadioBar(); }
      radioBarSpace(shown);
    }
  }
  function musicOnScreen(name) {
    if (!musicSupported()) { return; }
    /* Una película o un canal en el reproductor: YouMusic se pausa. */
    if (name === 'player') { musicPauseNow(); }
    renderMusicBar();
  }
  function buildMusicPage(page) {
    music.page = page;
    page.classList.add('music-page');
    var wrap = el('div', 'music-shell');
    abs(wrap, 192, BENTO.bigY, 1664, 1080 - BENTO.bigY - 150);
    var bar = el('div', 'music-search');
    function navButton(cls, html, title, fn) {
      var b = el('div', 'music-nav focusable ' + cls);
      b.setAttribute('role', 'button');
      b.innerHTML = html;
      b.title = title;
      b._activate = fn;
      bar.appendChild(b);
      return b;
    }
    /* Lo que antes estaba en la barra y el menú lateral de YouTube Music. */
    function go(page) { return function () { if (!music.open) { openMusic(); } window.desktop.music.go(page); }; }
    navButton('music-nav-back', '‹', 'Página anterior', function () { if (music.open) { window.desktop.music.back(); } });
    navButton('music-nav-home', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"><path d="M4 11.5 12 5l8 6.5V20h-5.5v-5.5h-5V20H4z"/></svg>', 'Principal', go('home'));
    navButton('music-nav-explore', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z" fill="currentColor"/></svg>', 'Explorar: novedades, listas y géneros', go('explore'));
    navButton('music-nav-library', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"><path d="M6.5 4h11v16l-5.5-3.6L6.5 20z"/></svg>', 'Biblioteca: tus listas y canciones guardadas', go('library'));
    /* MisEstrellas: canciones guardadas desde el menú de los tres puntitos
       (lista propia de Xuper, se guarda en este equipo). */
    navButton('music-nav-stars', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>', 'MisEstrellas: tus canciones guardadas', function () { if (!music.open) { openMusic(); } window.desktop.music.stars(1); });
    /* DescargarY: reabre la selección o el progreso de la descarga. */
    navButton('music-nav-downloads', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></svg>', 'DescargarY: descargas de audio y vídeo', function () { window.desktop.music.downloads(); });
    var box = el('div', 'music-box');
    box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>';
    var input = el('input', 'music-input focusable');
    input.type = 'search';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Buscar');
    input.addEventListener('keydown', function (event) {
      if (event.isComposing) { return; }
      var list = music.sugg || [];
      if (event.key === 'Enter') { event.preventDefault(); musicSearch(); }
      else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && list.length) {
        /* Sugerencias: flechas para recorrerlas (el texto se va poniendo en el buscador). */
        event.preventDefault();
        var n = list.length + 1;                       // la última posición es "lo que escribí"
        var i = (music.suggIndex < 0 ? list.length : music.suggIndex) + (event.key === 'ArrowDown' ? 1 : -1);
        i = ((i % n) + n) % n;
        music.suggIndex = i === list.length ? -1 : i;
        input.value = music.suggIndex < 0 ? (music.suggTyped || '') : list[music.suggIndex];
        try { window.desktop.music.suggestSelect(music.suggIndex); } catch (eSel) { /* ignore */ }
      }
      else if (event.key === 'Escape') { if (list.length) { musicSuggestHide(); } else { input.blur(); } }
      event.stopPropagation();
    });
    /* Búsqueda predictiva: sugerencias de YouTube Music mientras se escribe. */
    input.addEventListener('input', musicSuggestSoon);
    input.addEventListener('blur', function () { setTimeout(musicSuggestHide, 200); });
    input._activate = function () { input.focus(); };
    box.appendChild(input);
    bar.appendChild(box);
    music.input = input;
    var modes = el('div', 'music-modes');
    [['music', '🎵 Música', 'Buscar canciones, artistas y álbumes en YouMusic'], ['xuper', '🎬 Películas y series', 'Buscar en el catálogo de Xuper']].forEach(function (m) {
      var chip = el('div', 'music-mode focusable', m[1]);
      chip._mode = m[0];
      chip.title = m[2];
      chip._activate = function () { musicSetMode(m[0]); if (input.value.trim()) { musicSearch(); } else { input.focus(); } };
      modes.appendChild(chip);
    });
    bar.appendChild(modes);
    var goBtn = el('div', 'music-go focusable', 'Buscar');
    goBtn.setAttribute('role', 'button');
    goBtn._activate = musicSearch;
    bar.appendChild(goBtn);
    /* La ventanita se abre con el botón ⧉ de los controles de YouMusic (o Ctrl+P). */
    navButton('music-nav-account', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.8 20c.9-3.9 3.6-5.8 7.2-5.8s6.3 1.9 7.2 5.8" stroke-linecap="round"/></svg>', 'Cuenta: iniciar sesión con Google (opcional)', go('signin'));
    wrap.appendChild(bar);
    var stage = el('div', 'music-stage');
    var waiting = el('div', 'music-waiting focusable');
    waiting.setAttribute('role', 'button');
    waiting._activate = function () { openMusic(); };
    music.waiting = waiting;
    waiting.appendChild(radioEq());
    waiting.appendChild(el('div', 'music-waiting-text', musicSupported() ? 'Abriendo YouMusic…' : 'YouMusic no está disponible en esta versión.'));
    stage.appendChild(waiting);
    wrap.appendChild(stage);
    music.stage = stage;
    page.appendChild(wrap);
    musicSetMode('music');
    window.addEventListener('resize', musicScheduleLayout);
  }
  function musicSetMode(mode) {
    music.mode = mode;
    if (!music.page) { return; }
    var chips = music.page.querySelectorAll('.music-mode');
    for (var i = 0; i < chips.length; i++) { chips[i].classList.toggle('is-selected', chips[i]._mode === mode); }
    if (music.input) {
      music.input.placeholder = mode === 'music' ? 'Busca canciones, artistas o álbumes…' : 'Busca tu película o serie de Xuper…';
    }
  }
  /* Sugerencias mientras se escribe. La lista se dibuja DENTRO de la vista de
     YouTube Music (que va siempre por encima de esta página y taparía una
     lista hecha aquí), alineada bajo el buscador. */
  function musicSuggestSoon() {
    if (music.suggTimer) { clearTimeout(music.suggTimer); }
    music.suggTimer = setTimeout(musicSuggestAsk, 170);
  }
  function musicSuggestAsk() {
    music.suggTimer = null;
    if (music.mode !== 'music' || !music.open || !music.input || !music.stage ||
        !window.desktop || !window.desktop.music || !window.desktop.music.suggest) { return; }
    var q = music.input.value.trim();
    if (q.length < 2) { musicSuggestHide(); return; }
    var box = music.input.parentNode.getBoundingClientRect();
    var stage = music.stage.getBoundingClientRect();
    music.suggTyped = q;
    music.suggIndex = -1;
    window.desktop.music.suggest({ q: q, left: Math.round(box.left - stage.left), width: Math.round(box.width) });
  }
  function musicSuggestHide() {
    if (music.suggTimer) { clearTimeout(music.suggTimer); music.suggTimer = null; }
    var had = (music.sugg && music.sugg.length) || music.suggTyped;
    music.sugg = [];
    music.suggIndex = -1;
    music.suggTyped = '';
    if (had && window.desktop && window.desktop.music && window.desktop.music.suggest) {
      try { window.desktop.music.suggest({ q: '' }); } catch (eHide) { /* ignore */ }
    }
  }
  function musicSearch() {
    musicSuggestHide();
    var q = music.input ? music.input.value.trim() : '';
    if (!q) { if (music.input) { music.input.focus(); } return; }
    if (music.mode === 'xuper') {
      /* Películas y series: a la búsqueda de Xuper con lo escrito (la música sigue). */
      closeMusic();
      openSearch();
      setSearchQuery(q);
      return;
    }
    /* Aún no abierto: la búsqueda espera a que YouMusic esté en su sitio. */
    if (!music.open) { music.pendingQuery = q; openMusic(); return; }
    window.desktop.music.search(q);
  }
  /* Rectángulo real (píxeles de la ventana) del hueco donde va YouTube Music.
     Deja sitio abajo a la barra "Escuchando ahora" si hay una radio puesta. */
  function musicBounds() {
    /* Ventanita: toda la ventana menos la tira de controles de abajo. */
    if (musicMiniOn) { return { x: 0, y: 0, w: window.innerWidth, h: Math.max(0, window.innerHeight - MUSIC_MINI_STRIP) }; }
    /* Un panel de Xuper encima (Historial, diálogos): YouMusic se esconde sin pausar. */
    if (music.covered) { return { x: 0, y: 0, w: 0, h: 0 }; }
    if (!music.stage) { return null; }
    var r = music.stage.getBoundingClientRect();
    var bottom = r.bottom;
    if (radio.current && radio.bar && radio.bar.classList.contains('is-shown')) {
      var b = radio.bar.getBoundingClientRect();
      bottom = Math.min(bottom, b.top - 12);
    }
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.max(0, Math.round(r.width)), h: Math.max(0, Math.round(bottom - r.top)) };
  }
  function musicScheduleLayout() {
    if (!music.open) { return; }
    if (music.layoutTimer) { clearTimeout(music.layoutTimer); }
    music.layoutTimer = setTimeout(function () {
      music.layoutTimer = null;
      if (music.open) { window.desktop.music.layout(musicBounds()); }
    }, 60);
  }
  /* YouTube Music va en una capa aparte, siempre por encima de esta página:
     los paneles de Xuper que se abren encima (cajón de Historial y Favoritos,
     selector de radios, diálogos) quedaban tapados.  Mientras haya uno
     abierto, la capa se esconde (la música sigue) y vuelve al cerrarlo. */
  function musicCoveredNow() {
    if (document.body.classList.contains('is-history-drawer-open')) { return true; }
    if (radio.pickerOpen || ml.dialogOpen || vt.detailOpen || vt.foldersOpen) { return true; }
    return !!document.querySelector('[id^="dialog-"].is-active');
  }
  /* Con la capa escondida por un panel, el hueco no dice "Abriendo…" (parecía
     que se recargaba): explica que sigue ahí y cómo volver a verla. */
  function musicCoverNotice(covered) {
    if (!music.waiting) { return; }
    var text = music.waiting.querySelector('.music-waiting-text');
    if (covered && music.open) {
      if (!music.waiting.classList.contains('is-covered')) { music.coverPrevText = text.textContent; }
      music.waiting.classList.add('is-covered');
      text.textContent = musicSounding()
        ? 'YouMusic sigue sonando · cierra el panel para volver a verlo'
        : 'YouMusic sigue abierto · cierra el panel para volver a verlo';
    } else if (music.waiting.classList.contains('is-covered')) {
      music.waiting.classList.remove('is-covered');
      if (music.coverPrevText != null) { text.textContent = music.coverPrevText; music.coverPrevText = null; }
    }
  }
  function musicWatchCovers() {
    if (music.coverWatch) { return; }
    music.coverWatch = new MutationObserver(function () {
      var covered = musicCoveredNow();
      if (covered === !!music.covered) { return; }
      music.covered = covered;
      musicCoverNotice(covered);
      if (music.open && !musicMiniOn) { window.desktop.music.layout(musicBounds()); }
    });
    music.coverWatch.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
  }
  function musicListen() {
    musicWatchCovers();
    if (music.events || !musicSupported()) { return; }
    music.events = true;
    window.desktop.music.onEvent(function (data) {
      if (!data) { return; }
      if (data.type === 'title' && data.title) {
        /* "Canción | YouTube Music" -> "Canción". En pausa YouTube pone solo
           "YouTube Music": se conserva el nombre de la canción. */
        var parts = String(data.title).split('⁤');
        if (parts.length >= 2 && parts[0].trim()) {
          /* Canción · artista · carátula (los manda el script de YouMusic). */
          music.title = parts[0].trim();
          music.artist = (parts[1] || '').trim();
          music.art = /^https:\/\//.test(parts[2] || '') ? parts[2].trim() : '';
        } else {
          var songTitle = String(data.title).replace(/\s*[-|–·]\s*YouTube Music$/, '').trim();
          if (songTitle && songTitle !== 'YouTube Music') { music.title = songTitle; }
          else if (!music.title) { music.title = 'YouMusic'; }
        }
        if (musicMiniOn) {
          renderMusicMini();
          try { window.desktop.miniTitle(music.title); } catch (eTitle) { /* ignore */ }
        }
        renderMusicBar();
      } else if (data.type === 'playing') {
        var wasPlaying = music.playing;
        music.playing = true;
        music.active = true;
        nowSource = 'music';
        /* Suena YouMusic: la radio se calla y la TV queda en silencio. */
        if (radioActive()) { radioYield(); }
        if (!wasPlaying) { radioEnforce(); }
        if (music.page) { music.page.classList.add('is-playing'); }
        renderMusicMini();
        renderMusicBar();
      } else if (data.type === 'suggest-list') {
        /* Sugerencias recibidas (solo si siguen siendo de lo que hay escrito). */
        if (data.q && data.q === music.suggTyped) { music.sugg = Array.isArray(data.items) ? data.items : []; music.suggIndex = -1; }
      } else if (data.type === 'suggest-pick') {
        /* Clic en una sugerencia dentro de la vista de YouTube Music. */
        if (music.input && data.q) { music.input.value = String(data.q); musicSearch(); }
      } else if (data.type === 'mini') {
        /* Botón ⧉ de la barra de YouMusic. */
        setMusicMini(true);
      } else if (data.type === 'paused') {
        var hadSound = music.playing;
        music.playing = false;
        if (music.page) { music.page.classList.remove('is-playing'); }
        /* La TV recupera su sonido (si la radio tampoco suena). */
        if (hadSound && !radioActive()) { radioRestoreOthers(); }
        renderMusicMini();
        renderMusicBar();
      }
    });
  }

  /* Ventanita de YouMusic: la ventana se encoge a la esquina, queda encima de
     todo y muestra solo el vídeo de YouTube Music, con una tira de controles
     de Xuper debajo (anterior / pausa / siguiente / volver).  Igual que la
     ventanita de películas y la mini radio: sale del entorno de Xuper. */
  var musicMiniOn = false;
  var musicMiniUi = null;
  var MUSIC_MINI_STRIP = 52;
  var MUSIC_MINI_SIZE = { w: 560, h: 315 + 52 };
  function musicMiniSupported() {
    return !!(window.XUPER_DESKTOP && window.desktop && window.desktop.miniMode && musicSupported() && window.desktop.music.mini);
  }
  function buildMusicMini() {
    if (musicMiniUi) { return musicMiniUi; }
    var root = el('div', 'ymini');
    root.innerHTML =
      '<div class="ymini-title"></div>' +
      '<button type="button" class="rmini-btn" data-act="prev" title="Anterior (←)" aria-label="Anterior">' + RADIO_ICONS.prev + '</button>' +
      '<button type="button" class="rmini-btn ymini-play" data-act="toggle" aria-label="Reproducir o pausar"></button>' +
      '<button type="button" class="rmini-btn" data-act="next" title="Siguiente (→)" aria-label="Siguiente">' + RADIO_ICONS.next + '</button>' +
      '<button type="button" class="rmini-btn rmini-small" data-act="restore" title="Volver a la ventana completa (Esc)" aria-label="Volver a la ventana completa">' + RADIO_ICONS.restore + '</button>' +
      '<button type="button" class="rmini-btn rmini-small rmini-close ymini-close" data-act="close" title="Cerrar la ventanita (la música sigue)" aria-label="Cerrar la ventanita">' + RADIO_ICONS.close + '</button>';
    if (window.desktop && window.desktop.miniNativeFrame) { root.classList.add('is-native-frame'); }
    root.addEventListener('click', function (event) {
      event.stopPropagation();
      var btn = closest(event.target, '[data-act]');
      if (!btn) { return; }
      var act = btn.getAttribute('data-act');
      if (act === 'restore' || act === 'close') { setMusicMini(false); return; }
      musicMiniControl(act);
    });
    /* Mover la ventanita arrastrando la tira (Rust; Electron usa su barra de Windows). */
    root.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || closest(event.target, 'button')) { return; }
      try { if (window.desktop.miniDrag) { window.desktop.miniDrag(); } } catch (eDrag) { /* ignore */ }
    });
    root.addEventListener('dblclick', function (event) {
      if (!closest(event.target, 'button')) { setMusicMini(false); }
    });
    document.body.appendChild(root);
    musicMiniUi = root;
    return root;
  }
  function musicMiniControl(act) {
    Promise.resolve(window.desktop.music.control(act)).catch(function () {});
    /* Respuesta inmediata en el botón; el aviso real llega enseguida. */
    if (act === 'toggle') { music.playing = !music.playing; renderMusicMini(); }
  }
  function renderMusicMini() {
    if (!musicMiniOn || !musicMiniUi) { return; }
    musicMiniUi.querySelector('.ymini-title').textContent = music.title || 'YouMusic';
    var play = musicMiniUi.querySelector('.ymini-play');
    play.innerHTML = music.playing ? RADIO_ICONS.pause : RADIO_ICONS.play;
    play.title = music.playing ? 'Pausa (Espacio)' : 'Reproducir (Espacio)';
    musicMiniUi.classList.toggle('is-playing', !!music.playing);
  }
  function musicMiniKeys(event) {
    if (!musicMiniOn) { return; }
    var k = event.key;
    if (k === 'Escape') { setMusicMini(false); }
    else if (k === ' ' || k === 'k' || k === 'K' || k === 'Enter') { musicMiniControl('toggle'); }
    else if (k === 'ArrowLeft') { musicMiniControl('prev'); }
    else if (k === 'ArrowRight') { musicMiniControl('next'); }
    /* Rust quita el menú en la ventanita: Ctrl+P lo atiende la página. */
    else if ((k === 'p' || k === 'P') && event.ctrlKey && !(window.desktop && window.desktop.miniNativeFrame)) { setMusicMini(false); }
    else { return; }
    event.preventDefault();
    event.stopPropagation();
  }
  function setMusicMini(on) {
    if (!musicMiniSupported() || on === musicMiniOn) { return; }
    if (on && ((!music.open && !music.active) || miniOn || radioMiniOn)) { return; }
    musicMiniOn = on;
    /* Desde la barra de abajo: YouMusic estaba escondido y vuelve a esconderse al salir. */
    if (on) { music.miniHidden = !music.open; }
    var hidden = music.miniHidden;
    if (on) {
      buildMusicMini();
      document.documentElement.classList.add('is-mini-music');
      window.addEventListener('keydown', musicMiniKeys, true);
      renderMusicMini();
    } else {
      window.removeEventListener('keydown', musicMiniKeys, true);
      document.documentElement.classList.remove('is-mini-music');
    }
    Promise.resolve(window.desktop.music.mini(on)).catch(function () {});
    Promise.resolve(window.desktop.miniMode(on, on ? (music.title || 'YouMusic') : null, on ? MUSIC_MINI_SIZE : null))
      .catch(function () {})
      .then(function () {
        /* La ventana cambia de tamaño en dos pasos: se recoloca YouTube Music en cada uno. */
        var place = function () {
          if (!musicMiniOn) { fitDesignViewport(); }
          if (hidden) {
            if (musicMiniOn) { window.desktop.music.open(musicBounds()); }
            else { window.desktop.music.close(); }
            return;
          }
          if (!music.open) { return; }
          window.desktop.music.layout(musicBounds());
        };
        place();
        setTimeout(place, 150);
        setTimeout(place, 500);
        if (!on) { music.miniHidden = false; }
        renderMusicBar();
      });
    renderMusicBar();
  }
  function openMusic() {
    if (!musicSupported() || music.open || !music.stage) { return; }
    musicListen();
    music.open = true;
    if (music.waiting) { music.waiting.querySelector('.music-waiting-text').textContent = 'Abriendo YouMusic…'; }
    stopLivePreview();
    if (playerVideo && !playerVideo.paused) { try { playerVideo.pause(); } catch (ePause) { /* ignore */ } }
    document.documentElement.classList.add('is-music-open');
    renderMusicBar();
    /* Tras el deslizamiento de la página (0,3 s), en su sitio exacto. */
    setTimeout(function () {
      if (!music.open) { return; }
      Promise.resolve(window.desktop.music.open(musicBounds())).then(function () {
        var q = music.pendingQuery;
        music.pendingQuery = '';
        if (q && music.open) { window.desktop.music.search(q); }
      });
    }, 340);
  }
  function closeMusic() {
    if (!music.open) { return; }
    music.open = false;
    document.documentElement.classList.remove('is-music-open');
    /* Solo se esconde: si suena, sigue sonando con la barra de abajo. */
    window.desktop.music.close();
    if (music.waiting) { music.waiting.querySelector('.music-waiting-text').textContent = 'Pulsa aquí para volver a abrir YouMusic'; }
    renderMusicBar();
  }
  /* Cambio de sección: YouMusic se abre al entrar en su pestaña y se cierra al salir. */
  function musicOnTab(def) {
    if (!musicSupported()) { return; }
    if (def && def.needs === 'music') { if (state.screen === 'home') { openMusic(); } }
    else { closeMusic(); }
  }

  /* ============================================================= MIS LISTAS
     Listas M3U que añade el usuario (una dirección, un archivo del PC o los
     archivos de una carpeta que se sincroniza).  La app no trae ninguna: solo
     las reproduce.  Se ven por categoría, con buscador, favoritos, canales sin
     señal marcados y guía de programación ("Ahora / Después") si la lista la
     tiene.  Se abren en el mismo reproductor de la TV en vivo: mientras se ve
     un canal de una lista, el panel "Canales" y el cambio de canal recorren
     esa lista; al salir del reproductor vuelve la TV de siempre. */
  var ML_ICONS = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 13l2.5 2.5L16 11"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 4 12 2.5-6H21"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.8z" fill="currentColor"/></svg>',
    starLine: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
    restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    tab: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="13" rx="2"/><path d="M7 9.5h6M7 13h4"/><path d="M15.5 11.5l3 1.75-3 1.75z" fill="currentColor"/><path d="M9 21h6"/></svg>'
  };
  var ML_PAGE_SIZE = 120;
  var ML_GROUPS_SHOWN = 24;
  var ML_VIEW_KEY = 'xuper_mylists_view_v1';
  var ml = {
    page: null, lists: [], favs: {}, settings: { autoUpdate: true, syncFolder: '' }, listId: '', group: '', query: '',
    channels: [], groups: [], loading: false, error: '', shown: ML_PAGE_SIZE, seq: 0, allGroups: false, hideDown: false,
    session: null, dialogOpen: false, removeArmed: '', removeTimer: null, playingKey: '', pollTimer: null, guideTimer: null,
    syncing: false
  };

  function mlFold(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }
  function mlErrText(err, fallback) {
    if (!err) { return fallback || 'Algo salió mal'; }
    if (typeof err === 'string') { return err; }
    return err.errorText || err.message || fallback || 'Algo salió mal';
  }
  function mlButton(cls, icon, label, run) {
    var b = el('div', 'ml-btn focusable ' + (cls || ''));
    b.setAttribute('role', 'button');
    b.innerHTML = icon || '';
    b.appendChild(el('span', null, label));
    b._activate = run;
    return b;
  }
  function mlCurrentList() {
    for (var i = 0; i < ml.lists.length; i++) { if (ml.lists[i].id === ml.listId) { return ml.lists[i]; } }
    return null;
  }
  function mlClock(ms) {
    var d = new Date(ms);
    return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  }
  function mlAgo(ms) {
    if (!ms) { return ''; }
    var min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) { return 'hace un momento'; }
    if (min < 60) { return 'hace ' + min + ' min'; }
    var h = Math.round(min / 60);
    if (h < 24) { return 'hace ' + h + (h === 1 ? ' hora' : ' horas'); }
    var d = Math.round(h / 24);
    return 'hace ' + d + (d === 1 ? ' día' : ' días');
  }

  function buildMyListsPage(page) {
    ml.page = page;
    /* La página puede volver a construirse (Inicio se rehace): nada de la anterior. */
    ml.toastEl = null;
    ml.dialogOpen = false;
    page.classList.add('mylists-page');
    var wrap = el('div', 'ml-wrap');
    abs(wrap, 192, BENTO.bigY, 1664);
    wrap.style.height = 'auto';

    /* Título y etiquetas que dicen qué formatos acepta la página. */
    var head = mlHeader('Mis listas IPTV', ML_ICONS.tab, ['M3U', 'M3U8', 'JSON', 'Xtream']);
    ml.subEl = head._sub;
    ml.headActions = head._actions;
    wrap.appendChild(head);

    var m3uBox = el('div', 'ml-m3u');
    ml.m3uBox = m3uBox;

    ml.listsEl = el('div', 'ml-lists');
    m3uBox.appendChild(ml.listsEl);

    ml.toolsEl = el('div', 'ml-tools');
    var searchBox = el('label', 'ml-search focusable');
    searchBox.innerHTML = ML_ICONS.search;
    ml.searchInput = el('input');
    ml.searchInput.type = 'search';
    ml.searchInput.placeholder = 'Buscar canal o programa…';
    ml.searchInput.setAttribute('aria-label', 'Buscar canal');
    ml.searchInput.value = ml.query;   /* la página puede rehacerse con una búsqueda en curso */
    searchBox.appendChild(ml.searchInput);
    searchBox._activate = function () { ml.searchInput.focus(); };
    var searchTimer = null;
    ml.searchInput.addEventListener('input', function () {
      if (searchTimer) { clearTimeout(searchTimer); }
      searchTimer = setTimeout(function () {
        ml.query = ml.searchInput.value;
        ml.shown = ML_PAGE_SIZE;
        mlRenderGrid();
      }, 160);
    });
    ml.searchInput.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (ml.searchInput.value) { ml.searchInput.value = ''; ml.query = ''; ml.shown = ML_PAGE_SIZE; mlRenderGrid(); }
        else { ml.searchInput.blur(); setFocus(searchBox); }
        event.preventDefault();
      }
    });
    ml.toolsEl.appendChild(searchBox);
    ml.listActions = el('div', 'ml-list-actions');
    ml.toolsEl.appendChild(ml.listActions);
    m3uBox.appendChild(ml.toolsEl);
    ml.infoEl = el('div', 'ml-list-info');
    m3uBox.appendChild(ml.infoEl);

    ml.groupsEl = el('div', 'ml-groups');
    m3uBox.appendChild(ml.groupsEl);
    ml.stateEl = el('div', 'ml-state');
    m3uBox.appendChild(ml.stateEl);
    ml.gridEl = el('div', 'ml-grid');
    m3uBox.appendChild(ml.gridEl);
    ml.moreEl = el('div', 'ml-more');
    m3uBox.appendChild(ml.moreEl);
    wrap.appendChild(m3uBox);
    page.appendChild(wrap);

    mlBuildDialog(page);
    var view = safeLocalRead(ML_VIEW_KEY, null);
    if (view) { ml.listId = String(view.listId || ''); ml.group = String(view.group || ''); ml.hideDown = !!view.hideDown; }
    mlLoadIndex();
    if (!ml.guideTimer) { ml.guideTimer = setInterval(mlRefreshGuide, 60000); }
  }

  function mlSaveView() { safeLocalWrite(ML_VIEW_KEY, { listId: ml.listId, group: ml.group, hideDown: ml.hideDown }); }

  /* Cabecera compacta de "Mis listas" y "Videoteca": icono, título y
     subtítulo a la izquierda; botones a la derecha. */
  function mlHeader(title, icon, tags) {
    var head = el('div', 'ml-head');
    var badge = el('div', 'ml-head-icon');
    badge.innerHTML = icon;
    head.appendChild(badge);
    var text = el('div', 'ml-head-text');
    var titleRow = el('div', 'ml-title-row');
    titleRow.appendChild(el('div', 'ml-title', title));
    /* tags (opcional): etiquetas pequeñas junto al título (p. ej. los formatos). */
    (tags || []).forEach(function (t) { titleRow.appendChild(el('span', 'ml-format', t)); });
    text.appendChild(titleRow);
    head._sub = el('div', 'ml-sub', '');
    text.appendChild(head._sub);
    head.appendChild(text);
    head._actions = el('div', 'ml-head-actions');
    head.appendChild(head._actions);
    return head;
  }
  function mlPageVisible() {
    return !!(ml.page && ml.page.classList.contains('is-current') && state.screen === 'home');
  }

  function mlRenderHeadActions() {
    if (!ml.headActions) { return; }
    /* Al reconstruir la cabecera, cierra sin más un menú de carpeta abierto
       (su pastilla se va a reemplazar): evita un menú huérfano. */
    if (ml._folderMenuEl) {
      if (ml._folderMenuEl.parentNode) { ml._folderMenuEl.parentNode.removeChild(ml._folderMenuEl); }
      ml._folderMenuEl = null;
      if (ml._folderOutside) { document.removeEventListener('pointerdown', ml._folderOutside, true); ml._folderOutside = null; }
    }
    clear(ml.headActions);
    if (window.desktop && window.desktop.myListsSync) {
      ml.headActions.appendChild(mlFolderControl());
    }
    var auto = mlButton('is-ghost is-toggle' + (ml.settings.autoUpdate ? ' is-on' : ''), ML_ICONS.clock,
      'Actualizar solas: ' + (ml.settings.autoUpdate ? 'sí' : 'no'), mlToggleAutoUpdate);
    auto.title = 'Las listas por dirección se actualizan una vez al día y las guías cada 12 horas';
    ml.headActions.appendChild(auto);
    var addBtn = mlButton('is-primary', ML_ICONS.plus, 'Añadir lista', function () { mlOpenDialog('add'); });
    addBtn.title = 'Pega un enlace .m3u, .m3u8 o .json, o entra con usuario y contraseña Xtream';
    ml.headActions.appendChild(addBtn);
  }

  function mlToggleAutoUpdate() {
    var on = !ml.settings.autoUpdate;
    ml.settings.autoUpdate = on;
    mlRenderHeadActions();
    portalServiceCall('myListsSettings', { autoUpdate: on }, function (err, payload) {
      if (!err && payload && payload.settings) { ml.settings = payload.settings; }
      mlRenderHeadActions();
      mlToast(on ? 'Las listas se actualizarán solas cada día' : 'Las listas ya no se actualizan solas');
      if (on) { mlSchedulePoll(1500); }
    });
  }

  /* Control "Carpeta": una sola pastilla con un menú ordenado (sincronizar,
     cambiar, volver a la de siempre), en vez de tres botones sueltos. El menú
     se ancla a la página (como el diálogo) para que la cabecera no lo recorte. */
  function mlFolderControl() {
    var wrap = el('div', 'ml-folder');
    var hasFolder = !!ml.settings.syncFolder;
    var pillLabel = ml.syncing ? 'Sincronizando…' : (hasFolder ? 'Carpeta: ' + ml.settings.syncFolder : 'Carpeta de listas');
    var pill = mlButton('ml-folder-pill' + (ml.syncing ? ' is-busy' : ''), ML_ICONS.folder, pillLabel, mlFolderToggle);
    pill.appendChild(el('span', 'ml-folder-caret', '▾'));
    pill.title = hasFolder ? 'Carpeta de tu PC de donde se importan las listas (.m3u, .m3u8, .json)'
      : 'Elige una carpeta de tu PC con tus listas';
    ml._folderPill = pill;
    wrap.appendChild(pill);
    return wrap;
  }
  function mlFolderToggle() { if (ml._folderMenuEl) { mlFolderClose(); } else { mlFolderOpen(); } }
  function mlFolderOpen() {
    if (!ml._folderPill || !ml.page || ml._folderMenuEl) { return; }
    var menu = el('div', 'ml-folder-menu');
    ml._folderMenuEl = menu;
    ml.page.appendChild(menu);
    ml._folderPill.classList.add('is-open');
    mlFolderFillMenu();
    var pr = ml._folderPill.getBoundingClientRect();
    var gr = ml.page.getBoundingClientRect();
    var left = pr.right - gr.left + ml.page.scrollLeft - (menu.offsetWidth || 272);
    menu.style.left = Math.max(12, left) + 'px';
    menu.style.top = (pr.bottom - gr.top + ml.page.scrollTop + 8) + 'px';
    var first = menu.querySelector('.focusable');
    if (first) { setFocus(first); }
    ml._folderOutside = function (ev) {
      if (!closest(ev.target, '.ml-folder-menu') && !closest(ev.target, '.ml-folder-pill')) { mlFolderClose(); }
    };
    setTimeout(function () { document.addEventListener('pointerdown', ml._folderOutside, true); }, 0);
  }
  /* Rellena (o vuelve a rellenar, tras quitar una) el contenido del menú. */
  function mlFolderFillMenu() {
    var menu = ml._folderMenuEl;
    if (!menu) { return; }
    clear(menu);
    var hasFolder = !!ml.settings.syncFolder;
    var folders = ml.settings.folders || [];
    if (folders.length) {
      menu.appendChild(el('div', 'ml-menu-head', 'Tus carpetas'));
      folders.forEach(function (f) {
        var row = el('div', 'ml-folder-row');
        var pick = el('div', 'ml-menu-item ml-folder-pick focusable' + (f.current ? ' is-current' : ''));
        pick.innerHTML = '<span class="ml-folder-dot">' + (f.current ? '●' : '○') + '</span>';
        var nm = el('span', 'ml-folder-name', f.name);
        pick.appendChild(nm);
        if (f.isDefault) { pick.appendChild(el('span', 'ml-folder-badge', 'por defecto')); }
        pick._activate = function () { mlFolderClose(); mlUseFolder(f.index); };
        pick.title = f.current ? 'Carpeta actual' : 'Cambiar a esta carpeta y sincronizarla';
        row.appendChild(pick);
        if (!f.isDefault) {
          var del = el('div', 'ml-folder-del focusable');
          del.innerHTML = ML_ICONS.trash;
          del.title = 'Quitar de la lista (no borra archivos)';
          del._activate = function () { mlRemoveFolder(f.index); };
          row.appendChild(del);
        }
        menu.appendChild(row);
      });
      menu.appendChild(el('div', 'ml-menu-sep'));
    }
    var mk = function (icon, label, run) {
      var it = el('div', 'ml-menu-item focusable');
      it.innerHTML = icon || '';
      it.appendChild(el('span', null, label));
      it._activate = function () { mlFolderClose(); run(); };
      menu.appendChild(it);
    };
    if (hasFolder) { mk(ML_ICONS.refresh, 'Sincronizar ahora', function () { mlSyncFolder(false); }); }
    mk(ML_ICONS.folder, hasFolder ? 'Añadir otra carpeta…' : 'Elegir carpeta…', function () { mlSyncFolder(true); });
    if (ml.settings.defaultFolder && !ml.settings.atDefault) {
      mk(ML_ICONS.restart, 'Volver a la carpeta por defecto', mlRestoreDefaultFolder);
    }
  }
  function mlUseFolder(index) {
    portalServiceCall('myListsSettings', { useFolder: index }, function (err, payload) {
      if (err || !payload || payload.returnValue === false || !payload.settings) {
        mlToast(mlErrText(err || (payload && payload.errorText), 'No se pudo cambiar de carpeta'));
        return;
      }
      ml.settings = payload.settings;
      mlRenderHeadActions();
      mlSyncFolder(false);
    });
  }
  function mlRemoveFolder(index) {
    portalServiceCall('myListsSettings', { removeFolder: index }, function (err, payload) {
      if (err || !payload || payload.returnValue === false || !payload.settings) {
        mlToast(mlErrText(err || (payload && payload.errorText), 'No se pudo quitar la carpeta'));
        return;
      }
      ml.settings = payload.settings;
      if (ml._folderMenuEl) {
        mlFolderFillMenu();
        var first = ml._folderMenuEl.querySelector('.focusable');
        if (first) { setFocus(first); }
      } else { mlRenderHeadActions(); }
    });
  }
  function mlFolderClose() {
    if (ml._folderMenuEl) {
      if (ml._folderMenuEl.parentNode) { ml._folderMenuEl.parentNode.removeChild(ml._folderMenuEl); }
      ml._folderMenuEl = null;
    }
    if (ml._folderOutside) { document.removeEventListener('pointerdown', ml._folderOutside, true); ml._folderOutside = null; }
    if (ml._folderPill) { ml._folderPill.classList.remove('is-open'); if (ml._folderPill.isConnected) { setFocus(ml._folderPill); } }
  }

  /* Restaura la carpeta por defecto recordada y la sincroniza. */
  function mlRestoreDefaultFolder() {
    if (ml.syncing) { return; }
    portalServiceCall('myListsSettings', { restoreDefault: true }, function (err, payload) {
      if (err || !payload || payload.returnValue === false || !payload.settings) {
        mlToast(mlErrText(err || (payload && payload.errorText), 'No se pudo volver a la carpeta por defecto'));
        return;
      }
      ml.settings = payload.settings;
      mlRenderHeadActions();
      mlSyncFolder(false);   // vuelve a leer la carpeta de siempre
    });
  }

  function mlSyncFolder(choose) {
    if (!window.desktop || !window.desktop.myListsSync || ml.syncing) { return; }
    ml.syncing = true;
    mlRenderHeadActions();
    window.desktop.myListsSync(!!choose).then(function (payload) {
      ml.syncing = false;
      if (!payload || payload.canceled) { mlRenderHeadActions(); return; }
      if (payload.returnValue === false) {
        mlRenderHeadActions();
        mlToast(payload.errorText || 'No se pudo sincronizar la carpeta');
        return;
      }
      var parts = [];
      if (payload.added) { parts.push(payload.added + (payload.added === 1 ? ' lista nueva' : ' listas nuevas')); }
      if (payload.updated) { parts.push(payload.updated + (payload.updated === 1 ? ' actualizada' : ' actualizadas')); }
      if (payload.errors && payload.errors.length) { parts.push(payload.errors.length + ' con error'); }
      mlToast('Carpeta "' + payload.folder + '" sincronizada: ' + (parts.join(', ') || 'sin cambios'));
      var first = payload.lists && payload.lists[0];
      mlLoadIndex(first && !mlCurrentList() ? first.id : (first && payload.added ? first.id : undefined));
    }, function () {
      ml.syncing = false;
      mlRenderHeadActions();
      mlToast('No se pudo sincronizar la carpeta');
    });
  }

  function mlLoadIndex(selectId, keepChannels) {
    if (ml.subEl && !ml.lists.length) { ml.subEl.textContent = 'Cargando tus listas…'; }
    portalServiceCall('myListsIndex', {}, function (err, payload) {
      if (err || !payload || payload.returnValue === false) {
        ml.lists = [];
        ml.error = 'No se pudieron leer tus listas guardadas: ' + mlErrText(err || (payload && payload.errorText));
        mlRender();
        return;
      }
      ml.lists = payload.lists || [];
      if (payload.settings) { ml.settings = payload.settings; }
      ml.favs = {};
      (payload.favorites || []).forEach(function (k) { ml.favs[k] = true; });
      if (selectId) { ml.listId = selectId; ml.group = ''; ml.query = ''; if (ml.searchInput) { ml.searchInput.value = ''; } }
      var valid = ml.listId === 'fav' ? Object.keys(ml.favs).length > 0 : !!mlCurrentList();
      if (!valid) { ml.listId = ml.lists.length ? ml.lists[0].id : ''; ml.group = ''; keepChannels = false; }
      mlSaveView();
      if (keepChannels) { mlRenderHeadActions(); mlRenderSub(); mlRenderLists(); mlRenderListActions(); }
      else { mlLoadChannels(); }
      mlSchedulePoll();
    });
  }

  /* Mientras una lista se actualiza o descarga su guía (también las tareas
     automáticas), se mira cada pocos segundos; al terminar se recarga. */
  function mlBusyLists() {
    return ml.lists.filter(function (l) { return l.refreshing || l.epgLoading || l.checking; });
  }
  function mlSchedulePoll(delay) {
    if (ml.pollTimer) { clearTimeout(ml.pollTimer); ml.pollTimer = null; }
    if (!mlBusyLists().length && !delay) { return; }
    ml.pollTimer = setTimeout(function () {
      ml.pollTimer = null;
      var before = {};
      mlBusyLists().forEach(function (l) { before[l.id] = true; });
      var cur = mlCurrentList();
      var curStamp = cur ? [cur.updatedAt, cur.epgAt, cur.checkedAt].join('|') : '';
      portalServiceCall('myListsIndex', {}, function (err, payload) {
        if (err || !payload || !payload.lists) { return mlSchedulePoll(5000); }
        ml.lists = payload.lists;
        if (payload.settings) { ml.settings = payload.settings; }
        var now = mlCurrentList();
        var changed = now && cur && [now.updatedAt, now.epgAt, now.checkedAt].join('|') !== curStamp;
        if (changed && !now.checking) { mlLoadChannels(true); }
        else { mlRenderSub(); mlRenderLists(); mlRenderListActions(); }
        mlSchedulePoll();
      });
    }, delay || 3000);
  }

  function mlLoadChannels(quiet) {
    var seq = ++ml.seq;
    ml.error = '';
    if (!quiet) { ml.channels = []; ml.groups = []; ml.shown = ML_PAGE_SIZE; }
    if (!ml.listId) { ml.loading = false; mlRender(); return; }
    ml.loading = !quiet;
    if (!quiet) { mlRender(); }
    portalServiceCall('myListsChannels', { id: ml.listId }, function (err, payload) {
      if (seq !== ml.seq) { return; }
      ml.loading = false;
      if (err || !payload || payload.returnValue === false) {
        ml.error = mlErrText(err || (payload && payload.errorText), 'No se pudo abrir la lista');
        mlRender();
        return;
      }
      if (payload.list) {
        for (var i = 0; i < ml.lists.length; i++) { if (ml.lists[i].id === payload.list.id) { ml.lists[i] = payload.list; } }
      }
      ml.channels = payload.channels || [];
      var counts = {};
      for (var c = 0; c < ml.channels.length; c++) {
        var ch = ml.channels[c];
        ch._f = mlFold(ch.n + ' ' + ch.g + (ch.e && ch.e.t ? ' ' + ch.e.t : ''));
        counts[ch.g] = (counts[ch.g] || 0) + 1;
      }
      ml.groups = Object.keys(counts).map(function (g) { return { name: g, count: counts[g] }; })
        .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name, 'es'); });
      if (ml.group && !counts[ml.group]) { ml.group = ''; }
      mlRender();
    }, 90000);
  }

  function mlRender() {
    if (!ml.page) { return; }
    mlRenderHeadActions();
    mlRenderSub();
    mlRenderLists();
    mlRenderListActions();
    mlRenderGroups();
    mlRenderGrid();
  }

  function mlRenderSub() {
    if (!ml.subEl) { return; }
    var total = 0;
    ml.lists.forEach(function (l) { total += l.count || 0; });
    ml.subEl.textContent = !ml.lists.length ? 'Listas M3U, M3U8, JSON y Xtream · añade la primera para ver sus canales aquí.' :
      'Listas M3U, M3U8, JSON y Xtream · ' + ml.lists.length + (ml.lists.length === 1 ? ' lista' : ' listas') + ' · ' + total.toLocaleString('es') + ' canales';
  }

  function mlRenderLists() {
    clear(ml.listsEl);
    ml.listsEl.style.display = ml.lists.length ? '' : 'none';
    function chip(id, label, count, extraCls, busy) {
      var c = el('div', 'ml-list-chip focusable' + (ml.listId === id ? ' is-selected' : '') + (extraCls ? ' ' + extraCls : '') + (busy ? ' is-busy' : ''));
      c.setAttribute('role', 'button');
      if (extraCls === 'is-fav') { c.innerHTML = ML_ICONS.star; }
      else if (extraCls && extraCls.indexOf('is-file') !== -1) { c.innerHTML = ML_ICONS.file; }
      c.appendChild(el('span', null, label));
      c.appendChild(el('em', null, (count || 0).toLocaleString('es')));
      c._activate = function () {
        if (ml.listId === id) { return; }
        ml.listId = id;
        ml.group = '';
        ml.query = '';
        if (ml.searchInput) { ml.searchInput.value = ''; }
        mlSaveView();
        mlLoadChannels();
        var again = ml.listsEl.querySelector('.ml-list-chip.is-selected');
        if (again) { setFocus(again, true); }
      };
      ml.listsEl.appendChild(c);
    }
    var favCount = Object.keys(ml.favs).length;
    if (favCount) { chip('fav', 'Favoritos', favCount, 'is-fav'); }
    ml.lists.forEach(function (l) {
      chip(l.id, l.name, l.count, (l.source === 'file' ? 'is-file' : '') + (l.error ? ' has-error' : ''), l.refreshing || l.epgLoading);
    });
  }

  function mlRenderListActions() {
    clear(ml.listActions);
    clear(ml.infoEl);
    ml.toolsEl.style.display = ml.listId ? '' : 'none';
    var list = mlCurrentList();
    ml.infoEl.style.display = list ? '' : 'none';
    if (!list) { return; }
    var isFile = list.source === 'file';
    var parts = [];
    parts.push(isFile ? 'Archivo ' + list.file : 'Enlace');
    if (list.refreshing) { parts.push(isFile ? 'sincronizando…' : 'actualizando…'); }
    else if (list.updatedAt) { parts.push((isFile ? 'sincronizada ' : 'actualizada ') + mlAgo(list.updatedAt)); }
    if (list.epgLoading) { parts.push('cargando la guía…'); }
    else if (list.epg && list.epgMatched) { parts.push('guía: ' + list.epgMatched.toLocaleString('es') + ' canales (' + mlAgo(list.epgAt) + ')'); }
    else if (list.epg && list.epgError) { parts.push('guía: ' + list.epgError); }
    if (list.checking) { parts.push('comprobando ' + list.checking.done + '/' + list.checking.total + '…'); }
    else if (list.checkedAt) { parts.push(list.down ? list.down.toLocaleString('es') + ' sin señal (' + mlAgo(list.checkedAt) + ')' : 'todos con señal (' + mlAgo(list.checkedAt) + ')'); }
    ml.infoEl.textContent = parts.join(' · ');
    if (list.source === 'url' && list.url) { ml.infoEl.title = list.url; }
    if (list.error) { ml.infoEl.appendChild(el('div', 'ml-list-warn', 'Última actualización fallida: ' + list.error)); }

    var upd = mlButton(list.refreshing ? 'is-busy' : '', ML_ICONS.refresh, list.refreshing ? (isFile ? 'Sincronizando…' : 'Actualizando…') : (isFile ? 'Sincronizar' : 'Actualizar'),
      function () { mlRefreshList(); });
    upd.title = isFile ? 'Volver a leer el archivo de tu PC' : 'Volver a descargar la lista';
    ml.listActions.appendChild(upd);
    if (list.checking) {
      ml.listActions.appendChild(mlButton('is-busy-live', ML_ICONS.stop, 'Comprobando ' + list.checking.done + '/' + list.checking.total + ' · Detener', function () { mlCheckStop(list.id); }));
    } else {
      var chk = mlButton('', ML_ICONS.pulse, 'Comprobar canales', function () { mlCheckStart(list.id); });
      chk.title = 'Prueba cada canal y marca los que no tienen señal';
      ml.listActions.appendChild(chk);
    }
    ml.listActions.appendChild(mlButton('', ML_ICONS.edit, 'Editar', function () { mlOpenDialog('edit'); }));
    var armed = ml.removeArmed === list.id;
    ml.listActions.appendChild(mlButton('is-danger' + (armed ? ' is-armed' : ''), ML_ICONS.trash, armed ? '¿Quitar? Pulsa otra vez' : 'Quitar', function () { mlRemoveList(list); }));
  }

  function mlRefreshList() {
    var list = mlCurrentList();
    if (!list || list.refreshing) { return; }
    var isFile = list.source === 'file';
    list.refreshing = true;
    mlRenderListActions();
    mlRenderLists();
    portalServiceCall('myListsRefresh', { id: list.id }, function (err, payload) {
      if (err || !payload || payload.returnValue === false) {
        mlToast(mlErrText(err || (payload && payload.errorText), isFile ? 'No se pudo sincronizar la lista' : 'No se pudo actualizar la lista'));
        mlLoadIndex(undefined, true);
        return;
      }
      mlToast((isFile ? 'Lista sincronizada: ' : 'Lista actualizada: ') + (payload.list && payload.list.count || 0).toLocaleString('es') + ' canales');
      mlLoadIndex();
    }, 90000);
  }

  /* ---- Comprobar canales ---- */
  var mlCheckTimer = null;
  function mlCheckStart(id) {
    portalServiceCall('myListsCheck', { id: id }, function (err, payload) {
      if (err || !payload || payload.returnValue === false) { mlToast(mlErrText(err || (payload && payload.errorText), 'No se pudo comprobar la lista')); return; }
      mlToast('Comprobando los canales… puedes seguir usando la app');
      mlCheckProgress(id, payload);
      mlCheckWatch(id);
    });
  }
  function mlCheckProgress(id, st) {
    for (var i = 0; i < ml.lists.length; i++) {
      if (ml.lists[i].id === id) {
        ml.lists[i].checking = st.running ? { done: st.done, total: st.total, down: st.down } : null;
        if (!st.running) { ml.lists[i].down = st.down; ml.lists[i].checkedAt = st.checkedAt; }
      }
    }
    if (ml.listId === id) { mlRenderListActions(); }
  }
  function mlCheckWatch(id) {
    if (mlCheckTimer) { clearTimeout(mlCheckTimer); }
    mlCheckTimer = setTimeout(function () {
      mlCheckTimer = null;
      portalServiceCall('myListsCheckStatus', { id: id }, function (err, st) {
        if (err || !st) { return mlCheckWatch(id); }
        mlCheckProgress(id, st);
        if (st.running) { return mlCheckWatch(id); }
        if (st.checkedAt) {
          mlToast(st.down ? 'Comprobación terminada: ' + st.down.toLocaleString('es') + ' canales sin señal' : 'Comprobación terminada: todos los canales responden');
        }
        if (ml.listId === id) { mlLoadChannels(true); }
      });
    }, 1500);
  }
  function mlCheckStop(id) {
    portalServiceCall('myListsCheckStop', { id: id }, function (err, st) {
      if (st) { mlCheckProgress(id, st); }
      mlToast('Comprobación detenida');
    });
  }

  function mlRemoveList(list) {
    if (ml.removeArmed !== list.id) {
      ml.removeArmed = list.id;
      if (ml.removeTimer) { clearTimeout(ml.removeTimer); }
      ml.removeTimer = setTimeout(function () { ml.removeArmed = ''; mlRenderListActions(); }, 4000);
      mlRenderListActions();
      var armedBtn = ml.listActions.querySelector('.is-armed');
      if (armedBtn) { setFocus(armedBtn, true); }
      return;
    }
    ml.removeArmed = '';
    if (ml.removeTimer) { clearTimeout(ml.removeTimer); ml.removeTimer = null; }
    portalServiceCall('myListsRemove', { id: list.id }, function () {
      mlToast('Lista "' + list.name + '" quitada');
      ml.listId = '';
      mlLoadIndex();
    });
  }

  function mlDownCount() {
    var n = 0;
    for (var i = 0; i < ml.channels.length; i++) { if (ml.channels[i].d) { n++; } }
    return n;
  }

  function mlRenderGroups() {
    clear(ml.groupsEl);
    if (!ml.listId || ml.loading || ml.error || (ml.groups.length < 2 && !mlDownCount())) { ml.groupsEl.style.display = 'none'; return; }
    ml.groupsEl.style.display = '';
    function chip(name, label, count) {
      var c = el('div', 'ml-group focusable' + (ml.group === name ? ' is-selected' : ''));
      c.setAttribute('role', 'button');
      c.appendChild(el('span', null, label));
      c.appendChild(el('em', null, count.toLocaleString('es')));
      c._activate = function () {
        if (ml.group === name) { return; }
        ml.group = name;
        ml.shown = ML_PAGE_SIZE;
        mlSaveView();
        mlRenderGroups();
        mlRenderGrid();
        var again = ml.groupsEl.querySelector('.ml-group.is-selected');
        if (again) { setFocus(again, true); }
      };
      ml.groupsEl.appendChild(c);
    }
    var down = mlDownCount();
    if (down) {
      var hide = el('div', 'ml-group is-filter focusable' + (ml.hideDown ? ' is-on' : ''));
      hide.setAttribute('role', 'button');
      hide.appendChild(el('span', null, ml.hideDown ? 'Mostrando solo con señal' : 'Ocultar sin señal'));
      hide.appendChild(el('em', null, down.toLocaleString('es')));
      hide._activate = function () {
        ml.hideDown = !ml.hideDown;
        ml.shown = ML_PAGE_SIZE;
        mlSaveView();
        mlRenderGroups();
        mlRenderGrid();
        var again = ml.groupsEl.querySelector('.is-filter');
        if (again) { setFocus(again, true); }
      };
      ml.groupsEl.appendChild(hide);
    }
    if (ml.groups.length < 2) { return; }
    chip('', 'Todas', ml.channels.length);
    var limit = ml.allGroups ? ml.groups.length : ML_GROUPS_SHOWN;
    for (var i = 0; i < ml.groups.length && i < limit; i++) { chip(ml.groups[i].name, ml.groups[i].name, ml.groups[i].count); }
    /* La categoría elegida sigue visible aunque esté entre las "ocultas". */
    if (!ml.allGroups && ml.group) {
      var idx = -1;
      for (var g = 0; g < ml.groups.length; g++) { if (ml.groups[g].name === ml.group) { idx = g; } }
      if (idx >= limit) { chip(ml.groups[idx].name, ml.groups[idx].name, ml.groups[idx].count); }
    }
    if (ml.groups.length > ML_GROUPS_SHOWN) {
      var more = el('div', 'ml-group is-toggle focusable', ml.allGroups ? 'Ver menos' : 'Ver todas (' + ml.groups.length + ')');
      more.setAttribute('role', 'button');
      more._activate = function () { ml.allGroups = !ml.allGroups; mlRenderGroups(); var t = ml.groupsEl.querySelector('.is-toggle'); if (t) { setFocus(t, true); } };
      ml.groupsEl.appendChild(more);
    }
  }

  function mlVisible() {
    var q = mlFold(ml.query).trim();
    var words = q ? q.split(/\s+/) : [];
    return ml.channels.filter(function (c) {
      if (ml.group && c.g !== ml.group) { return false; }
      if (ml.hideDown && c.d) { return false; }
      for (var i = 0; i < words.length; i++) { if (c._f.indexOf(words[i]) === -1) { return false; } }
      return true;
    });
  }

  function mlRenderGrid() {
    clear(ml.gridEl);
    clear(ml.moreEl);
    clear(ml.stateEl);
    if (!ml.lists.length && !ml.loading) { mlRenderEmpty(); return; }
    if (ml.loading) {
      ml.stateEl.textContent = 'Abriendo la lista…';
      for (var s = 0; s < 12; s++) {
        var sk = el('div', 'ml-card is-skeleton');
        sk.appendChild(el('div', 'ml-art'));
        sk.appendChild(el('div', 'ml-name'));
        sk.appendChild(el('div', 'ml-meta'));
        ml.gridEl.appendChild(sk);
      }
      return;
    }
    if (ml.error) {
      ml.stateEl.textContent = ml.error;
      var retry = el('div', 'ml-retry focusable', 'Reintentar');
      retry._activate = function () { mlLoadChannels(); };
      ml.stateEl.appendChild(retry);
      return;
    }
    var list = mlVisible();
    ml.visible = list;
    if (!list.length) {
      ml.stateEl.textContent = ml.query ? 'Ningún canal coincide con "' + ml.query.trim() + '".' :
        (ml.listId === 'fav' ? 'Aún no tienes canales favoritos. Pulsa ☆ en un canal para guardarlo aquí.' : 'Esta lista no tiene canales en esta categoría.');
      return;
    }
    var shown = Math.min(list.length, ml.shown);
    if (ml.query || ml.group || ml.hideDown) {
      ml.stateEl.textContent = list.length.toLocaleString('es') + (list.length === 1 ? ' canal' : ' canales');
    }
    for (var i = 0; i < shown; i++) { ml.gridEl.appendChild(mlCard(list, i)); }
    if (list.length > shown) {
      var more = el('div', 'ml-more-btn focusable', 'Mostrar más (' + (list.length - shown).toLocaleString('es') + ' restantes)');
      more._activate = function () {
        var from = ml.shown;
        ml.shown += ML_PAGE_SIZE * 2;
        mlRenderGrid();
        var next = ml.gridEl.children[from];
        if (next) { setFocus(next, true); }
      };
      ml.moreEl.appendChild(more);
    }
  }

  /* "Ahora: Noticiero · hasta 15:00" o, si no hay guía, la categoría. */
  function mlMetaText(c) {
    if (c.e && c.e.t) { return 'Ahora: ' + c.e.t; }
    if (c.e && c.e.nt) { return 'A las ' + mlClock(c.e.ns) + ': ' + c.e.nt; }
    if (ml.listId === 'fav') { return mlListName(c.list) || c.g; }
    return c.g;
  }
  function mlGuideTitle(c) {
    var t = c.n + (c.g ? ' · ' + c.g : '');
    if (c.e && c.e.t) { t += '\nAhora (' + mlClock(c.e.s) + ' - ' + mlClock(c.e.e) + '): ' + c.e.t; }
    if (c.e && c.e.nt) { t += '\nDespués (' + mlClock(c.e.ns) + '): ' + c.e.nt; }
    if (c.d) { t += '\nSin señal en la última comprobación'; }
    return t;
  }

  function mlCard(list, index) {
    var c = list[index];
    var card = el('div', 'ml-card focusable' + (ml.playingKey === c.k ? ' is-current' : '') + (c.d ? ' is-down' : ''));
    card.style.animationDelay = Math.min(index % ML_PAGE_SIZE, 30) * 18 + 'ms';
    card.title = mlGuideTitle(c);
    var art = el('div', 'ml-art');
    art.style.setProperty('--h', radioHue(c.n));
    art.appendChild(el('span', 'ml-initial', (c.n || '?').replace(/[^0-9A-Za-zÀ-ÿ]/g, '').slice(0, 2).toUpperCase() || '▶'));
    if (c.l) {
      var img = el('img', 'ml-logo');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onload = function () { art.classList.add('has-logo'); };
      img.onerror = function () { if (img.parentNode) { img.parentNode.removeChild(img); } art.classList.remove('has-logo'); };
      img.src = c.l;
      art.appendChild(img);
    }
    if (c.yt) { art.appendChild(el('span', 'ml-badge', 'YouTube')); }
    else if (c.d) { art.appendChild(el('span', 'ml-badge is-down', 'Sin señal')); }
    if (c.e && c.e.t && c.e.e > c.e.s) {
      var bar = el('i', 'ml-progress');
      var fill = el('b');
      fill.style.width = Math.max(2, Math.min(100, Math.round((Date.now() - c.e.s) * 100 / (c.e.e - c.e.s)))) + '%';
      bar.appendChild(fill);
      art.appendChild(bar);
    }
    var fav = el('div', 'ml-fav focusable' + (ml.favs[c.k] ? ' is-on' : ''));
    fav.setAttribute('role', 'button');
    fav.title = ml.favs[c.k] ? 'Quitar de favoritos' : 'Guardar en favoritos';
    fav.innerHTML = ml.favs[c.k] ? ML_ICONS.star : ML_ICONS.starLine;
    fav._activate = function () { mlToggleFav(c, function () { mlSyncFavMarks(); }); };
    art.appendChild(fav);
    card.appendChild(art);
    card.appendChild(el('div', 'ml-name', c.n));
    card.appendChild(el('div', 'ml-meta' + (c.e && c.e.t ? ' is-now' : ''), mlMetaText(c)));
    card._mlKey = c.k;
    card._mlChannel = c;
    card._activate = function () { mlPlay(list, index); };
    return card;
  }

  /* Cada minuto, "Ahora / Después" de las tarjetas visibles (sin rehacer la rejilla). */
  function mlRefreshGuide() {
    if (!mlPageVisible() || !ml.gridEl || ml.loading) { return; }
    var list = mlCurrentList();
    if (ml.listId !== 'fav' && !(list && list.epgMatched)) { return; }
    var cards = ml.gridEl.querySelectorAll('.ml-card');
    var keys = [];
    for (var i = 0; i < cards.length && keys.length < 1500; i++) { if (cards[i]._mlKey) { keys.push(cards[i]._mlKey); } }
    if (!keys.length) { return; }
    portalServiceCall('myListsGuide', { id: ml.listId, keys: keys }, function (err, payload) {
      if (err || !payload || !payload.guide) { return; }
      var guide = payload.guide;
      for (var j = 0; j < cards.length; j++) {
        var c = cards[j]._mlChannel;
        if (!c) { continue; }
        c.e = guide[c.k] || null;
        var meta = cards[j].querySelector('.ml-meta');
        if (meta) { meta.textContent = mlMetaText(c); meta.classList.toggle('is-now', !!(c.e && c.e.t)); }
        cards[j].title = mlGuideTitle(c);
        var fill = cards[j].querySelector('.ml-progress b');
        if (fill && c.e && c.e.e > c.e.s) { fill.style.width = Math.max(2, Math.min(100, Math.round((Date.now() - c.e.s) * 100 / (c.e.e - c.e.s)))) + '%'; }
      }
    });
  }

  function mlListName(id) {
    for (var i = 0; i < ml.lists.length; i++) { if (ml.lists[i].id === id) { return ml.lists[i].name; } }
    return '';
  }

  function mlSyncFavMarks() {
    if (!ml.gridEl) { return; }
    var cards = ml.gridEl.querySelectorAll('.ml-card');
    for (var i = 0; i < cards.length; i++) {
      var star = cards[i].querySelector('.ml-fav');
      var on = !!ml.favs[cards[i]._mlKey];
      if (star) {
        star.classList.toggle('is-on', on);
        star.innerHTML = on ? ML_ICONS.star : ML_ICONS.starLine;
        star.title = on ? 'Quitar de favoritos' : 'Guardar en favoritos';
      }
    }
    mlRenderSub();
    mlRenderLists();
  }

  function mlSyncCurrent() {
    if (!ml.gridEl) { return; }
    var cards = ml.gridEl.querySelectorAll('.ml-card');
    for (var i = 0; i < cards.length; i++) { cards[i].classList.toggle('is-current', !!ml.playingKey && cards[i]._mlKey === ml.playingKey); }
  }

  function mlToggleFav(c, done) {
    var on = !ml.favs[c.k];
    if (on) { ml.favs[c.k] = true; } else { delete ml.favs[c.k]; }
    portalServiceCall('myListsFavorite', { on: on, channel: { k: c.k, n: c.n, g: c.g, u: c.u, l: c.l || '', ua: c.ua || '', ref: c.ref || '', yt: c.yt || 0, list: c.list || ml.listId } },
      function (err, payload) {
        if (err || !payload || payload.returnValue === false) {
          if (on) { delete ml.favs[c.k]; } else { ml.favs[c.k] = true; }
          mlToast('No se pudo guardar el favorito');
        } else if (payload.favorites) {
          ml.favs = {};
          payload.favorites.forEach(function (k) { ml.favs[k] = true; });
        }
        if (done) { done(on); }
      });
    return on;
  }

  function mlRenderEmpty() {
    var box = el('div', 'ml-empty');
    box.appendChild(el('div', 'ml-empty-icon')).innerHTML = ML_ICONS.tab;
    box.appendChild(el('div', 'ml-empty-title', 'Todavía no tienes listas'));
    box.appendChild(el('div', 'ml-empty-text',
      'Añade la dirección de una lista M3U (por ejemplo, la de tu proveedor de IPTV), elige un archivo .m3u de tu PC ' +
      'o sincroniza una carpeta con tus listas. Sus canales aparecerán aquí, ordenados por categoría.'));
    var row = el('div', 'ml-empty-actions');
    row.appendChild(mlButton('is-primary', ML_ICONS.plus, 'Añadir una dirección', function () { mlOpenDialog('add'); }));
    if (window.desktop && window.desktop.myListsAddFile) {
      row.appendChild(mlButton('', ML_ICONS.file, 'Elegir un archivo…', function () { mlAddFile(''); }));
    }
    if (window.desktop && window.desktop.myListsSync) {
      row.appendChild(mlButton('', ML_ICONS.folder, 'Sincronizar una carpeta…', function () { mlSyncFolder(!ml.settings.syncFolder); }));
    }
    box.appendChild(row);
    box.appendChild(el('div', 'ml-empty-note', 'Xuper Desktop no incluye canales: solo reproduce las listas que tú añades.'));
    ml.gridEl.appendChild(box);
  }

  /* ---- Diálogo: añadir una lista, o editarla (nombre y guía) ---- */
  function mlBuildDialog(page) {
    var dlg = el('div', 'ml-dialog');
    var panel = el('div', 'ml-dialog-panel');
    ml.dlgTitle = el('div', 'ml-dialog-title', '');
    panel.appendChild(ml.dlgTitle);
    /* Dos formas de añadir la misma lista: pegar el enlace M3U, o escribir los
       datos de la cuenta Xtream (HOST + usuario + contraseña) por separado. */
    ml.dlgTabs = el('div', 'ml-dialog-tabs');
    ml.dlgTabLink = mlButton('ml-dlg-tab is-active', '', 'Pegar enlace', function () { mlDialogMode('link'); });
    ml.dlgTabXtream = mlButton('ml-dlg-tab', '', 'Usuario y contraseña', function () { mlDialogMode('xtream'); });
    ml.dlgTabs.appendChild(ml.dlgTabLink);
    ml.dlgTabs.appendChild(ml.dlgTabXtream);
    panel.appendChild(ml.dlgTabs);

    ml.dlgUrlRow = el('label', 'ml-field ml-field-url ml-link-only');
    ml.dlgUrlRow.appendChild(el('span', null, 'Dirección de la lista (M3U, M3U8 o JSON)'));
    ml.dlgUrl = el('input');
    ml.dlgUrl.type = 'url';
    ml.dlgUrl.placeholder = 'https://…/lista.m3u, .m3u8 o .json';
    ml.dlgUrl.spellcheck = false;
    ml.dlgUrlRow.appendChild(ml.dlgUrl);
    panel.appendChild(ml.dlgUrlRow);

    /* Casillas de la cuenta Xtream (solo visibles en esa pestaña). */
    ml.dlgHostRow = el('label', 'ml-field ml-xtream-only');
    ml.dlgHostRow.appendChild(el('span', null, 'Servidor (HOST)'));
    ml.dlgHost = el('input');
    ml.dlgHost.type = 'text';
    ml.dlgHost.placeholder = 'http://servidor.com:8080';
    ml.dlgHost.spellcheck = false;
    ml.dlgHostRow.appendChild(ml.dlgHost);
    panel.appendChild(ml.dlgHostRow);
    ml.dlgUserRow = el('label', 'ml-field ml-xtream-only');
    ml.dlgUserRow.appendChild(el('span', null, 'Usuario'));
    ml.dlgUser = el('input');
    ml.dlgUser.type = 'text';
    ml.dlgUser.placeholder = 'Usuario de la cuenta';
    ml.dlgUser.spellcheck = false;
    ml.dlgUser.autocomplete = 'off';
    ml.dlgUserRow.appendChild(ml.dlgUser);
    panel.appendChild(ml.dlgUserRow);
    ml.dlgPassRow = el('label', 'ml-field ml-xtream-only');
    ml.dlgPassRow.appendChild(el('span', null, 'Contraseña'));
    ml.dlgPass = el('input');
    ml.dlgPass.type = 'password';
    ml.dlgPass.placeholder = 'Contraseña de la cuenta';
    ml.dlgPass.spellcheck = false;
    ml.dlgPass.autocomplete = 'off';
    ml.dlgPassRow.appendChild(ml.dlgPass);
    panel.appendChild(ml.dlgPassRow);
    var nameRow = el('label', 'ml-field');
    ml.dlgNameLabel = el('span', null, 'Nombre (opcional)');
    nameRow.appendChild(ml.dlgNameLabel);
    ml.dlgName = el('input');
    ml.dlgName.type = 'text';
    ml.dlgName.maxLength = 60;
    ml.dlgName.placeholder = 'Por ejemplo: Mi IPTV';
    nameRow.appendChild(ml.dlgName);
    panel.appendChild(nameRow);
    ml.dlgEpgRow = el('label', 'ml-field ml-field-epg');
    ml.dlgEpgRow.appendChild(el('span', null, 'Guía de programación (XMLTV, opcional)'));
    ml.dlgEpg = el('input');
    ml.dlgEpg.type = 'url';
    ml.dlgEpg.spellcheck = false;
    ml.dlgEpgRow.appendChild(ml.dlgEpg);
    ml.dlgEpgHint = el('em', 'ml-field-hint', '');
    ml.dlgEpgRow.appendChild(ml.dlgEpgHint);
    panel.appendChild(ml.dlgEpgRow);
    ml.dlgStatus = el('div', 'ml-dialog-status');
    panel.appendChild(ml.dlgStatus);
    var actions = el('div', 'ml-dialog-actions');
    ml.dlgOk = mlButton('is-primary', ML_ICONS.plus, 'Añadir', mlDialogSubmit);
    actions.appendChild(ml.dlgOk);
    if (window.desktop && window.desktop.myListsAddFile) {
      ml.dlgFile = mlButton('ml-dlg-file', ML_ICONS.file, 'Elegir archivo…', function () { mlAddFile(ml.dlgName.value); });
      actions.appendChild(ml.dlgFile);
    }
    actions.appendChild(mlButton('is-ghost', '', 'Cancelar', mlCloseDialog));
    panel.appendChild(actions);
    ml.dlgNote = el('div', 'ml-dialog-note', 'Xuper Desktop no incluye canales: solo reproduce las listas que tú añades.');
    panel.appendChild(ml.dlgNote);
    dlg.appendChild(panel);
    dlg.addEventListener('click', function (event) { if (event.target === dlg && !ml.dlgBusy) { mlCloseDialog(); } });
    [ml.dlgUrl, ml.dlgName, ml.dlgEpg, ml.dlgHost, ml.dlgUser, ml.dlgPass].forEach(function (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); mlDialogSubmit(); }
        else if (event.key === 'Escape') { event.preventDefault(); if (!ml.dlgBusy) { mlCloseDialog(); } }
      });
    });
    page.appendChild(dlg);
    ml.dialog = dlg;
  }

  function mlOpenDialog(mode) {
    if (!ml.dialog) { return; }
    var list = mlCurrentList();
    if (mode === 'edit' && !list) { return; }
    ml.dlgMode = mode;
    ml.dlgBusy = false;
    ml.dialogOpen = true;
    ml.dialog.classList.toggle('is-edit', mode === 'edit');
    ml.dlgTitle.textContent = mode === 'edit' ? 'Editar lista' : 'Añadir una lista M3U';
    ml.dlgNameLabel.textContent = mode === 'edit' ? 'Nombre' : 'Nombre (opcional)';
    ml.dlgUrl.value = '';
    ml.dlgHost.value = ''; ml.dlgUser.value = ''; ml.dlgPass.value = '';
    mlDialogMode('link');   // empieza siempre en "Pegar enlace"
    ml.dlgName.value = mode === 'edit' ? list.name : '';
    ml.dlgEpg.value = mode === 'edit' ? (list.epgCustom || '') : '';
    var auto = mode === 'edit' && !list.epgCustom && list.epgUrl ? list.epgUrl : '';
    ml.dlgEpg.placeholder = auto ? 'La lista ya indica una: ' + auto : 'https://…/guia.xml (o .xml.gz)';
    ml.dlgEpgHint.textContent = auto ? 'Déjalo vacío para usar la guía que indica la propia lista.' :
      'Si la lista no trae guía, puedes escribir aquí la dirección de una guía XMLTV.';
    ml.dlgStatus.textContent = '';
    ml.dlgStatus.className = 'ml-dialog-status';
    var okLabel = ml.dlgOk.querySelector('span');
    if (okLabel) { okLabel.textContent = mode === 'edit' ? 'Guardar' : 'Añadir'; }
    ml.dialog.classList.add('is-open');
    setTimeout(function () { (mode === 'edit' ? ml.dlgName : ml.dlgUrl).focus(); }, 30);
  }

  /* Cambia entre "Pegar enlace" y "Usuario y contraseña" (cuenta Xtream). */
  function mlDialogMode(mode) {
    if (ml.dlgBusy) { return; }
    ml.dlgInputMode = mode === 'xtream' ? 'xtream' : 'link';
    var xtream = ml.dlgInputMode === 'xtream';
    ml.dialog.classList.toggle('is-xtream', xtream);
    if (ml.dlgTabLink) { ml.dlgTabLink.classList.toggle('is-active', !xtream); }
    if (ml.dlgTabXtream) { ml.dlgTabXtream.classList.toggle('is-active', xtream); }
    mlDialogStatus('');
    setTimeout(function () { (xtream ? ml.dlgHost : ml.dlgUrl).focus(); }, 20);
  }

  function mlCloseDialog() {
    if (!ml.dialog) { return; }
    ml.dialogOpen = false;
    ml.dlgBusy = false;
    ml.dialog.classList.remove('is-open');
    try { if (document.activeElement && document.activeElement.blur) { document.activeElement.blur(); } } catch (eBlur) { /* nada */ }
    var first = ml.page && (ml.page.querySelector('.ml-list-chip.is-selected') || ml.page.querySelector('.ml-btn'));
    if (first) { setFocus(first); }
  }

  function mlDialogStatus(text, kind) {
    ml.dlgStatus.textContent = text || '';
    ml.dlgStatus.className = 'ml-dialog-status' + (kind ? ' is-' + kind : '');
  }

  function mlDialogBusy(on, text) {
    ml.dlgBusy = on;
    ml.dialog.classList.toggle('is-busy', on);
    ml.dlgUrl.disabled = on;
    ml.dlgName.disabled = on;
    ml.dlgEpg.disabled = on;
    ml.dlgHost.disabled = on;
    ml.dlgUser.disabled = on;
    ml.dlgPass.disabled = on;
    if (text !== undefined) { mlDialogStatus(text, on ? 'busy' : ''); }
  }

  function mlDialogSubmit() {
    if (ml.dlgBusy) { return; }
    if (ml.dlgMode === 'edit') {
      var list = mlCurrentList();
      var name = ml.dlgName.value.trim();
      var guide = ml.dlgEpg.value.trim();
      if (!list) { return mlCloseDialog(); }
      if (!name) { return mlDialogStatus('Escribe un nombre.', 'error'); }
      if (guide && !/^https?:\/\/\S+$/i.test(guide)) { return mlDialogStatus('La guía debe ser una dirección que empiece por http:// o https://', 'error'); }
      mlDialogBusy(true, 'Guardando…');
      portalServiceCall('myListsRename', { id: list.id, name: name, epg: guide }, function (err, payload) {
        mlDialogBusy(false);
        if (err || !payload || payload.returnValue === false) { return mlDialogStatus(mlErrText(err || (payload && payload.errorText)), 'error'); }
        mlCloseDialog();
        if (guide !== (list.epgCustom || '')) { mlToast(guide ? 'Cargando la guía de programación…' : 'Guía personalizada quitada'); }
        mlLoadIndex(undefined, true);
        mlSchedulePoll(1500);
      });
      return;
    }
    var addParams = { name: ml.dlgName.value.trim() };
    var refocus;
    if (ml.dlgInputMode === 'xtream') {
      var host = ml.dlgHost.value.trim();
      var user = ml.dlgUser.value.trim();
      var pass = ml.dlgPass.value.trim();
      if (!host) { mlDialogStatus('Escribe la dirección del servidor (HOST).', 'error'); ml.dlgHost.focus(); return; }
      if (!user || !pass) { mlDialogStatus('Escribe el usuario y la contraseña.', 'error'); (user ? ml.dlgPass : ml.dlgUser).focus(); return; }
      addParams.host = host; addParams.user = user; addParams.pass = pass;
      refocus = ml.dlgHost;
    } else {
      var url = ml.dlgUrl.value.trim();
      if (!/^https?:\/\/\S+$/i.test(url)) {
        mlDialogStatus('Escribe una dirección que empiece por http:// o https://', 'error');
        ml.dlgUrl.focus();
        return;
      }
      addParams.url = url;
      refocus = ml.dlgUrl;
    }
    mlDialogBusy(true, 'Descargando la lista… (las listas grandes pueden tardar un poco)');
    portalServiceCall('myListsAdd', addParams, function (err, payload) {
      mlDialogBusy(false);
      if (err || !payload || payload.returnValue === false) {
        mlDialogStatus(mlErrText(err || (payload && payload.errorText), 'No se pudo añadir la lista'), 'error');
        if (refocus) { refocus.focus(); }
        return;
      }
      mlCloseDialog();
      mlToast('Lista añadida: ' + (payload.list.count || 0).toLocaleString('es') + ' canales' + (payload.list.epg ? ' · cargando su guía…' : ''));
      mlLoadIndex(payload.list.id);
    }, 90000);
  }

  function mlAddFile(name) {
    if (!window.desktop || !window.desktop.myListsAddFile) { return; }
    if (ml.dialogOpen) { mlDialogBusy(true, 'Elige el archivo en la ventana de Windows…'); }
    window.desktop.myListsAddFile(name || '').then(function (payload) {
      if (ml.dialogOpen) { mlDialogBusy(false, ''); }
      if (!payload || payload.canceled) { return; }
      if (payload.returnValue === false) {
        if (ml.dialogOpen) { mlDialogStatus(payload.errorText || 'No se pudo leer el archivo', 'error'); }
        else { mlToast(payload.errorText || 'No se pudo leer el archivo'); }
        return;
      }
      if (ml.dialogOpen) { mlCloseDialog(); }
      mlToast('Lista lista para ver: ' + (payload.list.count || 0).toLocaleString('es') + ' canales');
      mlLoadIndex(payload.list.id);
    }, function () {
      if (ml.dialogOpen) { mlDialogBusy(false); mlDialogStatus('No se pudo abrir el archivo', 'error'); }
    });
  }

  var mlToastTimer = null;
  /* Aviso breve en la página que se está viendo (Mis listas o Videoteca). */
  function mlToast(text) {
    var host = (vt.page && vt.page.classList.contains('is-current')) ? vt.page : ml.page;
    if (!host) { return; }
    var t = host._mlToast;
    if (!t || t.parentNode !== host) { t = host._mlToast = el('div', 'ml-toast'); host.appendChild(t); }
    t.textContent = text;
    t.classList.add('is-on');
    if (mlToastTimer) { clearTimeout(mlToastTimer); }
    mlToastTimer = setTimeout(function () { t.classList.remove('is-on'); }, 4200);
  }

  /* ---- Reproducción: la lista visible pasa a ser la de canales del reproductor ---- */
  function mlChannelFor(it, i) {
    var e = it.e || null;
    return {
      name: it.n, logo: it.l || '', index: i + 1, channelCode: 'm3u:' + it.k, m3u: it, fav: !!ml.favs[it.k],
      now: e && e.t ? e.t : (it.g || 'En vivo'),
      next: e && e.nt ? (e.ns ? mlClock(e.ns) + ' ' : '') + e.nt : '',
      time: e && e.t ? mlClock(e.s) + ' - ' + mlClock(e.e) : ''
    };
  }

  function mlPlay(list, index) {
    var c = list[index];
    if (!c) { return; }
    if (c.yt) {
      if (window.desktop && window.desktop.openYoutube) {
        window.desktop.openYoutube(c.u);
        mlToast('Abriendo "' + c.n + '" en una ventana de YouTube…');
      } else { mlToast('Los canales de YouTube no se pueden ver aquí.'); }
      return;
    }
    if (!ml.session) {
      ml.session = { channels: CHANNELS.slice(), channel: state.channel, category: currentLiveCategory };
    }
    /* El reproductor recorre los canales de vídeo (los de YouTube se abren aparte). */
    var playable = [], at = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].yt) { continue; }
      if (i === index) { at = playable.length; }
      playable.push(list[i]);
    }
    CHANNELS.splice(0, CHANNELS.length);
    for (var j = 0; j < playable.length; j++) { CHANNELS.push(mlChannelFor(playable[j], j)); }
    state.channel = at;
    ml.playingKey = c.k;
    currentLiveCategory = { id: 'mylists', name: 'Mis listas' };
    openPlayer('live');
    /* El panel "Canales" muestra esta lista, sin las categorías del portal. */
    if (playerChannels) { playerChannels.classList.add('is-mylists'); }
  }

  /* Al salir del reproductor: vuelven los canales de la TV en vivo. */
  function mlEndSession() {
    if (!ml.session) { return false; }
    var s = ml.session;
    ml.session = null;
    var playing = CHANNELS[state.channel];
    if (playing && playing.m3u) { ml.playingKey = playing.m3u.k; }
    CHANNELS.splice(0, CHANNELS.length);
    for (var i = 0; i < s.channels.length; i++) { CHANNELS.push(s.channels[i]); }
    state.channel = Math.max(0, Math.min(CHANNELS.length - 1, s.channel || 0));
    currentLiveCategory = s.category;
    if (playerChannels) { playerChannels.classList.remove('is-mylists'); }
    for (var r = 0; r < liveRows.length; r++) {
      liveRows[r].classList.toggle('is-current', liveRows[r]._channel === state.channel);
      liveRows[r].title = liveRowTitle(liveRows[r]._channel === state.channel);
    }
    if (CHANNELS[state.channel] && liveInfoText) { liveInfoText.textContent = CHANNELS[state.channel].name; }
    syncLiveFavButton();
    mlSyncCurrent();
    return true;
  }

  /* ============================================================== VIDEOTECA
     Cat?logo de la API LaMovie: portada, pel?culas, b?squeda y favoritos.
     Los v?deos se resuelven en el servicio, sin exponer enlaces temporales. */
  var VT_VIEW_KEY = 'xuper_videoteca_view_v1';
  var VT_HERO_MS = 9000;
  var vt = {
    box: null, page: null, kind: 'all', data: null, loaded: false, loading: false, seq: 0, error: '',
    heroIndex: 0, heroTimer: null, favs: {}, sources: { folders: [], localCount: 0 },
    view: 'home', browse: null, query: '', results: null, detail: null, detailOpen: false, foldersOpen: false
  };

  /* Pestaña propia en la barra lateral (debajo de "Mis listas"). */
  function buildVideotecaPage(page) {
    page.classList.add('videoteca-page');
    var wrap = el('div', 'ml-wrap');
    abs(wrap, 192, BENTO.bigY, 1664);
    wrap.style.height = 'auto';
    var head = mlHeader('Videoteca', ML_ICONS.film);
    vt.subEl = head._sub;
    vt.headActions = head._actions;
    wrap.appendChild(head);
    var box = el('div', 'vt-box');
    wrap.appendChild(box);
    page.appendChild(wrap);
    vtBuild(box, page);
    vtRenderHead();
    /* Se construye al entrar en la pestaña: cargar ya. */
    vtEnter();
  }

  function vtRenderHead() {
    if (vt.subEl) { vt.subEl.textContent = vtSubText(); }
    if (vt.headActions) { clear(vt.headActions); vtRenderHeadActions(vt.headActions); }
  }

  function vtBuild(box, page) {
    vt.box = box;
    vt.page = page;
    vt.loaded = false;
    vt.loading = false;
    vt.detailOpen = false;
    vt.foldersOpen = false;
    vt.view = 'home';
    var view = safeLocalRead(VT_VIEW_KEY, null);
    if (view && /^(all|movie|series|fav)$/.test(String(view.kind))) { vt.kind = String(view.kind); }
    else { vt.kind = 'all'; }
    vt.heroEl = el('div', 'vt-hero');
    box.appendChild(vt.heroEl);
    vt.barEl = el('div', 'vt-bar');
    box.appendChild(vt.barEl);
    vt.contentEl = el('div', 'vt-content');
    box.appendChild(vt.contentEl);
    vt.detailEl = el('div', 'vt-detail');
    vt.detailEl.addEventListener('click', function (event) { if (event.target === vt.detailEl) { vtCloseDetail(); } });
    page.appendChild(vt.detailEl);
    vt.foldersEl = el('div', 'vt-detail vt-folders');
    vt.foldersEl.addEventListener('click', function (event) { if (event.target === vt.foldersEl) { vtCloseFolders(); } });
    page.appendChild(vt.foldersEl);
    vtRenderBar();
  }

  function vtEnter() {
    if (!vt.loaded && !vt.loading) { vtLoadHome(); }
    else { vtScheduleHero(); }
  }
  function vtLeave() {
    if (vt.heroTimer) { clearTimeout(vt.heroTimer); vt.heroTimer = null; }
  }
  function vtVisible() {
    return !!(vt.page && vt.page.classList.contains('is-current') && state.screen === 'home');
  }

  function vtSubText() {
    if (vt.loading && !vt.data) { return 'Cargando la videoteca…'; }
    var parts = ['Tu próxima película empieza aquí'];
    if (vt.sources.total) { parts.push(vt.sources.total.toLocaleString('es') + ' películas en el catálogo'); }
    return parts.join(' · ');
  }

  function vtRenderHeadActions(host) {
    host.appendChild(el('span', 'vt-source-badge', 'LaMovie · Películas'));
    host.appendChild(mlButton('', ML_ICONS.restart, 'Actualizar', function () { vt.query = ''; vt.view = 'home'; vtLoadHome(); vtRenderBar(); }));
  }

  /* ---- Barra: Todo / Películas / Series / Favoritos + buscar ---- */
  function vtRenderBar() {
    clear(vt.barEl);
    [['all', 'Descubrir'], ['movie', 'Películas'], ['series', 'Series'], ['fav', 'Favoritos']].forEach(function (k) {
      var chip = el('div', 'vt-chip focusable' + (vt.kind === k[0] && vt.view !== 'search' ? ' is-selected' : ''));
      chip.setAttribute('role', 'button');
      if (k[0] === 'fav') { chip.innerHTML = ML_ICONS.star; }
      chip.appendChild(el('span', null, k[1]));
      chip._activate = function () {
        vt.view = 'home';
        vt.query = '';
        if (vt.searchInput) { vt.searchInput.value = ''; }
        if (vt.kind !== k[0]) {
          vt.kind = k[0];
          safeLocalWrite(VT_VIEW_KEY, { kind: vt.kind });
          vtLoadHome();
        } else { vtRenderContent(); }
        vtRenderBar();
        var again = vt.barEl.querySelector('.vt-chip.is-selected');
        if (again) { setFocus(again, true); }
      };
      vt.barEl.appendChild(chip);
    });
    var box = el('label', 'vt-search focusable');
    box.innerHTML = ML_ICONS.search;
    var input = el('input');
    input.type = 'search';
    input.placeholder = 'Buscar películas o series…';
    input.value = vt.query;
    box.appendChild(input);
    box._activate = function () { input.focus(); };
    var timer = null;
    input.addEventListener('input', function () {
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(function () { vtSearch(input.value.trim()); }, 350);
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (input.value) { input.value = ''; vtSearch(''); } else { input.blur(); setFocus(box); }
      }
    });
    vt.searchInput = input;
    vt.barEl.appendChild(box);
  }

  function vtLoadHome() {
    var seq = ++vt.seq;
    vt.loading = true;
    vt.error = '';
    vtRenderHead();
    vtRenderSkeleton();
    portalServiceCall('videotecaFavorites', {}, function (err, payload) {
      if (!err && payload && payload.favorites) {
        vt.favs = {};
        payload.favorites.forEach(function (id) { vt.favs[id] = true; });
        if (payload.sources) { vt.sources = payload.sources; }
      }
    });
    portalServiceCall('videotecaHome', { kind: vt.kind }, function (err, payload) {
      if (seq !== vt.seq) { return; }
      vt.loading = false;
      vt.loaded = true;
      if (err || !payload || payload.returnValue === false) {
        vt.data = { hero: [], rows: [] };
        vt.error = mlErrText(err || (payload && payload.errorText), 'No se pudo abrir la videoteca');
      } else {
        vt.data = payload;
        vt.error = payload.error || '';
        if (payload.sources) { vt.sources = payload.sources; }
      }
      vt.heroIndex = 0;
      if ((vt.kind === 'movie' || vt.kind === 'series') && vt.view === 'home' && vt.data.rows && vt.data.rows[0]) {
        var catalogRow = vt.data.rows[0];
        vt.view = 'browse';
        vt.browse = { row: vt.kind === 'series' ? 'series' : 'catalog', title: vt.kind === 'series' ? 'Series' : 'Todas las películas', items: catalogRow.items.slice(), page: 1,
          more: !!catalogRow.more, total: vt.sources.total || 0, loading: false };
      }
      vtRenderHead();
      vtRenderHero();
      vtRenderContent();
    }, 60000);
  }

  function vtRenderSkeleton() {
    clear(vt.contentEl);
    vt.heroEl.className = 'vt-hero is-skeleton';
    clear(vt.heroEl);
    for (var r = 0; r < 2; r++) {
      var row = el('section', 'vt-row');
      row.appendChild(el('div', 'vt-row-head is-skeleton'));
      var track = el('div', 'vt-track');
      for (var i = 0; i < 7; i++) {
        var card = el('div', 'vt-poster is-skeleton');
        card.appendChild(el('div', 'vt-art'));
        card.appendChild(el('div', 'vt-name'));
        track.appendChild(card);
      }
      row.appendChild(track);
      vt.contentEl.appendChild(row);
    }
  }

  /* ---- Destacado ---- */
  function vtRenderHero() {
    vtLeave();
    clear(vt.heroEl);
    var list = (vt.data && vt.data.hero) || [];
    vt.heroEl.className = 'vt-hero';
    if (!list.length || vt.view !== 'home') { vt.heroEl.style.display = 'none'; return; }
    vt.heroEl.style.display = '';
    var t = list[vt.heroIndex % list.length];
    var bg = el('div', 'vt-hero-bg');
    if (t.backdrop) { bg.style.backgroundImage = 'url("' + String(t.backdrop).replace(/"/g, '%22') + '")'; }
    vt.heroEl.appendChild(bg);
    var info = el('div', 'vt-hero-info');
    info.appendChild(el('div', 'vt-kicker', 'VIDEOTECA / SELECCIÓN PARA TI'));
    info.appendChild(el('div', 'vt-hero-title', t.title));
    info.appendChild(el('div', 'vt-hero-meta', vtMetaLine(t)));
    if (t.overview) { info.appendChild(el('div', 'vt-hero-text', t.overview)); }
    var actions = el('div', 'vt-hero-actions');
    actions.appendChild(mlButton('is-primary', ML_ICONS.play, vtResumeLabel(t) || 'Reproducir', function () { vtPlay(t); }));
    actions.appendChild(mlButton('', ML_ICONS.info, 'Más información', function () { vtOpenDetail(t); }));
    actions.appendChild(vtFavButton(t, 'ml-btn is-icon'));
    info.appendChild(actions);
    vt.heroEl.appendChild(info);
    if (t.poster) {
      var poster = el('div', 'vt-hero-poster');
      var img = el('img');
      img.alt = '';
      img.src = t.poster;
      img.onerror = function () { poster.style.display = 'none'; };
      poster.appendChild(img);
      poster.addEventListener('click', function () { vtOpenDetail(t); });
      vt.heroEl.appendChild(poster);
    }
    var dots = el('div', 'vt-hero-dots');
    list.forEach(function (x, i) {
      var d = el('i', i === vt.heroIndex % list.length ? 'is-on' : '');
      d.title = x.title;
      d.addEventListener('click', function () { vt.heroIndex = i; vtRenderHero(); });
      dots.appendChild(d);
    });
    vt.heroEl.appendChild(dots);
    vtScheduleHero();
  }
  function vtScheduleHero() {
    if (vt.heroTimer) { clearTimeout(vt.heroTimer); }
    vt.heroTimer = setTimeout(function () {
      vt.heroTimer = null;
      var paused = vt.heroEl.matches(':hover') || (state.focus && vt.heroEl.contains(state.focus)) || vt.detailOpen;
      if (vtVisible() && !paused) { vt.heroIndex++; vtRenderHero(); } else if (vtVisible()) { vtScheduleHero(); }
    }, VT_HERO_MS);
  }

  function vtMetaLine(t) {
    var parts = [];
    if (t.year) { parts.push(String(t.year)); }
    if (t.rating) { parts.push('★ ' + Number(t.rating).toFixed(1)); }
    /* La API declara "Dual 1080p", pero el HLS real entrega hasta 720p
       (comprobado 13/11/2026). No mostramos esa resolución inventada; la
       calidad real se elige en el menú Calidad del reproductor. */
    if (t.runtime) { parts.push(t.runtime >= 60 ? Math.floor(t.runtime / 60) + ' h ' + (t.runtime % 60) + ' min' : t.runtime + ' min'); }
    if (t.type === 'series') { parts.push('Serie'); }
    if (t.genres && t.genres.length) { parts.push(t.genres.join(', ')); }
    if (t.language) { parts.push(t.language); }
    return parts.join(' · ');
  }

  /* ---- Contenido: filas, "ver todo" o resultados de búsqueda ---- */
  function vtRenderContent() {
    clear(vt.contentEl);
    vt.heroEl.style.display = vt.view === 'home' && vt.data && vt.data.hero && vt.data.hero.length ? '' : 'none';
    if (vt.view === 'browse') { return vtRenderBrowse(); }
    if (vt.view === 'search') { return vtRenderResults(); }
    var rows = ((vt.data && vt.data.rows) || []).slice();
    var cont = vtContinueRow();
    if (cont) { rows.unshift(cont); }
    if (vt.error) { vt.contentEl.appendChild(vtMessage(vt.error + (rows.length ? ' Se muestra lo que hay guardado.' : ''), rows.length ? null : vtLoadHome)); }
    if (!rows.length) {
      if (!vt.error) { vt.contentEl.appendChild(vtEmpty()); }
      return;
    }
    rows.forEach(function (row) { vt.contentEl.appendChild(vtRow(row)); });
    vt.contentEl.appendChild(el('div', 'vt-credit', 'Catálogo de LaMovie · La disponibilidad de cada película depende de sus servidores.'));
  }

  function vtMessage(text, retry) {
    var box = el('div', 'vt-message', text);
    if (retry) {
      var b = el('div', 'ml-retry focusable', 'Reintentar');
      b._activate = retry;
      box.appendChild(b);
    }
    return box;
  }

  function vtEmpty() {
    var box = el('div', 'ml-empty vt-empty');
    box.appendChild(el('div', 'ml-empty-icon')).innerHTML = ML_ICONS.film;
    if (vt.kind === 'fav') {
      box.appendChild(el('div', 'ml-empty-title', 'Aún no tienes favoritos'));
      box.appendChild(el('div', 'ml-empty-text', 'Pulsa ☆ en una película o serie para guardarla aquí.'));
      return box;
    }
    box.appendChild(el('div', 'ml-empty-title', 'No hay películas disponibles ahora'));
    box.appendChild(el('div', 'ml-empty-text', 'Actualiza el catálogo para volver a consultar la fuente.'));
    box.appendChild(mlButton('is-primary', ML_ICONS.restart, 'Volver a cargar', vtLoadHome));
    return box;
  }

  function vtRow(row) {
    var box = el('section', 'vt-row');
    var head = el('div', 'vt-row-head');
    head.appendChild(el('h3', null, row.title));
    if (row.more) {
      var all = el('div', 'vt-row-more focusable', 'Ver todo ›');
      all._activate = function () { vtOpenBrowse(row); };
      head.appendChild(all);
    }
    box.appendChild(head);
    var track = el('div', 'vt-track' + (row.wide ? ' is-wide' : ''));
    row.items.forEach(function (t) { track.appendChild(row.wide ? vtWideCard(t) : vtPoster(t)); });
    box.appendChild(track);
    ['prev', 'next'].forEach(function (dir) {
      var arrow = el('div', 'vt-arrow is-' + dir);
      arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="' + (dir === 'prev' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7') + '"/></svg>';
      arrow.addEventListener('click', function () {
        var w = track.firstChild ? track.firstChild.getBoundingClientRect().width + 22 : 260;
        track.scrollBy({ left: (dir === 'prev' ? -1 : 1) * Math.max(w, track.clientWidth - w), behavior: 'smooth' });
      });
      box.appendChild(arrow);
    });
    /* Con teclado: la carátula elegida queda a la vista. */
    track.addEventListener('focusin', function (event) {
      var card = closest(event.target, '.vt-poster');
      if (card && card.scrollIntoView) { card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }
    });
    return box;
  }

  function vtFavButton(t, cls) {
    var b = el('div', (cls || 'vt-fav') + ' focusable' + (vt.favs[t.id] ? ' is-on' : ''));
    b.setAttribute('role', 'button');
    function paint() {
      var on = !!vt.favs[t.id];
      b.classList.toggle('is-on', on);
      b.innerHTML = on ? ML_ICONS.star : ML_ICONS.starLine;
      b.title = on ? 'Quitar de favoritos' : 'Guardar en favoritos';
    }
    paint();
    b._activate = function () {
      var on = !vt.favs[t.id];
      if (on) { vt.favs[t.id] = true; } else { delete vt.favs[t.id]; }
      paint();
      vtSyncFavs();
      portalServiceCall('videotecaFavorite', { on: on, title: { id: t.id, title: t.title, year: t.year, genres: t.genres, overview: t.overview } }, function (err, payload) {
        if (err || !payload || payload.returnValue === false) {
          if (on) { delete vt.favs[t.id]; } else { vt.favs[t.id] = true; }
          paint();
          vtSyncFavs();
          return mlToast('No se pudo guardar el favorito');
        }
        mlToast(on ? '"' + t.title + '" está en tus favoritos' : 'Quitado de favoritos');
      });
    };
    b._vtId = t.id;
    b._vtPaint = paint;
    return b;
  }
  function vtSyncFavs() {
    if (!vt.page) { return; }
    var stars = vt.page.querySelectorAll('.focusable');
    for (var i = 0; i < stars.length; i++) { if (stars[i]._vtPaint) { stars[i]._vtPaint(); } }
  }

  function vtPoster(t) {
    var card = el('div', 'vt-poster focusable');
    card.title = t.title + (t.year ? ' (' + t.year + ')' : '');
    var art = el('div', 'vt-art');
    art.style.setProperty('--h', radioHue(t.title));
    art.appendChild(el('span', 'vt-initial', (t.title || '?').replace(/^(the|el|la|los|las)\s+/i, '').slice(0, 1).toUpperCase()));
    if (t.poster) {
      var img = el('img');
      img.loading = 'lazy';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onload = function () { art.classList.add('has-img'); };
      img.onerror = function () { if (img.parentNode) { img.parentNode.removeChild(img); } };
      img.src = t.poster;
      art.appendChild(img);
    }
    /* Sin insignia "FULL HD": la etiqueta de la API no corresponde a la
       resolución real del vídeo (declara 1080p, entrega hasta 720p). */
    art.appendChild(vtFavButton(t));
    card.appendChild(art);
    card.appendChild(el('div', 'vt-name', t.title));
    card.appendChild(el('div', 'vt-sub', [t.year, t.rating ? '★ ' + Number(t.rating).toFixed(1) : (t.genres || [])[0]].filter(Boolean).join(' · ') || 'LaMovie'));
    card._activate = function () { vtOpenDetail(t); };
    return card;
  }

  /* "Continuar viendo": del historial de la app (ids vt:…). */
  function vtContinueRow() {
    if (vt.kind === 'fav') { return null; }
    var items = (localProfile.history || []).filter(function (h) {
      return String(h.id).indexOf('vt:lamovie:') === 0 && h.position > 30 && h.duration && h.position < h.duration - 90;
    }).slice(0, 20).map(function (h) {
      return { id: h.id, title: h.title, poster: h.poster, type: 'movie', progress: h.position / h.duration,
        left: Math.max(1, Math.round((h.duration - h.position) / 60)), source: 'lamovie', _history: h };
    });
    return items.length ? { id: 'continue', title: 'Continuar viendo', items: items, wide: true } : null;
  }

  function vtWideCard(t) {
    var card = el('div', 'vt-poster is-wide focusable');
    card.title = 'Seguir viendo ' + t.title;
    var art = el('div', 'vt-art');
    art.style.setProperty('--h', radioHue(t.title));
    if (t.poster) {
      var blur = el('div', 'vt-wide-bg');
      blur.style.backgroundImage = 'url("' + String(t.poster).replace(/"/g, '%22') + '")';
      art.appendChild(blur);
      var img = el('img', 'vt-wide-img');
      img.alt = '';
      img.src = t.poster;
      img.onerror = function () { img.style.display = 'none'; };
      art.appendChild(img);
    }
    var play = el('span', 'vt-wide-play');
    play.innerHTML = ML_ICONS.play;
    art.appendChild(play);
    var bar = el('i', 'vt-progress');
    var fill = el('b');
    fill.style.width = Math.max(3, Math.round((t.progress || 0) * 100)) + '%';
    bar.appendChild(fill);
    art.appendChild(bar);
    card.appendChild(art);
    card.appendChild(el('div', 'vt-name', t.title));
    card.appendChild(el('div', 'vt-sub', 'Quedan ' + t.left + ' min'));
    card._activate = function () { vtPlay(t, null, t._history ? t._history.position : undefined); };
    return card;
  }

  /* ---- Ver todo (rejilla por páginas) ---- */
  function vtOpenBrowse(row) {
    vt.view = 'browse';
    vt.browse = { row: row.id, title: row.title, items: [], page: 0, more: true, total: 0, loading: false };
    vtRenderBar();
    vtRenderHero();
    vtRenderContent();
    vtBrowseMore();
    if (vt.page) { vt.page.scrollTop = 0; }
  }
  function vtBrowseMore() {
    var b = vt.browse;
    if (!b || b.loading || !b.more) { return; }
    b.loading = true;
    var from = b.items.length;
    vtRenderBrowse();
    portalServiceCall('videotecaBrowse', { row: b.row, page: b.page + 1 }, function (err, payload) {
      if (vt.browse !== b) { return; }
      b.loading = false;
      if (err || !payload || payload.returnValue === false) {
        b.error = mlErrText(err || (payload && payload.errorText), 'No se pudo cargar');
        return vtRenderBrowse();
      }
      b.page++;
      b.total = payload.total || 0;
      b.more = !!payload.more;
      var seen = {};
      b.items.forEach(function (t) { seen[t.id] = true; });
      (payload.items || []).forEach(function (t) { if (!seen[t.id]) { b.items.push(t); } });
      vtRenderBrowse();
      var next = vt.contentEl.querySelectorAll('.vt-grid .vt-poster')[from];
      if (next && from) { setFocus(next, true); }
    }, 60000);
  }
  function vtRenderBrowse() {
    var b = vt.browse;
    clear(vt.contentEl);
    if (!b) { return; }
    var head = el('div', 'vt-browse-head');
    var back = el('div', 'ml-btn is-ghost is-small focusable', '‹ Volver');
    back._activate = vtBackToHome;
    head.appendChild(back);
    head.appendChild(el('h2', null, b.title));
    if (b.total) { head.appendChild(el('em', null, b.total.toLocaleString('es') + ' títulos')); }
    vt.contentEl.appendChild(head);
    var grid = el('div', 'vt-grid');
    b.items.forEach(function (t) { grid.appendChild(vtPoster(t)); });
    vt.contentEl.appendChild(grid);
    if (b.error) { vt.contentEl.appendChild(vtMessage(b.error, function () { b.error = ''; vtBrowseMore(); })); }
    else if (b.loading) { vt.contentEl.appendChild(el('div', 'vt-message', 'Cargando…')); }
    else if (b.more) {
      var more = el('div', 'ml-more-btn focusable vt-more', 'Mostrar más');
      more._activate = vtBrowseMore;
      vt.contentEl.appendChild(more);
    }
  }
  function vtBackToHome() {
    vt.view = 'home';
    vt.browse = null;
    vtRenderBar();
    vtRenderHero();
    vtRenderContent();
  }

  /* ---- Buscar ---- */
  function vtSearch(q) {
    vt.query = q;
    if (!q) { if (vt.view === 'search') { vtBackToHome(); } return; }
    if (q.length < 2) { vt.seq++; vtBackToHome(); return; }
    vt.view = 'search';
    vt.results = null;
    vt.resultsPage = 0;
    vt.resultsMore = false;
    vt.resultsLoading = false;
    var seq = ++vt.seq;
    vtRenderHero();
    vtRenderResults();
    portalServiceCall('videotecaSearch', { q: q }, function (err, payload) {
      if (seq !== vt.seq || vt.view !== 'search') { return; }
      vt.results = (!err && payload && payload.items) ? payload.items : [];
      vt.resultsPage = 1;
      vt.resultsMore = !!(!err && payload && payload.more);
      vt.resultsError = err ? mlErrText(err) : (payload && payload.error) || '';
      vtRenderResults();
      vtRenderBar();
      if (vt.searchInput && document.activeElement !== vt.searchInput) { vt.searchInput.focus(); }
    }, 30000);
  }
  function vtRenderResults() {
    clear(vt.contentEl);
    vt.heroEl.style.display = 'none';
    var head = el('div', 'vt-browse-head');
    head.appendChild(el('h2', null, 'Resultados para "' + vt.query + '"'));
    if (vt.results) { head.appendChild(el('em', null, vt.results.length + (vt.results.length === 1 ? ' título' : ' títulos'))); }
    vt.contentEl.appendChild(head);
    if (!vt.results) { vt.contentEl.appendChild(el('div', 'vt-message', 'Buscando…')); return; }
    if (!vt.results.length) {
      vt.contentEl.appendChild(el('div', 'vt-message', vt.resultsError ? 'No se pudo buscar: ' + vt.resultsError : 'No encontramos esa película. Prueba otro título o su nombre original.'));
      return;
    }
    var grid = el('div', 'vt-grid');
    vt.results.forEach(function (t) { grid.appendChild(vtPoster(t)); });
    vt.contentEl.appendChild(grid);
    if (vt.resultsError) { vt.contentEl.appendChild(vtMessage(vt.resultsError)); }
    if (vt.resultsMore) {
      var more = el('div', 'ml-more-btn focusable vt-more', vt.resultsLoading ? 'Buscando más películas…' : 'Mostrar más resultados');
      more._activate = vtSearchMore;
      vt.contentEl.appendChild(more);
    }
  }

  function vtSearchMore() {
    if (vt.resultsLoading || !vt.resultsMore) { return; }
    var seq = vt.seq, query = vt.query;
    vt.resultsLoading = true;
    vtRenderResults();
    portalServiceCall('videotecaSearch', { q: query, page: vt.resultsPage + 1 }, function (err, payload) {
      if (seq !== vt.seq || query !== vt.query || vt.view !== 'search') { return; }
      vt.resultsLoading = false;
      if (err || !payload || payload.returnValue === false) {
        vt.resultsError = mlErrText(err || (payload && payload.errorText), 'No se pudieron cargar más resultados');
      } else {
        var seen = {};
        (vt.results || []).forEach(function (t) { seen[t.id] = true; });
        (payload.items || []).forEach(function (t) { if (!seen[t.id]) { vt.results.push(t); seen[t.id] = true; } });
        vt.resultsPage++;
        vt.resultsMore = !!payload.more;
        vt.resultsError = payload.error || '';
      }
      vtRenderResults();
    }, 30000);
  }

  /* ---- Ficha ---- */
  function vtResumePoint(id) {
    return savedResumePoint({ id: id }, null);
  }
  function vtResumeLabel(t) {
    var p = vtResumePoint(t.id);
    return p ? 'Continuar · ' + shortTime(p.position) : '';
  }

  /* The Videoteca page is the scroll container and the overlays live inside
     it (position: absolute; inset: 0), so they covered the top of the page,
     not the part on screen: after scrolling down a title opened cut off, and
     focusing its "Reproducir" button made the page jump. Pin the overlay to
     the visible area and hold the page still while it is open. */
  function vtPinOverlay(node) {
    var page = vt.page;
    if (!page || !node) { return; }
    node.style.top = page.scrollTop + 'px';
    node.style.bottom = 'auto';
    node.style.height = page.clientHeight + 'px';
    page.classList.add('vt-scroll-locked');
  }
  function vtUnpinOverlay(node) {
    if (node) { node.style.top = ''; node.style.bottom = ''; node.style.height = ''; }
    if (vt.page && !vt.detailOpen && !vt.foldersOpen) { vt.page.classList.remove('vt-scroll-locked'); }
  }

  function vtOpenDetail(t) {
    vt.detailError = '';
    vt.serverIndex = 0;
    vt.detail = t;
    vt.detailOpen = true;
    vtPinOverlay(vt.detailEl);
    vtRenderDetail(t, true);
    vt.detailEl.classList.add('is-open');
    portalServiceCall('videotecaTitle', { id: t.id }, function (err, payload) {
      if (vt.detail !== t || !vt.detailOpen) { return; }
      if (err || !payload || payload.returnValue === false) {
        vt.detailError = mlErrText(err || (payload && payload.errorText), 'No se pudo cargar la ficha');
        vtRenderDetail(t, false);
        return;
      }
      vt.detailError = '';
      var full = payload.title || t;
      vt.detail = full;
      vtRenderDetail(full, false);
    }, 30000);
  }

  function vtRenderDetail(t, loading) {
    clear(vt.detailEl);
    var panel = el('div', 'vt-detail-panel');
    var bg = el('div', 'vt-detail-bg');
    if (t.backdrop || t.poster) { bg.style.backgroundImage = 'url("' + String(t.backdrop || t.poster).replace(/"/g, '%22') + '")'; }
    panel.appendChild(bg);
    var close = el('div', 'vt-close focusable');
    close.innerHTML = ML_ICONS.close;
    close.title = 'Cerrar (Esc)';
    close._activate = function () { vtCloseDetail(); };
    panel.appendChild(close);
    var body = el('div', 'vt-detail-body');
    var poster = el('div', 'vt-detail-poster');
    poster.style.setProperty('--h', radioHue(t.title));
    poster.appendChild(el('span', 'vt-initial', (t.title || '?').slice(0, 1).toUpperCase()));
    if (t.poster) {
      var img = el('img');
      img.alt = '';
      img.src = t.poster;
      img.onerror = function () { img.style.display = 'none'; };
      poster.appendChild(img);
    }
    body.appendChild(poster);
    var info = el('div', 'vt-detail-info');
    info.appendChild(el('div', 'vt-kicker', 'VIDEOTECA / ' + (t.sourceName || 'LaMovie')));
    info.appendChild(el('div', 'vt-detail-title', t.title));
    var meta = vtMetaLine(t);
    if (meta) { info.appendChild(el('div', 'vt-hero-meta', meta)); }
    if (loading) { info.appendChild(el('div', 'vt-detail-text is-loading', 'Cargando la ficha…')); }
    else if (vt.detailError) { info.appendChild(el('div', 'vt-detail-text is-error', vt.detailError)); }
    else if (t.overview) { info.appendChild(el('div', 'vt-detail-text', t.overview)); }

    if (t.cast && t.cast.length) { info.appendChild(el('div', 'vt-detail-cast', 'Reparto: ' + t.cast.join(', '))); }
    if (!loading && t.servers && t.servers.length) {
      var servers = el('div', 'vt-server-list');
      servers.appendChild(el('span', 'vt-server-label', 'Disponible en'));
      t.servers.forEach(function (server, index) {
        var option = el('div', 'vt-chip focusable' + (vt.serverIndex === index ? ' is-selected' : ''),
          [server.name, server.language].filter(Boolean).join(' · '));
        option._activate = function () { vt.serverIndex = index; vtRenderDetail(t, false); };
        servers.appendChild(option);
      });
      info.appendChild(servers);
    }
    var actions = el('div', 'vt-hero-actions');
    var canPlay = !loading && t.type !== 'series' && t.playable !== false && !vt.detailError;
    if (canPlay) {
      var point = vtResumePoint(t.id);
      if (point) {
        actions.appendChild(mlButton('is-primary', ML_ICONS.play, 'Continuar desde ' + shortTime(point.position), function () { vtPlay(t, null, point.position); }));
        actions.appendChild(mlButton('', ML_ICONS.restart, 'Desde el principio', function () { vtPlay(t, null, 0); }));
      } else {
        actions.appendChild(mlButton('is-primary', ML_ICONS.play, 'Reproducir', function () { vtPlay(t, null, null); }));
      }
    } else if (!loading && t.playable === false) {
      info.appendChild(el('div', 'vt-detail-text is-error', 'Esta ficha no tiene un vídeo que se pueda reproducir.'));
    }
    actions.appendChild(vtFavButton(t, 'ml-btn is-icon'));
    info.appendChild(actions);
    if (t.type === 'series' && t.episodes && t.episodes.length) { info.appendChild(vtEpisodes(t)); }
    body.appendChild(info);
    panel.appendChild(body);
    vt.detailEl.appendChild(panel);
    var first = panel.querySelector('.vt-hero-actions .ml-btn') || close;
    setTimeout(function () { if (vt.detailOpen) { setFocus(first); } }, 30);
  }

  function vtEpisodes(t) {
    var box = el('div', 'vt-episodes');
    var seasons = [];
    t.episodes.forEach(function (e) { if (seasons.indexOf(e.season) < 0) { seasons.push(e.season); } });
    if (vt.season === undefined || seasons.indexOf(vt.season) < 0) { vt.season = seasons[0]; }
    if (seasons.length > 1) {
      var tabs = el('div', 'vt-seasons');
      seasons.forEach(function (s) {
        var chip = el('div', 'vt-chip focusable' + (s === vt.season ? ' is-selected' : ''), 'Temporada ' + s);
        chip._activate = function () { vt.season = s; vtRenderDetail(t, false); };
        tabs.appendChild(chip);
      });
      box.appendChild(tabs);
    }
    t.episodes.filter(function (e) { return e.season === vt.season; }).forEach(function (e) {
      var row = el('div', 'vt-episode focusable');
      var point = vtResumePoint(e.id);
      row.appendChild(el('span', 'vt-ep-num', String(e.number)));
      var txt = el('div', 'vt-ep-info');
      txt.appendChild(el('div', 'vt-ep-title', e.title || 'Episodio ' + e.number));
      if (point) {
        txt.appendChild(el('div', 'vt-ep-sub', 'Vas por ' + shortTime(point.position)));
        var bar = el('i', 'vt-progress');
        var fill = el('b');
        fill.style.width = (point.duration ? Math.max(3, Math.round(point.position * 100 / point.duration)) : 10) + '%';
        bar.appendChild(fill);
        txt.appendChild(bar);
      }
      row.appendChild(txt);
      var icon = el('span', 'vt-ep-play');
      icon.innerHTML = ML_ICONS.play;
      row.appendChild(icon);
      row._activate = function () { vtPlay(t, e, point ? point.position : null); };
      box.appendChild(row);
    });
    return box;
  }

  function vtCloseDetail(silent) {
    vt.detailOpen = false;
    vt.detail = null;
    vt.detailEl.classList.remove('is-open');
    clear(vt.detailEl);
    vtUnpinOverlay(vt.detailEl);
    if (!silent) {
      var sel = vt.barEl && vt.barEl.querySelector('.vt-chip.is-selected');
      if (sel) { setFocus(sel); }
      vtScheduleHero();
    }
  }

  /* ---- Reproducir con el reproductor de películas de la app ---- */
  function vtItemFor(t, ep) {
    var name = t.title;
    if (ep) {
      name = t.title + ' · T' + ep.season + ' E' + ep.number + (ep.title && !/^Episodio \d+$/.test(ep.title) ? ' · ' + ep.title : '');
    }
    return { id: ep ? ep.id : t.id, title: name, poster: t.poster || '', cover: t.backdrop || t.poster || '',
      type: 'movie', year: t.year || '', _videoteca: true, _vtSource: t.source,
      _vtServerIndex: vt.detailOpen && vt.detail && vt.detail.id === t.id ? (vt.serverIndex || 0) : 0 };
  }
  /* at: número = empezar ahí (0 = desde el principio); null = sin preguntar;
     undefined = preguntar si hay un punto guardado. */
  function vtPlay(t, ep, at) {
    var item = vtItemFor(t, ep);
    if (vt.detailOpen) { vtCloseDetail(true); }
    vtLeave();
    openPlayer('vod', item, null, at === null ? null : at);
  }

  /* Desde el Historial de la app: abre la ficha en la Videoteca. */
  function vtOpenFromHistory(record) {
    var tab = tabOfPage(11);
    if (state.screen !== 'home') { showScreen('home'); }
    selectTab(tab, false);
    vtOpenDetail({ id: String(record.id), title: record.title || 'Título', poster: record.poster || '', type: 'movie',
      source: 'lamovie', sourceName: 'LaMovie' });
  }

  /* Al volver del reproductor: "Continuar viendo" al día. */
  function vtAfterPlayer() {
    if (!vt.loaded || !vt.page || !vt.page.classList.contains('is-current')) { return; }
    if (vt.view === 'home') { vtRenderHero(); vtRenderContent(); }
  }

  /* ---- Carpetas del PC ---- */
  function vtAddFolder() {
    if (!window.desktop || !window.desktop.videotecaAddFolder) { return; }
    window.desktop.videotecaAddFolder().then(function (payload) {
      if (!payload || payload.canceled) { return; }
      if (payload.returnValue === false) { return mlToast(payload.errorText || 'No se pudo añadir la carpeta'); }
      mlToast((payload.already ? 'Carpeta "' + payload.folder + '" revisada: ' : 'Carpeta "' + payload.folder + '" añadida: ') +
        (payload.titles || 0).toLocaleString('es') + ' títulos (' + (payload.files || 0) + ' vídeos)');
      if (vt.foldersOpen) { vtCloseFolders(true); }
      vtLoadHome();
    }, function () { mlToast('No se pudo añadir la carpeta'); });
  }

  function vtOpenFolders() {
    vt.foldersOpen = true;
    clear(vt.foldersEl);
    var panel = el('div', 'vt-detail-panel vt-folders-panel');
    var close = el('div', 'vt-close focusable');
    close.innerHTML = ML_ICONS.close;
    close._activate = function () { vtCloseFolders(); };
    panel.appendChild(close);
    panel.appendChild(el('div', 'ml-dialog-title', 'Mis carpetas'));
    panel.appendChild(el('div', 'ml-field-hint', 'Las películas y series de estas carpetas aparecen en la Videoteca. Los archivos no se copian ni se suben a ningún sitio.'));
    var listEl = el('div', 'vt-folder-list');
    if (!vt.sources.folders.length) { listEl.appendChild(el('div', 'vt-message', 'Todavía no has añadido ninguna carpeta.')); }
    vt.sources.folders.forEach(function (name, i) {
      var row = el('div', 'vt-folder');
      row.innerHTML = ML_ICONS.folder;
      row.appendChild(el('span', null, name));
      row.appendChild(mlButton('is-danger is-small', ML_ICONS.trash, 'Quitar', function () {
        portalServiceCall('videotecaRemoveFolder', { index: i }, function (err, payload) {
          if (err || !payload || payload.returnValue === false) { return mlToast(mlErrText(err || (payload && payload.errorText))); }
          vt.sources.folders.splice(i, 1);
          mlToast('Carpeta "' + name + '" quitada de la Videoteca');
          vtOpenFolders();
          vtLoadHome();
        });
      }));
      listEl.appendChild(row);
    });
    panel.appendChild(listEl);
    var actions = el('div', 'ml-dialog-actions');
    if (window.desktop && window.desktop.videotecaAddFolder) { actions.appendChild(mlButton('is-primary', ML_ICONS.plus, 'Añadir carpeta…', vtAddFolder)); }
    if (vt.sources.folders.length) {
      actions.appendChild(mlButton('', ML_ICONS.refresh, 'Volver a revisar', function () {
        portalServiceCall('videotecaRescan', {}, function (err, payload) {
          if (err || !payload || payload.returnValue === false) { return mlToast('No se pudieron revisar las carpetas'); }
          mlToast('Carpetas revisadas: ' + (payload.titles || 0).toLocaleString('es') + ' títulos');
          vtCloseFolders(true);
          vtLoadHome();
        }, 120000);
      }));
    }
    actions.appendChild(mlButton('is-ghost', '', 'Cerrar', function () { vtCloseFolders(); }));
    panel.appendChild(actions);
    vt.foldersEl.appendChild(panel);
    vtPinOverlay(vt.foldersEl);
    vt.foldersEl.classList.add('is-open');
    setTimeout(function () { var f = panel.querySelector('.ml-btn.is-primary') || close; setFocus(f); }, 30);
  }
  function vtCloseFolders(silent) {
    vt.foldersOpen = false;
    vt.foldersEl.classList.remove('is-open');
    clear(vt.foldersEl);
    vtUnpinOverlay(vt.foldersEl);
    if (!silent && vt.headActions) { var b = vt.headActions.querySelector('.ml-btn'); if (b) { setFocus(b); } }
  }

  /* "Volver" dentro de la Videoteca: ficha -> carpetas -> ver todo/búsqueda. */
  function vtBack() {
    if (vt.detailOpen) { vtCloseDetail(); return true; }
    if (vt.foldersOpen) { vtCloseFolders(); return true; }
    if (vtVisible() && (vt.view === 'browse' || vt.view === 'search')) {
      vt.query = '';
      if (vt.searchInput) { vt.searchInput.value = ''; }
      vtBackToHome();
      return true;
    }
    return false;
  }

  /* =================================================================== HOME */
  var pageDefs = [buildLivePage, buildFeaturedPage, buildMoviesPage, buildSeriesPage,
                  buildKidsPage, buildAnimePage, buildNovelsPage, buildExplorePage, buildRadioPage, buildMusicPage,
                  buildMyListsPage, buildVideotecaPage];
  var pagesBuilt = {};

  function ensurePageBuilt(idx) {
    if (pagesBuilt[idx] || !pages[idx] || !pageDefs[idx]) { return; }
    pagesBuilt[idx] = true;
    pageDefs[idx](pages[idx]);
  }

  function buildHome() {
    homeBuilt = true;
    pagesEl = $('home-pages');
    notifyEl = $('home-notify');
    clear(pagesEl);
    pages = [];
    pagesBuilt = {};

    /* Create placeholder wrappers for each tab, but build DOM only on demand */
    for (var i = 0; i < pageDefs.length; i++) {
      var page = el('div', 'home-page scrollable');
      if (i === 0) { page.classList.add('is-current', 'home-page-tv'); }
      pagesEl.appendChild(page);
      pages.push(page);
    }

    var initialTab = (TABS[state.tab] && TABS[state.tab].page >= 0) ? TABS[state.tab].page : 0;
    ensurePageBuilt(initialTab);

    buildTabs();
    buildNotify();
  }

  function buildTabs() {
    var host = $('home-tabs');
    clear(host);
    host.classList.add('scrollable');
    host.classList.add('is-expanded');
    tabEls = [];
    for (var i = 0; i < TABS.length; i++) {
      var item = el('div', 'tab-item focusable');
      /* YouMusic lleva su propio color (rojo rosado) en vez del naranja. */
      if (TABS[i].label === 'YOUMUSIC') { item.classList.add('tab-youmusic'); }
      /* Mis listas (M3U y Videoteca) lleva su color lila. */
      if (TABS[i].label === 'MIS LISTAS' || TABS[i].label === 'VIDEOTECA') { item.classList.add('tab-mylists'); }
      item.appendChild(el('div', 'tab-pill'));
      var icon = el('div', 'tab-icon');
      var desk = !!window.XUPER_DESKTOP;
      icon.innerHTML = (desk && DESKTOP_TAB_ICONS[TABS[i].deskIcon]) || TAB_ICONS[TABS[i].icon] || '';
      item.appendChild(icon);
      var title = el('div', 'tab-title', desk ? TABS[i].desk : TABS[i].label);
      item.appendChild(title);
      if (desk) {
        /* Collapsed rail: a short name stays visible under each icon. */
        item.appendChild(el('div', 'tab-mini', TABS[i].short));
        item.title = TABS[i].desk;
        item.setAttribute('aria-label', TABS[i].desk);
      }
      item._tab = i;
      item._activate = (function (idx) {
        return function () {
          if (TABS[idx].action === 'history') {
            historyViewTab = 'history';
            openSettings();
            showSettingsPanel(1, true);
            return;
          }
          selectTab(idx, false);
          if (idx === 0) {
            var row = liveRows.filter(function (r) { return r._channel === state.channel; })[0];
            if (row) { setFocus(row); }
            else if (liveRows.length) { setFocus(liveRows[0]); }
            else if (liveFocus) { setFocus(liveFocus); }
          } else if (TABS[idx].page >= 0) {
            var page = pages[TABS[idx].page];
            var f = firstIn(page);
            if (f) { setFocus(f); }
          }
        };
      })(i);
      item._onMove = (function (idx) {
        return function (dir) {
          if (dir === 'up') {
            if (idx > 0 && tabEls[idx - 1]) {
              setFocus(tabEls[idx - 1]);
              selectTab(idx - 1, false);
            }
            return true;
          }
          if (dir === 'down') {
            if (idx < tabEls.length - 1 && tabEls[idx + 1]) {
              setFocus(tabEls[idx + 1]);
              selectTab(idx + 1, false);
            }
            return true;
          }
          if (dir === 'left') {
            return true;
          }
          if (dir === 'right') {
            if (TABS[idx].action === 'history') {
              historyViewTab = 'history';
              openSettings();
              showSettingsPanel(1, true);
              return true;
            }
            selectTab(idx, false);
            if (idx === 0) {
              var row = liveRows.filter(function (r) { return r._channel === state.channel; })[0];
              if (row) { setFocus(row); }
              else if (liveRows.length) { setFocus(liveRows[0]); }
              else if (liveFocus) { setFocus(liveFocus); }
            } else if (TABS[idx].page >= 0) {
              var page = pages[TABS[idx].page];
              var f = firstIn(page);
              if (f) { setFocus(f); }
            }
            return true;
          }
          return false;
        };
      })(i);
      host.appendChild(item);
      tabEls.push(item);
    }
  }

  function buildNotify() {
    clear(notifyEl);
    /* Keep the compact controls used in the home screen: search (which also
       holds the catalogue filter, "Filtrar" tab) and profile.  The record shortcut and message bell are intentionally not
       shown here; history lives under Mi lista. */
    var defs = [
      { cls: 'search', icon: 'assets/original/home/icon_notify_search.png', small: true },
      { cls: 'personal', icon: 'assets/original/home/icon_notify_personal.png', small: true }
    ];
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var item = el('div', 'notify-item focusable ' + d.cls + (d.small ? ' is-small' : ''));
      var nn = el('div', 'n-normal');
      nn.style.backgroundImage = 'url(' + d.icon + ')';
      item.appendChild(nn);
      if (d.cls === 'personal') {
        item._activate = function () { openSettings(); };
      } else if (d.cls === 'search') {
        item.title = 'Buscar';
        item._activate = function () { openSearch(); };
      }
      notifyEl.appendChild(item);
      /* Desktop: "Filtrar" right next to the magnifier.  Opens the catalogue
         filter on its own full-width page, without the search box. */
      if (d.cls === 'search' && window.XUPER_DESKTOP) {
        var filterBtn = el('div', 'notify-item notify-filter focusable');
        filterBtn.title = 'Filtrar catálogo';
        filterBtn.setAttribute('role', 'button');
        filterBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';
        filterBtn.appendChild(el('span', null, 'Filtrar'));
        filterBtn._activate = function () { openFilter(); };
        notifyEl.appendChild(filterBtn);
      }
    }
    var div = el('div', 'notify-divider');
    notifyEl.appendChild(div);
    var wifi = el('div', 'notify-wifi');
    wifi.title = netOnline() ? 'Conectado a internet' : 'Sin conexión a internet';
    wifi.innerHTML = '<svg viewBox="0 0 30 22"><path class="wifi-slash" d="M5 2.5 25 20.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M15 19.5a2.1 2.1 0 1 1 0-4.2 2.1 2.1 0 0 1 0 4.2z" fill="currentColor"/><path d="M8.4 12.2a9.6 9.6 0 0 1 13.2 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M4.2 7.6a15.6 15.6 0 0 1 21.6 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
    notifyEl.appendChild(wifi);
    var time = el('div', 'notify-time');
    time.id = 'notify-time';
    notifyEl.appendChild(time);
    updateClock();
    setInterval(updateClock, 30000);
  }

  function updateClock() {
    var t = $('notify-time');
    if (!t) { return; }
    var d = new Date();
    var h = d.getHours();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) { h = 12; }
    var m = d.getMinutes();
    t.textContent = h + ':' + pad2(m) + ' ' + ap;
  }

  function selectTab(index, focusContent) {
    var def = TABS[index];
    /* Action rows are opened with OK/Right. Merely moving through the rail
       must not throw the user out of Home before they confirm the choice. */
    if (!def || def.action) { return; }
    /* Fuera del reproductor, la TV en vivo vuelve a tener sus propios canales. */
    if (ml.session && state.screen !== 'player') { mlEndSession(); }
    var prevPage = TABS[state.tab] ? TABS[state.tab].page : def.page;
    state.tab = index;
    for (var i = 0; i < tabEls.length; i++) {
      tabEls[i].classList.toggle('is-selected', i === index);
    }
    if (def.page >= 0) {
      rebuildDirtyPage(def.page, true);
      ensurePageBuilt(def.page);
    }
    if (def.page === 0) {
      scheduleLivePreview(CHANNELS[state.channel]);
      /* La lista se armó oculta: ya visible, se lleva al canal que se ve. */
      [0, 120, 400].forEach(function (ms) { setTimeout(function () { if (onTvTab()) { scrollLiveList(); } }, ms); });
    } else {
      stopLivePreview();
    }
    musicOnTab(def);
    /* Videoteca: el destacado rota solo mientras se ve su pestaña. */
    if (def.page === 11) { if (pagesBuilt[11]) { vtEnter(); } } else { vtLeave(); }
    for (var p = 0; p < pages.length; p++) {
      pages[p].classList.remove('is-entering', 'from-left', 'from-right');
      pages[p].classList.toggle('is-current', p === def.page);
    }
    /* Same slide direction as the ViewPager; the page itself is the only
       visible layer, which keeps its raster sharp on webOS. */
    if (def.page !== prevPage && pages[def.page]) {
      var pg = pages[def.page];
      pg.classList.add('is-entering', def.page > prevPage ? 'from-right' : 'from-left');
      setTimeout(function () {
        pg.classList.remove('is-entering', 'from-left', 'from-right');
      }, 320);
    }
    if (focusContent) {
      if (def.page === 0) {
        var row = liveRows.filter(function (r) { return r._channel === state.channel; })[0];
        if (row) { setFocus(row); }
        else if (liveRows.length) { setFocus(liveRows[0]); }
        else if (liveFocus) { setFocus(liveFocus); }
      } else {
        var f = firstIn(pages[def.page]);
        if (f) { setFocus(f); }
      }
    }
    schedulePosterMemoryPass();
  }

  /* --------------------------------------------------------------- posters */
  /* Chromium 53 retains decoded poster bitmaps very aggressively.  Keep the
     DOM/focus graph intact, but attach each source only when its tile is near
     the visible viewport and release it again when changing page/screen. */
  var posterMemoryTimer = null;
  function schedulePosterMemoryPass() {
    if (posterMemoryTimer) { clearTimeout(posterMemoryTimer); }
    posterMemoryTimer = setTimeout(function () {
      posterMemoryTimer = null;
      refreshPosterMemory();
    }, 80);
    /* A page sliding in (.28 s animation) is still off to one side at 80 ms:
       its last columns looked off screen and were never loaded.  Check again
       once the animation has finished. */
    if (posterSettleTimer) { clearTimeout(posterSettleTimer); }
    posterSettleTimer = setTimeout(function () {
      posterSettleTimer = null;
      refreshPosterMemory();
    }, 420);
  }
  var posterSettleTimer = null;
  /* Rueda del ratón o barra de desplazamiento: la página se mueve sin cambiar
     de foco, así que las carátulas que entran a la vista se cargan aquí
     (también mientras se desplaza, cada 150 ms). */
  var posterScrollAt = 0;
  document.addEventListener('scroll', function () {
    var now = Date.now();
    if (now - posterScrollAt > 150) { posterScrollAt = now; refreshPosterMemory(); }
    schedulePosterMemoryPass();
  }, { capture: true, passive: true });
  function posterBelongsToVisiblePage(img) {
    if (state.screen === 'home') {
      var homePage = closest(img, '.home-page');
      return !!(homePage && homePage.classList.contains('is-current'));
    }
    if (state.screen === 'search') {
      var results = closest(img, '.search-results');
      var hot = closest(img, '.search-hot');
      return !!((results && results.classList.contains('is-active')) ||
                (hot && !hot.classList.contains('is-hidden')));
    }
    if (state.screen === 'detail') {
      /* Related titles live inside the active detail screen, not a home page. */
      var detailScreen = closest(img, '#screen-detail');
      return !!(detailScreen && detailScreen.classList.contains('is-active'));
    }
    return false;
  }
  function refreshPosterMemory() {
    var imgs = document.querySelectorAll('img[data-poster-src]');
    var viewW = window.innerWidth || 1920;
    var viewH = window.innerHeight || 1080;
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var tile = closest(img, '.poster, .bento');
      var r = tile && tile.getBoundingClientRect ? tile.getBoundingClientRect() : null;
      var near = posterBelongsToVisiblePage(img) && r &&
        r.bottom > -420 && r.top < viewH + 420 && r.right > -320 && r.left < viewW + 320;
      if (near) {
        if (!img.getAttribute('src')) {
          img.style.display = '';
          img.src = img.getAttribute('data-poster-src');
        }
        /* Desktop: mark visible titles that have no Spanish audio. */
        if (window.XUPER_DESKTOP && tile && tile._item && tile._item._portal && !tile._audioAsked) {
          tile._audioAsked = true;
          (function (t) {
            requestLang(t._item, function (lang) {
              if (lang && audioCodes(lang.a).length && langRank(lang) > 0) { setAudioTag(t, lang); }
            });
          })(tile);
        }
      } else if (img.getAttribute('src')) {
        /* Removing the source gives Starfish a chance to release the decoded
           texture instead of keeping whole catalog pages resident in RAM. */
        img.removeAttribute('src');
        try { img.src = ''; } catch (eRelease) { /* ignore */ }
      }
    }
  }

  /* Volvió internet: carátulas que fallaron, TV, reproductor, radio y catálogo. */
  var netCatalogRetry = false;
  document.addEventListener('xuper:net', function (e) {
    if (!e.detail || !e.detail.online) { return; }
    var imgs = document.querySelectorAll('img[data-poster-src]');
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].style.display === 'none' || imgs[i].style.visibility === 'hidden') {
        imgs[i].removeAttribute('src');
        imgs[i].style.display = '';
        imgs[i].style.visibility = '';
      }
    }
    schedulePosterMemoryPass();
    var ch = CHANNELS[state.channel];
    if (ch && state.screen === 'home' && onTvTab() && liveMain && !liveMain.classList.contains('is-preview-playing')) {
      livePreviewRetries = 0;
      stopLivePreview();
      scheduleLivePreview(ch);
    }
    if (ch && state.screen === 'player' && state.playerMode === 'live') {
      var sv = shownPlayerVideo();
      if (state.streamError || (sv && !sv.paused && sv.readyState < 3)) {
        liveFreeze.retries = 0;
        startLiveChannel(ch, true);
      } else if (playerStatus && /^Sin conexión/.test(playerStatus.textContent)) { setPlayerStatus(''); }
    }
    if (radio.current && radio.status === 'error') { radioPlay(radio.current); }
    if (portalState.error) { netCatalogRetry = true; }
  });
  /* El catálogo rehace Inicio: se actualiza al salir de Inicio (como el diario). */
  setInterval(function () {
    if (!netCatalogRetry || !netOnline() || portalState.refreshing || state.screen === 'home') { return; }
    netCatalogRetry = false;
    refreshPortalCatalog();
  }, 5000);

  function makePoster(item, x, y, w, h, opts) {
    opts = opts || {};
    var p = el('div', 'poster focusable' + (opts.gold ? ' gold' : '') + (opts.type3 ? ' type3' : ''));
    abs(p, x, y, w, h);
    if (item.poster) {
      /* Keep the original no-data bitmap underneath: if the remote poster
         fails, removing the <img> reveals the authentic placeholder. */
      var pimg = el('img', 'p-img');
      pimg.setAttribute('data-poster-src', item.poster);
      /* ~200 KB posters go before the 2–3 MB mosaic images. */
      pimg.decoding = 'async';
      try { pimg.fetchPriority = 'high'; } catch (ePrio) { /* older engine */ }
      pimg.onerror = function () { this.style.display = 'none'; };
      p.appendChild(pimg);
    }
    /* sel_poster_nohalo items (free, search, related) draw their own title,
       so the PosterView title/shadow children stay hidden. */
    if (!opts.gold) {
      p.appendChild(el('div', 'p-shade'));
      p.appendChild(el('div', 'p-title', item.title));
    }
    p._item = item;
    p._activate = function () { openDetail(item); };
    schedulePosterMemoryPass();
    return p;
  }

  function addPosters(page, areaLeft, areaTop, list, items) {
    var area = el('div', 'poster-area');
    abs(area, areaLeft, areaTop, 1830, 940.5);
    var source = (items && items.length) ? items : VOD;
    if (!source.length) { page.appendChild(area); return area; }
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      area.appendChild(makePoster(source[i % source.length], d.x, d.y, d.w, d.h, d.opts));
    }
    page.appendChild(area);
    return area;
  }

  /* ------------------------------------------------------------- home live */
  function buildLivePage(page) {
    if (window.XUPER_DESKTOP) {
      /* Marco de televisor alrededor de la vista previa (bisel, logo y patas). */
      page.classList.add('has-tv-frame');
      var tv = el('div', 'live-tv');
      tv.appendChild(el('div', 'live-tv-brand', 'XUPER TV'));
      tv.appendChild(el('i', 'live-tv-led'));
      page.appendChild(tv);
    }
    liveMain = el('div', 'live-main');
    livePreviewVideo = document.createElement('video');
    livePreviewVideo.className = 'live-preview-video';
    livePreviewVideo.preload = 'auto';
    livePreviewVideo.muted = true;
    livePreviewVideo.volume = 0;
    livePreviewVideo.setAttribute('muted', 'muted');
    livePreviewVideo.setAttribute('playsinline', '');
    livePreviewVideo.setAttribute('webkit-playsinline', '');
    if (window.XUPER_DESKTOP) {
      /* Whatever started it, a preview that is really playing must be shown
         (the frame over it stays dark until the "playing" state is set). */
      livePreviewVideo.addEventListener('playing', function () {
        var v = this;
        if (v !== livePreviewVideo || !liveMain || !livePreviewChannel || v.paused) { return; }
        if (liveHandoff && liveHandoff.type === 'player') { return; }
        liveMain.classList.remove('is-preview-loading');
        liveMain.classList.add('is-preview-playing');
        if (livePreviewStatus) { livePreviewStatus.textContent = ''; }
      });
    }
    liveMain.appendChild(livePreviewVideo);
    liveMain.appendChild(el('div', 'live-frame'));
    liveMain.appendChild(el('div', 'live-logo'));
    livePreviewStatus = el('div', 'live-preview-status');
    liveMain.appendChild(livePreviewStatus);
    page.appendChild(liveMain);

    var info = el('div', 'live-info');
    liveInfoText = el('div', 'live-channel');
    /* mTvChannel is layout_toLeftOf mIvFullScreen (alignParentRight), so the
       channel name is right-aligned, not left-aligned. */
    liveInfoText.style.right = '112.5px';
    info.appendChild(liveInfoText);
    var full = el('div', 'live-fullscreen focusable');
    full._activate = function () { openPlayer('live'); };
    info.appendChild(full);
    liveMain.appendChild(info);

    var up = el('div', 'live-arrow-up focusable');
    var down = el('div', 'live-arrow-down focusable');
    up.title = 'Canal anterior';
    down.title = 'Canal siguiente';
    up._activate = function () { setChannel(state.channel - 1, true); };
    down._activate = function () { setChannel(state.channel + 1, true); };
    page.appendChild(up);
    page.appendChild(down);

    liveList = el('div', 'live-list scrollable');
    page.appendChild(liveList);
    if (window.XUPER_DESKTOP) { buildLiveSearch(page); }
    renderLiveRows(false);
    /* La lista ya se cargó al arrancar (o se está cargando): no se borra ni se
       pide otra vez. Antes se rehacía entera al entrar a TV (la barra saltaba y
       la TV pasaba unos segundos a otro canal). */
    var todosReady = CHANNELS.length && liveChannelLoadColumnId === 76182 &&
      (!currentLiveCategory || currentLiveCategory.id === 76182);
    if (!todosReady) { loadLiveChannels(); }

    liveFocus = el('div', 'live-focus focusable');
    liveFocus._onMove = function (dir) {
      if (dir === 'up') {
        if (state.channel > 0) { setChannel(state.channel - 1); }
        return true;
      }
      if (dir === 'down') {
        if (state.channel < CHANNELS.length - 1) { setChannel(state.channel + 1); }
        return true;
      }
      if (dir === 'right') {
        var row = liveRows.filter(function (r) { return r._channel === state.channel; })[0];
        if (row) { setFocus(row); }
        else if (liveRows.length) { setFocus(liveRows[0]); }
        return true;
      }
      if (dir === 'left') {
        if (tabEls[tabOfPage(0)]) { setFocus(tabEls[tabOfPage(0)]); }
        return true;
      }
      return false;
    };
    liveFocus._activate = function () { openPlayer('live'); };
    page.appendChild(liveFocus);
    if (window.XUPER_DESKTOP) {
      buildLiveDock(page);
      installLivePreviewGestures(liveFocus);
    }
  }

  /* ------------------------------------------------------------------
     Desktop: sound for the home TV preview, a control bar and country /
     topic chips under the video (the TV app kept this preview muted).
     ------------------------------------------------------------------ */
  var LIVE_COUNTRIES = ['Perú', 'México', 'Colombia', 'Venezuela', 'Ecuador', 'Chile', 'Bolivia',
    'Uruguay', 'Paraguay', 'Argentina', 'Panamá', 'Puerto Rico', 'España', 'Costa Rica',
    'Estados Unidos', 'Centroamérica', 'Honduras', 'El Salvador', 'República Dominicana', 'Guatemala', 'Nicaragua'];
  var liveDock = null, liveDockCats = null, liveMuteBtn = null, liveVolLabel = null, liveFavBtn = null;
  var liveAudio = { muted: false, volume: 0.8 };

  var LIVE_DOCK_ICONS = {
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM9.5 12 18 6v12z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM6 6l8.5 6L6 18z"/></svg>',
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 12h12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 12h12M12 6v12"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
    full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>'
  };

  /* Desktop player: icons of the control bar (24x24, currentColor). */
  var PLAYER_ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.8l10.2-6.8a1 1 0 0 0 0-1.6L9.6 4.4C8.9 3.9 8 4.4 8 5.2z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4.2" height="15" rx="1.2"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2"/></svg>',
    back10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4.5v4h4"/><text x="12" y="15.6" font-size="7.4" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Segoe UI, sans-serif">10</text></svg>',
    fwd10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5v4h-4"/><text x="12" y="15.6" font-size="7.4" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Segoe UI, sans-serif">10</text></svg>',
    volHigh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
    volLow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg>',
    volMute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></svg>',
    cc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M10.5 10.3a2.3 2.3 0 1 0 0 3.4M17 10.3a2.3 2.3 0 1 0 0 3.4" stroke-linecap="round"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.5" cy="6.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="17.5" r="1.1" fill="currentColor" stroke="none"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 6.2v11.6c0 .8.9 1.2 1.5.8l8.6-5.8a1 1 0 0 0 0-1.6L6.5 5.4C5.9 5 5 5.4 5 6.2z"/><rect x="16.5" y="5" width="2.8" height="14" rx="1"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.2v11.6c0 .8-.9 1.2-1.5.8l-8.6-5.8a1 1 0 0 1 0-1.6l8.6-5.8c.6-.4 1.5 0 1.5.8z"/><rect x="4.7" y="5" width="2.8" height="14" rx="1"/></svg>',
    pip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="currentColor" stroke="none"/></svg>',
    full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    unfull: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
    aspect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9.5V8.5h2.5M17 14.5v1h-2.5"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
    retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5v4h-4"/></svg>',
    pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 5 12 2.5-6h4"/></svg>',
    channels: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12.5" rx="2"/><path d="M8.5 3 12 6l3.5-3" stroke-linecap="round"/></svg>',
    hd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M7 9.5v5M10 9.5v5M7 12h3M13 9.5v5h1.8a2.5 2.5 0 0 0 0-5z" stroke-linecap="round"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke-linecap="round"/></svg>'
  };

  /* ---- Volume (shared by TV and video, saved like the TV one). ---- */
  var volumeUis = [];             /* every volume control on screen */
  function volumeIcon() {
    if (liveAudio.muted || liveAudio.volume === 0) { return PLAYER_ICONS.volMute; }
    return liveAudio.volume < 0.5 ? PLAYER_ICONS.volLow : PLAYER_ICONS.volHigh;
  }
  function syncPlayerAudio() {
    if (playerVideo && state.screen === 'player') {
      playerVideo.volume = liveAudio.volume;
      playerVideo.muted = liveAudio.muted;
    }
  }
  function syncVolumeUis() {
    var pct = Math.round((liveAudio.muted ? 0 : liveAudio.volume) * 100);
    for (var i = 0; i < volumeUis.length; i++) {
      var ui = volumeUis[i];
      ui.btn.innerHTML = volumeIcon();
      ui.btn.title = (liveAudio.muted ? 'Activar sonido' : 'Silenciar') + ' (M)';
      ui.btn.setAttribute('aria-label', ui.btn.title);
      ui.fill.style.width = pct + '%';
      ui.knob.style.left = pct + '%';
      ui.track.setAttribute('aria-valuenow', String(pct));
      ui.track.title = 'Volumen ' + pct + ' % (rueda del ratón o ↑ ↓)';
      if (ui.pct) { ui.pct.textContent = pct + '%'; }
    }
  }
  function setPlayerVolume(v, osd) {
    liveAudio.volume = Math.max(0, Math.min(1, Math.round(v * 20) / 20));
    if (liveAudio.volume > 0) { liveAudio.muted = false; }
    applyLiveAudio(true);
    syncPlayerAudio();
    syncVolumeUis();
    if (osd) { showOsdIcon(liveAudio.volume === 0 ? 'mute' : 'volume'); }
  }
  function togglePlayerMute() {
    if (liveAudio.muted || liveAudio.volume === 0) {
      liveAudio.muted = false;
      if (liveAudio.volume === 0) { liveAudio.volume = 0.5; }
    } else {
      liveAudio.muted = true;
    }
    applyLiveAudio(true);
    syncPlayerAudio();
    syncVolumeUis();
    showOsdIcon(liveAudio.muted ? 'mute' : 'volume');
  }
  /* Mute button + slider.  The slider follows the mouse while dragging and
     the wheel over it (or over the video) moves the volume 5 % per notch. */
  function buildVolumeControl(extraClass) {
    var wrap = el('div', 'vc-volume' + (extraClass ? ' ' + extraClass : ''));
    var btn = el('button', 'vc-btn focusable vc-mute');
    btn.type = 'button';
    btn._activate = togglePlayerMute;
    var track = el('div', 'vc-vol-track');
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', 'Volumen');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    var fill = el('div', 'vc-vol-fill');
    var knob = el('div', 'vc-vol-knob');
    track.appendChild(fill);
    track.appendChild(knob);
    var pct = el('span', 'vc-vol-pct');
    wrap.appendChild(btn);
    wrap.appendChild(track);
    wrap.appendChild(pct);
    var dragging = null;
    function fromPointer(event) {
      var r = track.getBoundingClientRect();
      setPlayerVolume(Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), false);
    }
    track.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) { return; }
      event.preventDefault(); event.stopPropagation();
      dragging = event.pointerId;
      track.setPointerCapture(dragging);
      wrap.classList.add('is-dragging');
      fromPointer(event);
    });
    track.addEventListener('pointermove', function (event) { if (event.pointerId === dragging) { fromPointer(event); } });
    function stop() { dragging = null; wrap.classList.remove('is-dragging'); }
    track.addEventListener('pointerup', stop);
    track.addEventListener('pointercancel', stop);
    track.addEventListener('lostpointercapture', stop);
    track.addEventListener('click', function (event) { event.stopPropagation(); });
    volumeUis.push({ btn: btn, track: track, fill: fill, knob: knob, pct: pct });
    syncVolumeUis();
    return wrap;
  }
  /* Wheel = volume over the video, the bars and the volume control; panels
     that scroll (settings, episodes, channels) keep their own wheel. */
  function installVolumeWheel() {
    var scr = $('screen-player');
    if (!scr || scr._volumeWheel) { return; }
    scr._volumeWheel = true;
    scr.addEventListener('wheel', function (event) {
      if (state.screen !== 'player' || scr.classList.contains('is-mini')) { return; }
      if (closest(event.target, '.player-playsetting-view, .player-episodes, .player-channels, .dialog-playsettings, .live-category-picker, .next-ep-card')) { return; }
      if (dialogPlaySettingsOpen || playSettingViewOpen || state.episodeBrowserOpen || state.channelsOpen || state.categoryPickerOpen) { return; }
      event.preventDefault();
      var step = event.deltaY < 0 ? 0.05 : -0.05;
      setPlayerVolume((liveAudio.muted ? 0 : liveAudio.volume) + step, true);
      showInfobar();
    }, { passive: false });
  }

  function loadLiveAudio() {
    var saved = safeLocalRead('xuper_live_audio_v1', null);
    if (saved) {
      liveAudio.muted = !!saved.muted;
      if (typeof saved.volume === 'number') { liveAudio.volume = Math.max(0, Math.min(1, saved.volume)); }
    }
  }
  function applyLiveAudio(save) {
    /* El usuario activa el sonido de la TV mientras suena la radio: manda la TV. */
    if (save && !liveAudio.muted && liveAudio.volume > 0 && typeof radioActive === 'function' && radioActive()) { radioYield(); }
    /* Lo mismo con YouMusic sonando por detrás. */
    if (save && !liveAudio.muted && liveAudio.volume > 0 && typeof musicSounding === 'function' && musicSounding()) { musicPauseNow(); }
    if (livePreviewVideo) {
      livePreviewVideo.muted = liveAudio.muted;
      livePreviewVideo.volume = liveAudio.volume;
      if (liveAudio.muted) { livePreviewVideo.setAttribute('muted', 'muted'); } else { livePreviewVideo.removeAttribute('muted'); }
    }
    if (playerVideo) {
      playerVideo.volume = liveAudio.volume;
      /* While the player's video stands in for the home preview it follows the
         preview's mute button. */
      if (liveHandoff && liveHandoff.type === 'player') { playerVideo.muted = liveAudio.muted; }
    }
    if (liveMuteBtn) {
      var off = liveAudio.muted || liveAudio.volume === 0;
      liveMuteBtn.innerHTML = off ? LIVE_DOCK_ICONS.mute : LIVE_DOCK_ICONS.sound;
      liveMuteBtn.title = off ? 'Activar sonido' : 'Silenciar';
      liveMuteBtn.classList.toggle('is-off', off);
    }
    if (liveVolLabel) { liveVolLabel.textContent = Math.round(liveAudio.volume * 100) + '%'; }
    if (save) { safeLocalWrite('xuper_live_audio_v1', liveAudio); }
  }
  function changeLiveVolume(delta) {
    liveAudio.volume = Math.max(0, Math.min(1, Math.round((liveAudio.volume + delta) * 10) / 10));
    if (delta > 0) { liveAudio.muted = false; }
    applyLiveAudio(true);
  }

  function liveFavKey(ch) { return 'live:' + (ch.channelCode || ch.id || ch.name); }
  function syncLiveFavButton() {
    if (!liveFavBtn) { return; }
    var ch = CHANNELS[state.channel];
    var on = !!(ch && state.favs[liveFavKey(ch)]);
    liveFavBtn.classList.toggle('is-selected', on);
    liveFavBtn.querySelector('span').textContent = on ? 'En favoritos' : 'Favorito';
  }

  function dockButton(cls, icon, label, title, run) {
    var b = el('div', 'live-dock-btn focusable ' + cls);
    var ico = el('i', 'live-dock-ico');
    ico.innerHTML = icon;
    b.appendChild(ico);
    if (label) { b.appendChild(el('span', null, label)); }
    if (title) { b.title = title; }
    b._activate = run;
    return b;
  }

  function buildLiveDock(page) {
    loadLiveAudio();
    liveDock = el('div', 'live-dock');
    var bar = el('div', 'live-dock-bar');
    /* Canal anterior / siguiente: un solo grupo, como un mando. */
    var zap = el('div', 'live-dock-group');
    zap.appendChild(dockButton('is-icon', LIVE_DOCK_ICONS.prev, '', 'Canal anterior', function () { setChannel(state.channel - 1, true); }));
    zap.appendChild(dockButton('is-icon', LIVE_DOCK_ICONS.next, '', 'Canal siguiente', function () { setChannel(state.channel + 1, true); }));
    bar.appendChild(zap);
    /* Volumen: el mismo control deslizante del reproductor (rueda del ratón encima). */
    var vol = buildVolumeControl('is-live is-dock-vol');
    vol.addEventListener('wheel', function (event) {
      event.preventDefault();
      event.stopPropagation();
      setPlayerVolume((liveAudio.muted ? 0 : liveAudio.volume) + (event.deltaY < 0 ? 0.05 : -0.05), false);
    }, { passive: false });
    bar.appendChild(vol);
    bar.appendChild(el('i', 'live-dock-spacer'));
    liveFavBtn = dockButton('is-fav', LIVE_DOCK_ICONS.star, 'Favorito', 'Guardar canal en favoritos', function () {
      var ch = CHANNELS[state.channel];
      if (!ch) { return; }
      ch.fav = toggleFavorite({ id: liveFavKey(ch) });
      syncLiveFavButton();
    });
    bar.appendChild(liveFavBtn);
    if (miniSupported()) {
      bar.appendChild(dockButton('is-mini', PLAYER_ICONS.pip, 'Ventanita', 'Ver la TV en una ventanita flotante (Ctrl+P)', openLiveMini));
    }
    bar.appendChild(dockButton('is-primary', LIVE_DOCK_ICONS.full, 'Pantalla completa', 'Ver en pantalla completa', function () { openPlayer('live'); }));
    liveDock.appendChild(bar);

    liveDockCats = el('div', 'live-dock-cats scrollable');
    liveDockCats.setAttribute('data-wheel-x', '');
    liveDock.appendChild(liveDockCats);
    page.appendChild(liveDock);
    renderLiveDockCats();
    applyLiveAudio(false);
    syncLiveFavButton();
  }

  /* ---- Ventanita de la TV: el canal en el reproductor, encogido a la esquina. ---- */
  function openLiveMini() {
    if (!miniSupported() || miniOn || !CHANNELS[state.channel]) { return; }
    if (radioMiniOn) { setRadioMini(false); }
    if (musicMiniOn) { setMusicMini(false); }
    if (state.screen !== 'player' || state.playerMode !== 'live') { openPlayer('live'); }
    var tries = 0;
    (function wait() {
      if (miniOn || state.screen !== 'player' || state.playerMode !== 'live') { return; }
      var v = shownPlayerVideo();
      var ready = v && (v.currentSrc || v.getAttribute('src'));
      /* Se espera a que el canal tenga imagen (como mucho 5 s). */
      if (!ready && ++tries < 25) { setTimeout(wait, 200); return; }
      setMiniWindow(true);
    })();
  }

  /* ---- Buscador de canales: por número (29) o por nombre (atv, espn…). ---- */
  var liveSearchInput = null, liveSearchTimer = null, liveSearchCount = null;
  function liveSearchQuery() {
    var raw = liveSearchInput ? liveSearchInput.value.trim() : '';
    if (!raw) { return null; }
    if (/^\d{1,5}$/.test(raw)) { return { num: raw }; }
    return { text: norm(raw) };
  }
  function liveChannelMatches(ch, q) {
    if (!ch) { return false; }
    if (q.num) { return String(ch.index || '').indexOf(q.num) === 0; }
    return norm(ch.name || '').indexOf(q.text) !== -1;
  }
  function buildLiveSearch(page) {
    var box = el('div', 'live-search');
    box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>';
    var input = el('input', 'live-search-input');
    input.type = 'search';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Buscar canal: número o nombre';
    input.setAttribute('aria-label', 'Buscar canal por número o nombre');
    box.appendChild(input);
    liveSearchCount = el('span', 'live-search-count');
    box.appendChild(liveSearchCount);
    var clearBtn = el('button', 'live-search-clear');
    clearBtn.type = 'button';
    clearBtn.title = 'Borrar la búsqueda (Esc)';
    clearBtn.innerHTML = RADIO_ICONS.close;
    clearBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      liveSearchReset(true);
      input.focus();
    });
    box.appendChild(clearBtn);
    input.addEventListener('input', function () {
      box.classList.toggle('has-text', !!input.value);
      if (liveSearchTimer) { clearTimeout(liveSearchTimer); }
      liveSearchTimer = setTimeout(function () { liveSearchTimer = null; renderLiveRows(false); }, 120);
    });
    input.addEventListener('keydown', function (event) {
      if (event.isComposing) { return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (liveSearchTimer) { clearTimeout(liveSearchTimer); liveSearchTimer = null; renderLiveRows(false); }
        /* Enter: pone el primer resultado en la TV y vuelve a la lista completa. */
        if (liveRows.length && liveSearchQuery()) {
          var pick = liveRows[0]._channel;
          liveSearchReset(false);
          setChannel(pick, true);
          input.blur();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (input.value) { liveSearchReset(true); } else { input.blur(); }
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (liveRows.length) { input.blur(); setFocus(liveRows[0]); }
      }
      event.stopPropagation();
    });
    box._activate = function () { input.focus(); };
    liveSearchInput = input;
    page.appendChild(box);
  }
  function liveSearchReset(render) {
    if (!liveSearchInput) { return; }
    if (liveSearchTimer) { clearTimeout(liveSearchTimer); liveSearchTimer = null; }
    liveSearchInput.value = '';
    if (liveSearchInput.parentNode) { liveSearchInput.parentNode.classList.remove('has-text'); }
    renderLiveRows(false);
    if (render) { scrollLiveList(); }
  }
  /* En la pestaña TV, escribir un número (o letra) sin hacer clic va al buscador. */
  window.addEventListener('keydown', function (event) {
    if (!liveSearchInput || !window.XUPER_DESKTOP) { return; }
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) { return; }
    if (state.screen !== 'home' || !onTvTab() || historyDrawerOpen || radio.pickerOpen || dialogAddonsOpen) { return; }
    if (document.querySelector('[id^="dialog-"].is-active')) { return; }
    var t = event.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) { return; }
    if (!/^[0-9a-zA-ZñÑáéíóúÁÉÍÓÚ]$/.test(event.key)) { return; }
    event.preventDefault();
    event.stopPropagation();
    liveSearchInput.focus();
    liveSearchInput.value += event.key;
    liveSearchInput.dispatchEvent(new Event('input'));
  }, true);

  /* ---- Portada de arranque: el fondo de Xuper TV Perú se ve un momento y se
     desvanece (Inicio ya carga detrás).  Un clic la quita antes. ---- */
  (function xuperSplash() {
    var sp = document.getElementById('xuper-splash');
    if (!sp) { return; }
    if (!window.XUPER_DESKTOP) { sp.parentNode.removeChild(sp); return; }
    var gone = false;
    function hide() {
      if (gone) { return; }
      gone = true;
      sp.classList.add('is-hidden');
      setTimeout(function () { if (sp.parentNode) { sp.parentNode.removeChild(sp); } }, 650);
    }
    sp.addEventListener('click', hide);
    setTimeout(hide, 1800);
  })();

  /* ---- Último canal visto: la TV arranca en él (no siempre en el primero). ---- */
  var LAST_CHANNEL_KEY = 'xuper_last_channel_v1';
  function readLastChannel() {
    var saved = safeLocalRead(LAST_CHANNEL_KEY, null);
    return saved && (saved.code || saved.name) ? saved : null;
  }
  var pendingLastChannel = readLastChannel();
  function saveLastChannel(ch) {
    if (!ch || ch.m3u) { return; }   /* un canal de Mis listas no es "el último canal de la TV" */
    safeLocalWrite(LAST_CHANNEL_KEY, { code: liveChannelKey(ch), name: ch.name || '' });
  }
  function findSavedChannel(saved) {
    for (var i = 0; i < CHANNELS.length; i++) {
      var ch = CHANNELS[i];
      if (saved.code && liveChannelKey(ch) === saved.code) { return i; }
    }
    if (saved.name) {
      for (var j = 0; j < CHANNELS.length; j++) { if (CHANNELS[j].name === saved.name) { return j; } }
    }
    return -1;
  }

  function renderLiveDockCats() {
    if (!liveDockCats) { return; }
    clear(liveDockCats);
    if (!liveCategories.length) {
      liveDockCats.appendChild(el('span', 'live-dock-label', 'Cargando países y temas…'));
      return;
    }
    var countries = [], topics = [], all = null;
    for (var i = 0; i < liveCategories.length; i++) {
      var c = liveCategories[i];
      if (c.name === 'Todos') { all = c; }
      else if (LIVE_COUNTRIES.indexOf(c.name) !== -1) { countries.push(c); }
      else { topics.push(c); }
    }
    function chip(cat, text) {
      var selected = currentLiveCategory === cat ||
        (currentLiveCategory && cat && currentLiveCategory.id === cat.id);
      var b = el('div', 'live-chip focusable' + (selected ? ' is-selected' : ''), text || cat.name);
      b._activate = function () {
        switchLiveCategory(cat);
        renderLiveDockCats();
      };
      liveDockCats.appendChild(b);
    }
    if (all) { chip(all, 'Todos'); }
    if (countries.length) {
      liveDockCats.appendChild(el('span', 'live-dock-label', 'Países'));
      for (var k = 0; k < countries.length; k++) { chip(countries[k]); }
    }
    if (topics.length) {
      liveDockCats.appendChild(el('span', 'live-dock-label', 'Temas'));
      for (var t = 0; t < topics.length; t++) { chip(topics[t], topics[t].isAddon ? 'Mis listas M3U' : null); }
    }
  }

  /* --- Live TV Categories & Addons (M3U / IPTV) --- */
  var PRESET_ADDONS = [
    {
      id: 'es_tdt',
      name: 'España - Canales Nacionales y TDT',
      url: 'https://iptv-org.github.io/iptv/countries/es.m3u',
      desc: '320+ canales: La 1, La 2, Antena 3, Telecinco, laSexta, autonómicas'
    },
    {
      id: 'latam_spa',
      name: 'Latinoamérica y Deportes (Hispano)',
      url: 'https://iptv-org.github.io/iptv/languages/spa.m3u',
      desc: 'Canales en español de Colombia, México, Argentina, Chile y Perú'
    },
    {
      id: 'sports_iptv',
      name: 'Deportes Internacionales',
      url: 'https://iptv-org.github.io/iptv/categories/sports.m3u',
      desc: 'Transmisiones deportivas y canales de competiciones'
    },
    {
      id: 'movies_iptv',
      name: 'Cine y Series 24/7',
      url: 'https://iptv-org.github.io/iptv/categories/movies.m3u',
      desc: 'Cine clásico, cine de acción y canales continuos de series'
    }
  ];

  function getSavedAddons() {
    try {
      var raw = localStorage.getItem('xuper_m3u_addons');
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) { return parsed; }
      }
    } catch (e) {}
    /* Default seed: España TDT so user has working external addon out of the box */
    var initial = [PRESET_ADDONS[0]];
    try { localStorage.setItem('xuper_m3u_addons', JSON.stringify(initial)); } catch (e2) {}
    return initial;
  }

  function saveSavedAddons(list) {
    try { localStorage.setItem('xuper_m3u_addons', JSON.stringify(list || [])); } catch (e) {}
  }

  var liveCategories = [];
  var currentLiveCategory = null;
  var liveCategoriesLoaded = false;
  var liveChannelsLoaded = false;
  var liveChannelsLoading = false;
  var liveChannelRequestSeq = 0;
  var liveChannelLoadColumnId = null;
  /* Home only keeps one muted live preview alive.  This warms the channel
     without creating a second full player or playing sound in the menu. */
  var livePreviewVideo = null;
  var livePreviewStatus = null;
  var livePreviewSeq = 0;
  var livePreviewTimer = null;
  var livePreviewChannel = '';
  var dialogAddonsOpen = false;

  /* ------------------------------------------------------------------
     Desktop: the home TV preview and the full-screen TV player hand the same
     playing <video> to each other, so "Pantalla completa" and "Volver" do not
     reload the channel (the TV app used two separate players).
       type 'preview': the home preview element is shown inside the player;
       type 'player' : the player element is shown in the home preview.
     ------------------------------------------------------------------ */
  var liveHandoff = null;
  var livePreviewHls = null;
  function liveChannelKey(ch) { return ch ? (ch.channelCode || ch.streamUrl || '') : ''; }
  /* El <video> que de verdad se ve en el reproductor: al pasar de la TV de
     Inicio a pantalla completa se reutiliza el de la vista previa. */
  function shownPlayerVideo() {
    return (liveHandoff && liveHandoff.type === 'preview' && livePreviewVideo) ? livePreviewVideo : playerVideo;
  }

  function borrowPreviewIntoPlayer() {
    if (!window.XUPER_DESKTOP || !livePreviewVideo || !playerStage || !liveMain || liveHandoff) { return false; }
    var ch = CHANNELS[state.channel];
    if (!liveMain.classList.contains('is-preview-playing') || !livePreviewChannel ||
        livePreviewChannel !== liveChannelKey(ch) || livePreviewVideo.paused) { return false; }
    if (livePreviewTimer) { clearTimeout(livePreviewTimer); livePreviewTimer = null; }
    playerStage.insertBefore(livePreviewVideo, playerVideo.nextSibling);
    livePreviewVideo.classList.add('is-handoff');
    if (playerFrame) { playerFrame.style.display = 'none'; }
    liveHandoff = { type: 'preview', key: livePreviewChannel };
    return true;
  }

  function returnPreviewHome() {
    if (!liveHandoff || liveHandoff.type !== 'preview') { return; }
    liveHandoff = null;
    livePreviewVideo.classList.remove('is-handoff');
    liveMain.insertBefore(livePreviewVideo, liveMain.firstChild);
  }

  function playerIsPlayingLive() {
    return state.playerMode === 'live' && playerVideo && !!playerVideo.currentSrc &&
      !playerVideo.paused && playerVideo.readyState >= 2;
  }

  function borrowPlayerIntoHome() {
    if (!window.XUPER_DESKTOP || !liveMain || liveHandoff || !playerIsPlayingLive()) { return false; }
    stopLivePreview();
    liveMain.insertBefore(playerVideo, liveMain.firstChild);
    playerVideo.classList.add('is-handoff-home');
    playerVideo.muted = liveAudio.muted;
    livePreviewChannel = liveChannelKey(CHANNELS[state.channel]);
    liveMain.classList.remove('is-preview-loading');
    liveMain.classList.add('is-preview-playing');
    liveHandoff = { type: 'player', key: livePreviewChannel };
    return true;
  }

  /* Puts the player element back on the player stage; stops it unless the
     same channel is about to be shown full screen. */
  function returnPlayerToStage(keepPlaying) {
    if (!liveHandoff || liveHandoff.type !== 'player') { return; }
    liveHandoff = null;
    playerVideo.classList.remove('is-handoff-home');
    playerVideo.muted = false;
    var anchor = playerStage.querySelector('.player-frame');
    playerStage.insertBefore(playerVideo, anchor ? anchor.nextSibling : playerStage.firstChild);
    if (liveMain) { liveMain.classList.remove('is-preview-playing'); }
    livePreviewChannel = '';
    if (!keepPlaying) { stopPlayerVideo(); }
  }

  function stopLivePreview() {
    if (liveHandoff && liveHandoff.type === 'preview') { returnPreviewHome(); }
    if (liveHandoff && liveHandoff.type === 'player') { returnPlayerToStage(false); }
    livePreviewSeq++;
    livePreviewChannel = '';
    if (livePreviewTimer) { clearTimeout(livePreviewTimer); livePreviewTimer = null; }
    if (livePreviewRetryTimer) { clearTimeout(livePreviewRetryTimer); livePreviewRetryTimer = null; }
    if (liveMain) { liveMain.classList.remove('is-preview-playing', 'is-preview-loading'); }
    if (livePreviewStatus) { livePreviewStatus.textContent = ''; }
    if (!livePreviewVideo) { return; }
    if (livePreviewHls) { try { livePreviewHls.destroy(); } catch (eDestroy) { /* ignore */ } livePreviewHls = null; }
    try { livePreviewVideo.pause(); } catch (ePause) { /* ignore */ }
    livePreviewVideo.removeAttribute('src');
    try { livePreviewVideo.src = ''; livePreviewVideo.load(); } catch (eClear) { /* ignore */ }
  }

  /* La señal se cortó o la imagen se quedó congelada: se vuelve a conectar
     sola (hasta 4 veces, cada vez esperando un poco más). */
  var livePreviewRetries = 0, livePreviewRetryTimer = null;
  var PREVIEW_MAX_RETRIES = 4;
  function livePreviewRecover(ch, mySeq) {
    if (mySeq !== livePreviewSeq) { return; }
    /* En el reproductor (o su ventanita) con el vídeo de la vista previa: que el
       reproductor vuelva a cargar el canal con su propio vídeo. */
    if (liveHandoff && liveHandoff.type === 'preview') {
      if (state.screen === 'player' && state.playerMode === 'live') { startLiveChannel(CHANNELS[state.channel], true); }
      return;
    }
    if (state.screen !== 'home' || !onTvTab() || !liveMain) { return; }
    /* Sin internet no se gastan intentos: el canal vuelve solo al reconectar. */
    if (!netOnline()) {
      liveMain.classList.remove('is-preview-playing', 'is-preview-loading');
      if (livePreviewStatus) { livePreviewStatus.textContent = 'Sin conexión a internet. ' + (ch.name || 'El canal') + ' volverá solo cuando regrese.'; }
      return;
    }
    /* Inicio mostraba el vídeo del reproductor (al volver de pantalla completa
       o de la ventanita): se devuelve y se para, y la vista previa carga de nuevo. */
    if (liveHandoff && liveHandoff.type === 'player') { stopLivePreview(); mySeq = livePreviewSeq; }
    if (livePreviewRetries >= PREVIEW_MAX_RETRIES) {
      liveMain.classList.remove('is-preview-loading', 'is-preview-playing');
      if (livePreviewStatus) { livePreviewStatus.textContent = 'Se perdió la señal de ' + (ch.name || 'el canal') + ': el servidor dejó de enviarla. Pulsa el canal para reintentar o prueba otro.'; }
      return;
    }
    livePreviewRetries++;
    liveMain.classList.remove('is-preview-playing');
    liveMain.classList.add('is-preview-loading');
    if (livePreviewStatus) { livePreviewStatus.textContent = 'Reconectando ' + (ch.name || 'canal') + '…'; }
    if (livePreviewRetryTimer) { clearTimeout(livePreviewRetryTimer); }
    livePreviewRetryTimer = setTimeout(function () {
      livePreviewRetryTimer = null;
      if (mySeq === livePreviewSeq && state.screen === 'home' && onTvTab()) { startLivePreview(ch, 2); }
    }, 1500 * livePreviewRetries);
  }
  /* Vigila que la imagen del canal en vivo avance, sea cual sea el vídeo que
     se ve (vista previa de Inicio, reproductor o su ventanita). 12 s quieta
     reproduciendo (25 s si aún no arrancó) = congelada: se reconecta. */
  var liveFreeze = { key: '', lastT: -1, still: 0, good: 0, retries: 0 };
  var PLAYER_MAX_RETRIES = 4;
  function liveFreezeTick() {
    var v = null, where = '', chKey = '';
    if (state.screen === 'home' && onTvTab() && liveMain) {
      where = 'home';
      chKey = livePreviewChannel;
      if (liveHandoff && liveHandoff.type === 'player') { v = playerVideo; }
      else if (livePreviewChannel) { v = livePreviewVideo; }
    } else if (state.screen === 'player' && state.playerMode === 'live' && !state.streamError) {
      where = 'player';
      chKey = liveChannelKey(CHANNELS[state.channel]);
      v = shownPlayerVideo();
    }
    var f = liveFreeze;
    if (!netOnline()) {
      f.lastT = -1; f.still = 0;
      /* Solo cuando ya se acabó lo descargado (antes sigue viéndose bien). */
      if (where === 'player' && v && !v.paused && v.readyState < 3) { setPlayerStatus('Sin conexión a internet. El canal volverá solo cuando regrese.'); }
      return;
    }
    if (chKey !== f.key.split('|')[1]) { f.retries = 0; }
    var key = where + '|' + chKey + '|' + (v === playerVideo ? 'p' : 'v');
    if (key !== f.key) { f.key = key; f.lastT = -1; f.still = 0; f.good = 0; }
    if (!v || !chKey || v.paused || !(v.currentSrc || v.getAttribute('src') || v.querySelector('source'))) {
      f.lastT = -1; f.still = 0; return;
    }
    var t = v.currentTime;
    if (t !== f.lastT) {
      f.lastT = t; f.still = 0; f.good += 2;
      /* Un minuto bien: los cortes de antes ya no cuentan. */
      if (f.good >= 60) { f.retries = 0; livePreviewRetries = 0; }
      return;
    }
    f.still += 2;
    var started = v.readyState >= 2 || t > 0;
    if (f.still < (started ? 12 : 25)) { return; }
    f.lastT = -1; f.still = 0; f.good = 0;
    if (where === 'home') {
      var shown = CHANNELS[state.channel];
      if (shown && liveChannelKey(shown) === chKey) { livePreviewRecover(shown, livePreviewSeq); }
      return;
    }
    var ch = CHANNELS[state.channel];
    if (f.retries >= PLAYER_MAX_RETRIES) {
      state.streamError = 'Se perdió la señal de ' + ((ch && ch.name) || 'el canal') + ': el servidor dejó de enviarla. Pulsa Reintentar o prueba otro canal.';
      setPlayerStatus(state.streamError);
      return;
    }
    f.retries++;
    startLiveChannel(ch, true);
    setPlayerStatus('Reconectando ' + ((ch && ch.name) || 'canal') + '…');
  }
  if (window.XUPER_DESKTOP) { setInterval(liveFreezeTick, 2000); }

  function startLivePreview(ch, attempt) {
    attempt = attempt || 0;
    if (!livePreviewVideo || !ch || (!ch.channelCode && !ch.streamUrl)) { return; }
    /* A preview belongs only to the TV tab on the home screen. */
    if (state.screen !== 'home' || !onTvTab()) { return; }
    /* The full-screen player is already showing this channel here. */
    if (liveHandoff && liveHandoff.type === 'player') {
      if (liveHandoff.key === liveChannelKey(ch)) { return; }
      returnPlayerToStage(false);
    }
    var key = ch.channelCode || ch.streamUrl;
    if (!attempt && key === livePreviewChannel && liveMain &&
        (liveMain.classList.contains('is-preview-loading') || liveMain.classList.contains('is-preview-playing'))) {
      return;
    }
    /* Canal nuevo (no una reconexión): los reintentos empiezan de cero. */
    if (!attempt) { livePreviewRetries = 0; }
    stopLivePreview();
    livePreviewChannel = key;
    var mySeq = ++livePreviewSeq;
    liveMain.classList.add('is-preview-loading');
    if (livePreviewStatus) { livePreviewStatus.textContent = 'Cargando ' + (ch.name || 'canal') + '…'; }
    var params = ch.streamUrl ? { streamUrl: ch.streamUrl } : { channelCode: ch.channelCode };
    portalServiceCall('resolveLive', params, function (err, payload) {
      if (mySeq !== livePreviewSeq || state.screen !== 'home' || !onTvTab()) { return; }
      if (!err && payload) { rememberCdnProbe('live', payload); }
      var url = !err && payload && payload.returnValue !== false && (payload.proxyPath || payload.url);
      if (!url) {
        if (playbackSuperseded(err)) { return; }
        /* Definitive answer (channel not offered / rate limited): retrying
           only adds portal requests, so stop and explain it. */
        if (window.XUPER_DESKTOP && liveErrorIsFinal(err)) {
          liveMain.classList.remove('is-preview-loading');
          if (livePreviewStatus) { livePreviewStatus.textContent = netExplain(err, 'la señal de ' + (ch.name || 'este canal')); }
          return;
        }
        /* Desktop: coming back from the player while it was still asking for
           this channel, the first answer can fail.  Try again twice before
           leaving the preview empty, and say so instead of a black box. */
        if (window.XUPER_DESKTOP && attempt < 2) {
          livePreviewTimer = setTimeout(function () {
            livePreviewTimer = null;
            if (mySeq === livePreviewSeq && state.screen === 'home' && onTvTab()) { startLivePreview(ch, attempt + 1); }
          }, 1500 * (attempt + 1));
          return;
        }
        if (window.XUPER_DESKTOP && livePreviewRetries > 0) { livePreviewRecover(ch, mySeq); return; }
        liveMain.classList.remove('is-preview-loading');
        if (livePreviewStatus) {
          livePreviewStatus.textContent = window.XUPER_DESKTOP
            ? (netOnline() ? 'No se pudo cargar ' + (ch.name || 'el canal') + ': el servidor no entregó la señal. Pulsa el canal para reintentar o prueba otro.'
                           : 'Sin conexión a internet. ' + (ch.name || 'El canal') + ' volverá solo cuando regrese.')
            : '';
        }
        return;
      }
      livePreviewVideo.onloadeddata = function () {
        if (mySeq !== livePreviewSeq) { return; }
        liveMain.classList.remove('is-preview-loading');
        liveMain.classList.add('is-preview-playing');
        if (livePreviewStatus) { livePreviewStatus.textContent = ''; }
      };
      livePreviewVideo.onerror = function () {
        if (mySeq !== livePreviewSeq) { return; }
        if (window.XUPER_DESKTOP) { livePreviewRecover(ch, mySeq); return; }
        liveMain.classList.remove('is-preview-loading', 'is-preview-playing');
        if (livePreviewStatus) { livePreviewStatus.textContent = ''; }
      };
      /* Desktop: play HLS with hls.js, like the full-screen player. Chromium's
         own HLS support rejects some channels (ECDF: error 4). */
      if (window.XUPER_DESKTOP && window.Hls && window.Hls.isSupported() && /\.m3u8(?:\?|$)/i.test(url)) {
        try {
          /* Live preview: a failing segment is retried 3 times over ~3.5 s (hls.js
             default: 6 times over ~30 s).  After that the error is fatal and
             livePreviewRecover() asks for a fresh signal, which is faster. */
          var quickRetry = { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 2000 };
          var hls = new window.Hls({ enableWorker: true, maxBufferLength: 20, backBufferLength: 10,
            fragLoadPolicy: { default: { maxTimeToFirstByteMs: 8000, maxLoadTimeMs: 20000,
              timeoutRetry: quickRetry, errorRetry: quickRetry } } });
          livePreviewHls = hls;
          hls.on(window.Hls.Events.MEDIA_ATTACHED, function () { hls.loadSource(url); });
          hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
            if (mySeq !== livePreviewSeq) { return; }
            var pp = livePreviewVideo.play();
            if (pp && pp.catch) { pp.catch(function () {}); }
          });
          var mediaRecovered = false;
          hls.on(window.Hls.Events.ERROR, function (_, data) {
            if (!data || !data.fatal || mySeq !== livePreviewSeq) { return; }
            /* Error de decodificación: hls.js lo arregla sin reconectar (una vez). */
            if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
              mediaRecovered = true;
              try { hls.recoverMediaError(); return; } catch (eRec) { /* reconnect below */ }
            }
            if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) { netReportFailure('network'); }
            livePreviewRecover(ch, mySeq);
          });
          hls.attachMedia(livePreviewVideo);
          return;
        } catch (eHls) { livePreviewHls = null; /* fall back to the native player */ }
      }
      try {
        livePreviewVideo.src = url;
        livePreviewVideo.load();
        var promise = livePreviewVideo.play();
        if (promise && promise.catch) { promise.catch(function () {}); }
      } catch (ePlay) { liveMain.classList.remove('is-preview-loading'); }
    });
  }

  function scheduleLivePreview(ch) {
    if (livePreviewTimer) { clearTimeout(livePreviewTimer); }
    livePreviewTimer = setTimeout(function () {
      livePreviewTimer = null;
      startLivePreview(ch || CHANNELS[state.channel]);
    }, 220);
  }

  function loadLiveCategories(done) {
    if (liveCategoriesLoaded && liveCategories.length) {
      if (done) { done(null, liveCategories); }
      return;
    }
    portalServiceCall('liveCategories', {}, function (err, payload) {
      var cats = [];
      if (payload && payload.categories && payload.categories.length) {
        for (var i = 0; i < payload.categories.length; i++) {
          var c = payload.categories[i];
          var nm = c.name;
          if (nm === 'ChannelList' || c.id === 76182) { nm = 'Todos'; }
          cats.push({ id: c.id, name: nm, code: c.code, isAddon: false });
        }
      } else {
        /* Fallback categories if portal takes time */
        cats = [
          { id: 76182, name: 'Todos' },
          { id: 76206, name: 'Deportes' },
          { id: 76205, name: 'Cine y Series' },
          { id: 76188, name: 'Colombia' },
          { id: 76191, name: 'España' },
          { id: 76197, name: 'México' }
        ];
      }
      /* Append Addons Category */
      cats.push({ id: 'addons', name: '➕ Addons M3U', isAddon: true });
      liveCategories = cats;
      liveCategoriesLoaded = true;
      if (!currentLiveCategory) { currentLiveCategory = liveCategories[0]; }
      renderPlayerCategories();
      renderLiveDockCats();
      if (done) { done(null, liveCategories); }
    });
  }

  function switchLiveCategory(cat, done) {
    if (!cat) { return; }
    currentLiveCategory = cat;
    renderPlayerCategories();
    if (cat.isAddon) {
      loadAddonChannels(function () {
        if (done) { done(); }
      });
    } else {
      loadLiveChannels(cat.id, function () {
        if (done) { done(); }
      });
    }
  }

  function loadAddonChannels(done) {
    var addons = getSavedAddons();
    if (!addons || !addons.length) {
      CHANNELS.splice(0, CHANNELS.length);
      renderLiveRows(false);
      renderPlayerChannels();
      if (done) { done(); }
      return;
    }
    setPlayerStatus('Cargando canales de Addon…');
    var allChannels = [];
    var pending = addons.length;
    for (var a = 0; a < addons.length; a++) {
      (function (ad) {
        portalServiceCall('fetchM3u', { url: ad.url }, function (err, payload) {
          if (payload && payload.channels && payload.channels.length) {
            for (var c = 0; c < payload.channels.length; c++) {
              allChannels.push(payload.channels[c]);
            }
          }
          pending--;
          if (pending <= 0) {
            setPlayerStatus('');
            CHANNELS.splice(0, CHANNELS.length);
            for (var k = 0; k < allChannels.length; k++) {
              allChannels[k].index = k + 1;
              CHANNELS.push(allChannels[k]);
            }
            state.channel = 0;
            renderLiveRows(false);
            renderPlayerChannels();
            if (CHANNELS[0] && liveInfoText) {
              liveInfoText.textContent = CHANNELS[0].name;
            }
            if (state.screen === 'player' && state.playerMode === 'live') {
              updatePlayer();
              startLiveChannel(CHANNELS[0], true);
            }
            if (done) { done(); }
          }
        });
      })(addons[a]);
    }
  }

  function loadLiveChannels(columnId, done) {
    var requestedColumnId = columnId || 76182;
    /* "Todos" (al arrancar o al volver a esa categoría): vuelve al último canal visto. */
    if (!(liveChannelsLoading && liveChannelLoadColumnId === requestedColumnId)) {
      pendingLastChannel = requestedColumnId === 76182 ? readLastChannel() : null;
    }
    /* buildLivePage and the initial boot can both ask for Todos.  Keep the
       existing request instead of clearing the first page while it streams. */
    if (liveChannelsLoading && liveChannelLoadColumnId === requestedColumnId) { return; }
    var requestSeq = ++liveChannelRequestSeq;
    liveChannelLoadColumnId = requestedColumnId;
    liveChannelsLoading = true;
    liveChannelsLoaded = false;
    CHANNELS.splice(0, CHANNELS.length);
    state.channel = 0;
    renderLiveRows(false);
    renderPlayerChannels();

    var pageNum = 1;
    var didReturnFirstPage = false;
    function fetchNextPage() {
      portalServiceCall('liveChannels', {
        columnId: requestedColumnId,
        pageNum: pageNum,
        /* 50 por página (el máximo del servicio): la lista completa llega en
           ~21 pasos en vez de 52. */
        pageSize: window.XUPER_DESKTOP ? 50 : 20
      }, function (err, payload) {
        /* A category was selected while this page was in flight. */
        if (requestSeq !== liveChannelRequestSeq) { return; }
        var pageChannels = payload && payload.channels ? payload.channels : [];
        if (!err && pageChannels.length) {
          var known = {};
          for (var k = 0; k < CHANNELS.length; k++) {
            if (CHANNELS[k] && CHANNELS[k].channelCode) {
              known[CHANNELS[k].channelCode] = true;
            }
          }
          for (var c = 0; c < pageChannels.length; c++) {
            var channel = pageChannels[c];
            if (channel && (!channel.channelCode || !known[channel.channelCode])) {
              if (channel.channelCode) { known[channel.channelCode] = true; }
              channel.fav = !!state.favs['live:' + (channel.channelCode || channel.id || channel.name)];
              CHANNELS.push(channel);
            }
          }
          liveChannelsLoaded = true;
          document.dispatchEvent(new Event('xuper:channels-updated'));
          /* Primer arranque: se busca el último canal visto según llegan las páginas. */
          var waitingLast = false;
          if (pendingLastChannel) {
            var lastAt = findSavedChannel(pendingLastChannel);
            if (lastAt >= 0) { state.channel = lastAt; pendingLastChannel = null; }
            else if (payload && payload.hasMore) { waitingLast = true; }
            else { pendingLastChannel = null; }
          }
          renderLiveRows(false);
          renderPlayerChannels();
          if (state.channel >= CHANNELS.length) { state.channel = 0; }
          if (CHANNELS[state.channel] && liveInfoText) {
            liveInfoText.textContent = CHANNELS[state.channel].name;
          }
          syncLiveFavButton();
          if (state.screen === 'player' && state.playerMode === 'live') {
            updatePlayer();
          } else if (!waitingLast) {
            /* Mientras se busca el último canal no arranca otro (antes siempre el primero). */
            scheduleLivePreview(CHANNELS[state.channel]);
          }
        }

        if (!didReturnFirstPage) {
          didReturnFirstPage = true;
          if (!liveCategoriesLoaded) { loadLiveCategories(); }
          if (done) { done(err, payload); }
        }

        if (!err && payload && payload.hasMore && pageChannels.length) {
          pageNum++;
          /* Yield to webOS between pages so navigating the first block stays
             responsive while the rest of the catalogue arrives. */
          setTimeout(fetchNextPage, 25);
          return;
        }

        liveChannelsLoading = false;
        /* "Todos" del servidor deja fuera unos 190 canales que sí están en otras
           categorías: se añaden por detrás, ordenados por su número. */
        if (!err && liveChannelsLoaded && requestedColumnId === 76182 && window.XUPER_DESKTOP) {
          mergeHiddenChannels(requestSeq);
        }
        if (err && !liveChannelsLoaded) {
          setTimeout(function () {
            if (requestSeq === liveChannelRequestSeq) { loadLiveChannels(requestedColumnId); }
          }, 2500);
        }
      });
    }
    fetchNextPage();
  }

  /* ---- Canales que el servidor no pone en "Todos" ---- */
  var EXTRA_CHANNELS_KEY = 'xuper_extra_channels_v1';
  var extraChannelsSeq = 0;
  function slimChannel(ch) {
    return { channelCode: ch.channelCode, index: ch.index, name: ch.name, logo: ch.logo, uhd: !!ch.uhd, now: 'En vivo', next: '', time: '' };
  }
  /* Mete (o cambia) los canales extra en CHANNELS sin perder el canal actual,
     el que tiene el foco ni la posición de la lista. */
  function applyExtraChannels(list) {
    /* Por código: la lista nueva trae otros objetos para los mismos canales. */
    var current = CHANNELS[state.channel] || null;
    var currentKey = current ? liveChannelKey(current) : '';
    var focusCh = (state.focus && state.focus._channel != null && liveRows.indexOf(state.focus) >= 0) ? CHANNELS[state.focus._channel] : null;
    var focusKey = focusCh ? liveChannelKey(focusCh) : '';
    var anchorCh = null, anchorOff = 0;
    if (liveList && liveRows.length) {
      var top = liveList.scrollTop;
      for (var r = 0; r < liveRows.length; r++) {
        if (liveRows[r].offsetTop + liveRows[r].offsetHeight > top) { anchorCh = liveChannelKey(CHANNELS[liveRows[r]._channel]); anchorOff = liveRows[r].offsetTop - top; break; }
      }
    }
    var known = {}, base = [];
    for (var i = 0; i < CHANNELS.length; i++) {
      if (CHANNELS[i]._extra) { continue; }
      base.push(CHANNELS[i]);
      if (CHANNELS[i].channelCode) { known[CHANNELS[i].channelCode] = true; }
    }
    /* Cada categoría numera sus canales por su cuenta (WIN Sports: 194 en Todos,
       2 en Deportes), así que los nuevos van al final con números propios,
       ordenados por nombre para que no cambien de un arranque a otro. */
    var maxIdx = 0;
    for (var m = 0; m < base.length; m++) { if (base[m].index > maxIdx) { maxIdx = base[m].index; } }
    var extras = [];
    for (var j = 0; j < list.length; j++) {
      var ch = list[j];
      if (!ch || !ch.channelCode || known[ch.channelCode]) { continue; }
      known[ch.channelCode] = true;
      ch._extra = true;
      ch.fav = !!state.favs['live:' + ch.channelCode];
      extras.push(ch);
    }
    extras.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' }) || (a.channelCode < b.channelCode ? -1 : 1); });
    for (var e = 0; e < extras.length; e++) { extras[e].index = maxIdx + 1 + e; base.push(extras[e]); }
    var added = extras.length;
    for (var o = 0; o < base.length; o++) { base[o]._order = o; }
    base.sort(function (a, b) { return ((a.index || 1e9) - (b.index || 1e9)) || (a._order - b._order); });
    CHANNELS.splice(0, CHANNELS.length);
    for (var k = 0; k < base.length; k++) { CHANNELS.push(base[k]); }
    var at = -1;
    for (var q = 0; currentKey && q < CHANNELS.length; q++) { if (liveChannelKey(CHANNELS[q]) === currentKey) { at = q; break; } }
    state.channel = at >= 0 ? at : 0;
    /* El último canal visto era uno de los nuevos: ahora ya se puede volver a él. */
    var saved = readLastChannel();
    var savedAt = saved ? findSavedChannel(saved) : -1;
    var switched = false;
    if (savedAt >= 0 && savedAt !== state.channel && CHANNELS[savedAt]._extra && !(current && current._extra) &&
        state.screen === 'home') {
      state.channel = savedAt;
      switched = true;
    }
    renderLiveRows(false);
    renderPlayerChannels();
    if (anchorCh && !switched && liveList) {
      for (var a = 0; a < liveRows.length; a++) {
        if (liveChannelKey(CHANNELS[liveRows[a]._channel]) === anchorCh) { liveList.scrollTop = Math.max(0, liveRows[a].offsetTop - anchorOff); break; }
      }
    }
    if (focusKey) {
      for (var f = 0; f < liveRows.length; f++) {
        if (liveChannelKey(CHANNELS[liveRows[f]._channel]) === focusKey) { setFocus(liveRows[f]); break; }
      }
    }
    syncLiveFavButton();
    if (switched) {
      if (liveInfoText) { liveInfoText.textContent = CHANNELS[state.channel].name; }
      if (state.screen === 'home' && onTvTab()) { scheduleLivePreview(CHANNELS[state.channel]); }
    }
    return added;
  }
  function mergeHiddenChannels(requestSeq) {
    var mySeq = ++extraChannelsSeq;
    var stillTodos = function () { return mySeq === extraChannelsSeq && requestSeq === liveChannelRequestSeq && liveChannelLoadColumnId === 76182; };
    /* Lo guardado del arranque anterior aparece al momento; luego se refresca. */
    var cached = safeLocalRead(EXTRA_CHANNELS_KEY, null);
    if (cached && cached.list && cached.list.length) {
      applyExtraChannels(cached.list.map(function (c) { var x = {}; for (var key in c) { x[key] = c[key]; } return x; }));
    }
    loadLiveCategories(function (err, cats) {
      if (!stillTodos() || !cats || !cats.length) { return; }
      var ids = [];
      for (var i = 0; i < cats.length; i++) {
        if (cats[i] && cats[i].id && cats[i].id !== 76182 && !cats[i].isAddon) { ids.push(cats[i].id); }
      }
      /* Pocas categorías = la lista de reserva (el portal no respondió): no es completa. */
      var found = {}, order = [], next = 0, running = 0, failed = ids.length < 10 ? 1 : 0;
      var known = {};
      for (var k = 0; k < CHANNELS.length; k++) { if (!CHANNELS[k]._extra && CHANNELS[k].channelCode) { known[CHANNELS[k].channelCode] = true; } }
      function finish() {
        if (!stillTodos()) { return; }
        var list = order.map(function (code) { return found[code]; });
        /* Si alguna categoría falló, no se borran canales que ya se conocían. */
        if (failed && cached && cached.list) {
          for (var c = 0; c < cached.list.length; c++) {
            var old = cached.list[c];
            if (old && old.channelCode && !found[old.channelCode] && !known[old.channelCode]) { list.push(old); }
          }
        }
        safeLocalWrite(EXTRA_CHANNELS_KEY, { at: Date.now(), list: list.map(slimChannel) });
        applyExtraChannels(list);
      }
      function pump() {
        if (!stillTodos()) { return; }
        while (running < 3 && next < ids.length) {
          running++;
          (function (id) {
            (function page(n) {
              /* Background scan (~70 pages at startup): it yields to anything
                 the viewer asks for, so it may wait longer than a normal call. */
              portalServiceCall('liveChannels', { columnId: id, pageNum: n, pageSize: 50, background: true }, function (e2, p2) {
                if (!stillTodos()) { return; }
                var list = (p2 && p2.channels) || [];
                if (e2) { failed++; }
                for (var j = 0; j < list.length; j++) {
                  var ch = list[j];
                  if (ch && ch.channelCode && !known[ch.channelCode] && !found[ch.channelCode]) { found[ch.channelCode] = ch; order.push(ch.channelCode); }
                }
                if (!e2 && p2 && p2.hasMore && list.length && n < 60) { setTimeout(function () { page(n + 1); }, 40); return; }
                running--;
                if (next >= ids.length && !running) { finish(); } else { pump(); }
              }, BACKGROUND_CALL_MS);
            })(1);
          })(ids[next++]);
        }
      }
      pump();
    });
  }

  function renderLiveRows(favOnly) {
    if (!liveList) { return; }
    clear(liveList);
    liveRows = [];
    if (!CHANNELS.length) {
      liveList.appendChild(el('div', 'live-list-status',
        liveChannelsLoaded ? 'No se encontraron canales' : 'Cargando canales…'));
      return;
    }
    var q = liveSearchQuery();
    var order = [];
    for (var o = 0; o < CHANNELS.length; o++) {
      if (favOnly && !CHANNELS[o].fav) { continue; }
      if (q && !liveChannelMatches(CHANNELS[o], q)) { continue; }
      order.push(o);
    }
    /* Número exacto primero (29 antes que 290). */
    if (q && q.num) {
      order.sort(function (a, b) {
        var ea = String(CHANNELS[a].index) === q.num ? 0 : 1, eb = String(CHANNELS[b].index) === q.num ? 0 : 1;
        return ea - eb || a - b;
      });
    }
    if (liveSearchCount) { liveSearchCount.textContent = q ? (order.length + (order.length === 1 ? ' canal' : ' canales')) : ''; }
    if (q && !order.length) {
      liveList.appendChild(el('div', 'live-list-status', 'Ningún canal coincide con «' + liveSearchInput.value.trim() + '»'));
      return;
    }
    for (var n = 0; n < order.length; n++) {
      var i = order[n];
      var row = el('div', 'live-row focusable');
      row._channel = i;
      if (window.XUPER_DESKTOP && CHANNELS[i].index) { row.appendChild(el('div', 'row-num', String(CHANNELS[i].index))); }
      var icon = el('div', 'row-icon');
      if (CHANNELS[i].logo) {
        icon.style.backgroundImage = 'url(' + CHANNELS[i].logo + ')';
        icon.style.backgroundSize = 'contain';
        icon.style.backgroundRepeat = 'no-repeat';
        icon.style.backgroundPosition = 'center';
      }
      var play = el('div', 'row-play');
      var name = el('div', 'row-name', CHANNELS[i].name);
      row.appendChild(icon);
      row.appendChild(play);
      row.appendChild(name);
      if (i === state.channel) { row.classList.add('is-current'); }
      row.title = liveRowTitle(i === state.channel);
      row._activate = (function (idx) {
        return function () {
          /* Otro canal: se pone aquí, en la TV de Inicio. El que ya se ve (o un
             doble clic): a pantalla grande. */
          if (idx === state.channel) {
            openPlayer('live');
            return;
          }
          setChannel(idx, true);
        };
      })(i);
      row._onMove = (function (self) {
        return function (dir) {
          /* Posición en la lista que se ve (puede estar filtrada por el buscador). */
          var at = liveRows.indexOf(self);
          if (dir === 'left') {
            if (liveFocus) { setFocus(liveFocus); }
            else if (tabEls[tabOfPage(0)]) { setFocus(tabEls[tabOfPage(0)]); }
            return true;
          }
          if (dir === 'up') {
            if (at > 0 && liveRows[at - 1]) { setFocus(liveRows[at - 1]); }
            else if (at === 0 && liveSearchInput) { liveSearchInput.focus(); }
            return true;
          }
          if (dir === 'down') {
            if (at < liveRows.length - 1 && liveRows[at + 1]) {
              setFocus(liveRows[at + 1]);
            }
            return true;
          }
          return false;
        };
      })(row);
      liveList.appendChild(row);
      liveRows.push(row);
    }
    if (CHANNELS[state.channel] && liveInfoText) {
      liveInfoText.textContent = CHANNELS[state.channel].name;
    }
    scrollLiveList();
  }

  function scrollLiveList() {
    if (!liveRows.length) { return; }
    var visible = liveRows.filter(function (r) { return r._channel === state.channel; })[0];
    if (!visible) { return; }
    var idx = liveRows.indexOf(visible);
    var top = idx * 120;
    var max = Math.max(0, liveList.scrollHeight - liveList.clientHeight);
    var target = liveList.scrollTop;
    if (top < target) { target = top; }
    if (top + 100.5 > target + liveList.clientHeight) {
      target = top + 100.5 - liveList.clientHeight;
    }
    liveList.scrollTop = Math.max(0, Math.min(max, target));
  }

  function liveRowTitle(current) {
    return current ? 'Ver en pantalla completa' : 'Ver en la TV (doble clic: pantalla completa)';
  }

  function setChannel(index, immediate) {
    if (index < 0) { index = 0; }
    if (index > CHANNELS.length - 1) { index = CHANNELS.length - 1; }
    state.channel = index;
    saveLastChannel(CHANNELS[index]);
    pendingLastChannel = null;
    for (var i = 0; i < liveRows.length; i++) {
      liveRows[i].classList.toggle('is-current', liveRows[i]._channel === index);
      liveRows[i].title = liveRowTitle(liveRows[i]._channel === index);
    }
    if (CHANNELS[index] && liveInfoText) {
      liveInfoText.textContent = CHANNELS[index].name;
    }
    scrollLiveList();
    syncLiveFavButton();
    if (state.screen === 'player') {
      updatePlayerChannel();
      if (state.playerMode === 'live') {
        startLiveChannel(CHANNELS[index], !!immediate);
      }
    } else if (state.screen === 'home' && onTvTab()) {
      scheduleLivePreview(CHANNELS[index]);
    }
  }

  /* --- Addon Manager Dialog logic --- */
  function openAddonsDialog() {
    dialogAddonsOpen = true;
    var dlg = $('dialog-addons');
    if (!dlg) { return; }
    dlg.classList.add('is-active');
    renderAddonsDialog();
    var firstBtn = dlg.querySelector('.focusable');
    if (firstBtn) { setFocus(firstBtn); }
  }

  function closeAddonsDialog() {
    dialogAddonsOpen = false;
    var dlg = $('dialog-addons');
    if (!dlg) { return; }
    dlg.classList.remove('is-active');
    if (state.channelsOpen) {
      var btn = playerChannels ? playerChannels.querySelector('#pc-btn-addons') : null;
      if (btn) { setFocus(btn); }
      else { setFocus(playerStage); }
    }
  }

  function renderAddonsDialog() {
    var presetsBox = $('da-presets-list');
    var installedBox = $('da-installed-list');
    var saved = getSavedAddons();
    var savedUrls = {};
    for (var s = 0; s < saved.length; s++) { savedUrls[saved[s].url] = true; }

    if (presetsBox) {
      clear(presetsBox);
      for (var p = 0; p < PRESET_ADDONS.length; p++) {
        (function (preset) {
          var item = el('div', 'da-preset-item');
          var info = el('div', 'da-preset-info');
          info.appendChild(el('div', 'da-preset-name', preset.name));
          info.appendChild(el('div', 'da-preset-desc', preset.desc));
          item.appendChild(info);

          var isInst = !!savedUrls[preset.url];
          var btn = el('button', 'da-preset-btn focusable' + (isInst ? ' is-installed' : ''), isInst ? '✔ Instalado' : '+ Instalar');
          btn.disabled = isInst;
          btn._activate = function () {
            if (isInst) { return; }
            btn.disabled = true;
            btn.textContent = 'Instalando…';
            installAddon(preset, function (err, count) {
              if (err) {
                btn.disabled = false;
                btn.textContent = 'Error';
                setTimeout(function () { btn.textContent = '+ Instalar'; }, 2000);
              } else {
                renderAddonsDialog();
                if (currentLiveCategory && currentLiveCategory.isAddon) {
                  loadAddonChannels();
                }
              }
            });
          };
          item.appendChild(btn);
          presetsBox.appendChild(item);
        })(PRESET_ADDONS[p]);
      }
    }

    if (installedBox) {
      clear(installedBox);
      if (!saved.length) {
        installedBox.appendChild(el('div', 'da-installed-empty', 'No hay addons personalizados instalados aún. Instala una lista recomendada arriba o escribe una URL.'));
      } else {
        for (var i = 0; i < saved.length; i++) {
          (function (ad, idx) {
            var row = el('div', 'da-installed-item');
            var info = el('div', 'da-installed-info');
            var nm = el('div', 'da-preset-name', ad.name);
            var sub = el('div', 'da-preset-desc', (ad.count ? (ad.count + ' canales • ') : '') + ad.url);
            info.appendChild(nm);
            info.appendChild(sub);
            row.appendChild(info);

            var delBtn = el('button', 'da-del-btn focusable', 'Eliminar');
            delBtn._activate = function () {
              saved.splice(idx, 1);
              saveSavedAddons(saved);
              renderAddonsDialog();
              if (currentLiveCategory && currentLiveCategory.isAddon) {
                loadAddonChannels();
              }
            };
            row.appendChild(delBtn);
            installedBox.appendChild(row);
          })(saved[i], i);
        }
      }
    }

    var addCustomBtn = $('da-btn-add-custom');
    if (addCustomBtn) {
      addCustomBtn._activate = function () {
        var inp = $('da-custom-url');
        var url = inp ? (inp.value || '').trim() : '';
        if (!url || !/^https?:\/\//i.test(url)) {
          alert('Por favor introduce una URL válida (http:// o https://)');
          return;
        }
        addCustomBtn.textContent = 'Descargando…';
        addCustomBtn.disabled = true;
        installAddon({ id: 'custom_' + Date.now(), name: 'Lista Personalizada', url: url }, function (err, count) {
          addCustomBtn.disabled = false;
          addCustomBtn.textContent = 'Agregar';
          if (err) {
            alert('No se pudo cargar la lista M3U: ' + err);
          } else {
            if (inp) { inp.value = ''; }
            renderAddonsDialog();
            if (currentLiveCategory && currentLiveCategory.isAddon) {
              loadAddonChannels();
            }
          }
        });
      };
    }

    var exitBtn = $('da-btn-exit');
    if (exitBtn) {
      exitBtn._activate = function () { closeAddonsDialog(); };
    }
  }

  function installAddon(addon, done) {
    portalServiceCall('fetchM3u', { url: addon.url }, function (err, payload) {
      if (err || !payload || !payload.channels || !payload.channels.length) {
        if (done) { done(err || 'No se encontraron canales en la lista'); }
        return;
      }
      var saved = getSavedAddons();
      /* Check duplicate */
      var exists = false;
      for (var s = 0; s < saved.length; s++) {
        if (saved[s].url === addon.url) {
          saved[s].count = payload.channels.length;
          exists = true;
          break;
        }
      }
      if (!exists) {
        saved.push({
          id: addon.id || ('addon_' + Date.now()),
          name: addon.name || 'Lista M3U',
          url: addon.url,
          count: payload.channels.length
        });
      }
      saveSavedAddons(saved);
      if (done) { done(null, payload.channels.length); }
    });
  }

  /* ---------------------------------------------------------- home posters */
  /* Bento mosaic measured on the running app (WSA, 1920x1080):
       mRecommend01 831x534 @ 192,212   mRecommend02 831x534 @ 1029,212
       mRecommend03..06 413x222 @ y 752, x 192/609/1028/1446
       pagination dots around 843,723 (screen) -> page coords subtract 173.5.
     The page grid is identical for DESTACADOS, PELICULA, SERIES and ANIME. */
  var BENTO = {
    bigW: 831, bigH: 534, bigY: 38.5,
    smallW: 413, smallH: 222, smallY: 578.5,
    bigX: [192, 1029],
    smallX: [192, 609, 1028, 1446]
  };
  /* Desktop grid: content from x 192 to 1856 (64 px right margin, same as
     the header) with an even 16 px gap between every tile. */
  var GRID_GAP = 16;
  if (window.XUPER_DESKTOP) {
    BENTO = {
      bigW: 824, bigH: 464, bigY: 24,
      smallW: 404, smallH: 228, smallY: 24 + 464 + GRID_GAP,
      bigX: [192, 192 + 824 + GRID_GAP],
      smallX: [192, 612, 1032, 1452]
    };
  }

  function makeBento(item, x, y, w, h, opts) {
    opts = opts || {};
    var t = el('div', 'bento focusable');
    abs(t, x, y, w, h);
    var art = item ? (item.landscape || item.poster) : '';
    if (art) {
      var img = el('img', 'bento-img');
      img.setAttribute('data-poster-src', art);
      img.decoding = 'async';
      try { img.fetchPriority = w > 500 ? 'auto' : 'low'; } catch (ePrio) { /* older engine */ }
      img.onerror = function () {
        this.style.display = 'none';
        if (window.XUPER_DESKTOP) { t.classList.add('no-art'); }
      };
      t.appendChild(img);
    } else if (window.XUPER_DESKTOP) {
      t.classList.add('no-art');
    }
    if (opts.shade || window.XUPER_DESKTOP) { t.appendChild(el('div', 'bento-shade')); }
    /* Desktop: every tile carries its title (shown on hover, focus or when
       the artwork is missing). */
    if (item && (opts.title || window.XUPER_DESKTOP)) { t.appendChild(el('div', 'bento-title', item.title)); }
    if (opts.badge) { t.appendChild(el('div', 'bento-badge', opts.badge)); }
    t._item = item;
    if (item) { t._activate = function () { openDetail(item); }; }
    schedulePosterMemoryPass();
    return t;
  }

  function bentoDots(x, y, count, active) {
    var d = el('div', 'bento-dots');
    abs(d, x, y, 21 + Math.max(0, count - 1) * 40, 11);
    for (var i = 0; i < count; i++) {
      d.appendChild(el('span', 'bento-dot' + (i === active ? ' is-active' : '')));
    }
    return d;
  }

  function bentoPage(page, items, opts) {
    opts = opts || {};
    var source = items.length ? items : VOD;
    if (!source.length) { return; }
    var i;
    for (i = 0; i < 2; i++) {
      page.appendChild(makeBento(source[i % source.length], BENTO.bigX[i], BENTO.bigY,
                                 BENTO.bigW, BENTO.bigH,
                                 { shade: opts.shade !== false, title: opts.titles }));
    }
    for (i = 0; i < 4; i++) {
      page.appendChild(makeBento(source[(i + 2) % source.length], BENTO.smallX[i], BENTO.smallY,
                                 BENTO.smallW, BENTO.smallH, {}));
    }
    if (opts.dots) {
      if (window.XUPER_DESKTOP) {
        var dotsW = 21 + Math.max(0, opts.dots - 1) * 40;
        page.appendChild(bentoDots(BENTO.bigX[0] + BENTO.bigW - dotsW - 36, BENTO.bigY + BENTO.bigH - 34, opts.dots, 0));
      } else {
        page.appendChild(bentoDots(848, 535.5, opts.dots, 0));
      }
    }
  }
  /* Where the catalogue below the mosaic starts. */
  function catalogStartY() {
    return window.XUPER_DESKTOP ? BENTO.smallY + BENTO.smallH + 48 : 860;
  }

  /* DESTACADOS / PELICULA: the observed 831x534 crops already contain the
     real title bar and pagination dots drawn by the APK, so the port must not
     paint a second copy over them. Portal artwork is plain 16:9 art, so the
     title and dots have to be drawn. */
  function allVodFor(category) {
    var out = [], i;
    if (category) {
      for (i = 0; i < VOD.length; i++) {
        var cats = norm(VOD[i].category || '').split(',');
        if (cats.indexOf(category) !== -1 || (VOD[i].kind && norm(VOD[i].kind).indexOf(category) !== -1)) {
          out.push(VOD[i]);
        }
      }
    }
    return out.length ? out : VOD;
  }

  function appendCatalogGrid(page, items, startY, titleText) {
    if (!items || !items.length) { return; }
    var y = startY || 860;
    var sub = el('div', 'kids-subtitle', titleText || 'Catálogo');
    abs(sub, 192, y, 1249, 40);
    page.appendChild(sub);
    y += 50;

    var colW = 276;
    var colH = 390;
    var maxCols = 6;
    var posterW = 250, posterH = 360;
    if (window.XUPER_DESKTOP) {
      /* Seven posters across 1664 px, 16 px apart, 2:3 like the artwork. */
      maxCols = 7;
      posterW = Math.floor((1664 - GRID_GAP * (maxCols - 1)) / maxCols);
      posterH = Math.round(posterW * 1.5);
      colW = posterW + GRID_GAP;
      colH = posterH + 24;
    }
    var cursor = 0;
    var more = null;
    if (window.XUPER_DESKTOP) {
      more = el('button', 'desktop-more focusable');
      more.type = 'button';
      more._activate = appendBatch;
      page.appendChild(more);
      page.addEventListener('scroll', function () {
        if (cursor < items.length && page.scrollTop + page.clientHeight >= page.scrollHeight - 250) appendBatch();
      }, { passive: true });
    }
    function appendBatch() {
      var limit = Math.min(items.length, cursor + 60);
      for (; cursor < limit; cursor++) {
        var col = cursor % maxCols;
        var row = Math.floor(cursor / maxCols);
        page.appendChild(makePoster(items[cursor], 192 + col * colW, y + row * colH, posterW, posterH, { gold: true }));
      }
      if (more) {
        abs(more, 192, y + Math.ceil(cursor / maxCols) * colH + 15, window.XUPER_DESKTOP ? 1664 : 1600, window.XUPER_DESKTOP ? 56 : 74);
        more.textContent = cursor < items.length ? 'Ver más · ' + cursor + ' de ' + items.length : 'Has visto los ' + items.length + ' títulos';
        more.disabled = cursor >= items.length;
      }
      schedulePosterMemoryPass();
    }
    appendBatch();
  }

  /* ---- Desktop: real rankings on Destacados / Películas / Series.
     The portal's TOP15 rows (it sends 10 titles each) are its only real
     popularity data; the first featured row is a themed collection. */
  function topMovieItems() {
    return spanishSorted(portalRowItems(function (root, name) { return isTopRow(name) && isMovieRow(name); }).slice(0, 10));
  }
  function topSeriesItems() {
    return spanishSorted(portalRowItems(function (root, name) { return isTopRow(name) && !isMovieRow(name); }).slice(0, 10));
  }
  /* Same order as the search with "Priorizar español": Spanish audio, then
     Spanish subtitles, then the rest; the portal order is kept inside each
     group.  Titles whose language is not known yet count as "unknown". */
  function spanishSorted(list) {
    if (!spanishFirst() || list.length < 2) { return list; }
    return list.map(function (it, i) { return { it: it, i: i, r: langRank(knownLang(it)) }; })
      .sort(function (a, b) { return a.r - b.r || a.i - b.i; })
      .map(function (x) { return x.it; });
  }
  /* Titles of one portal root (movies, series…) in the portal's own order.
     Before the first refresh the merged category is used: it comes from the
     root a title was loaded from, unlike `kind`, which every movie shares. */
  function rootVodItems(root, category) {
    var out = portalRows.length ? portalRowItems(function (r) { return r === root; }) : [];
    if (out.length) { return out; }
    for (var i = 0; i < VOD.length; i++) {
      if (norm(VOD[i].category || '').split(',').indexOf(category) !== -1) { out.push(VOD[i]); }
    }
    return out;
  }
  function withoutItems(list, drop) {
    var skip = {}, out = [], i;
    for (i = 0; i < drop.length; i++) { skip[String(drop[i].id)] = true; }
    for (i = 0; i < list.length; i++) { if (!skip[String(list[i].id)]) { out.push(list[i]); } }
    return out;
  }
  /* "N.º 1" badges on the mosaic tiles, in the order bentoPage draws them. */
  function badgeBentoRanks(page, ranks) {
    var tiles = page.querySelectorAll('.bento');
    for (var i = 0; i < tiles.length && i < ranks.length; i++) {
      if (ranks[i]) { tiles[i].appendChild(el('div', 'rank-badge is-bento', ranks[i])); }
    }
  }
  /* One row of up to ten small numbered posters.  Returns the next free y. */
  function appendRankRow(page, items, y, titleText) {
    if (!items.length) { return y; }
    var sub = el('div', 'kids-subtitle', titleText);
    abs(sub, 192, y, 1249, 40);
    page.appendChild(sub);
    y += 50;
    var cols = 10;
    var w = Math.floor((1664 - GRID_GAP * (cols - 1)) / cols);
    var h = Math.round(w * 1.5);
    for (var i = 0; i < items.length && i < cols; i++) {
      var poster = makePoster(items[i], 192 + i * (w + GRID_GAP), y, w, h, { gold: true });
      poster.classList.add('is-ranked');
      poster.appendChild(el('div', 'rank-badge', String(i + 1)));
      page.appendChild(poster);
    }
    return y + h + 48;
  }

  /* Recién agregados: lo último que subió el portal (películas y series),
     según su fecha de publicación. */
  var NEW_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function newestItems(max) {
    var pool = filterPool().filter(function (it) { return shelveMs(it) > 0; });
    pool.sort(function (a, b) { return shelveMs(b) - shelveMs(a); });
    return pool.slice(0, max);
  }
  function newLabel(item) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(item.shelveTime || ''));
    if (!m) { return 'Nuevo'; }
    var day = new Date(+m[1], +m[2] - 1, +m[3]);
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var diff = Math.round((today - day) / 86400000);
    if (diff <= 0) { return 'Hoy'; }
    if (diff === 1) { return 'Ayer'; }
    return (+m[3]) + ' ' + NEW_MONTHS[+m[2] - 1];
  }
  function appendNewRow(page, items, y, titleText) {
    if (!items.length) { return y; }
    var sub = el('div', 'kids-subtitle', titleText);
    abs(sub, 192, y, 1249, 40);
    page.appendChild(sub);
    y += 50;
    var cols = 10;
    var w = Math.floor((1664 - GRID_GAP * (cols - 1)) / cols);
    var h = Math.round(w * 1.5);
    for (var i = 0; i < items.length && i < cols; i++) {
      var poster = makePoster(items[i], 192 + i * (w + GRID_GAP), y, w, h, { gold: true });
      poster.classList.add('is-ranked', 'is-new');
      poster.appendChild(el('div', 'rank-badge new-badge', newLabel(items[i])));
      page.appendChild(poster);
    }
    return y + h + 48;
  }

  function buildFeaturedPageDesktop(page) {
    var movies = topMovieItems(), series = topSeriesItems();
    if (!movies.length && !series.length) { return false; }
    /* Mosaico: películas a la izquierda (N.º 1 grande, N.º 2 y 3 debajo) y
       series a la derecha.  Orden de los recuadros: grande izq., grande der.
       y los cuatro pequeños de izquierda a derecha.  Si falta un título, el
       recuadro lo ocupa el siguiente del otro tipo (nunca queda vacío). */
    var hero = [], ranks = [];
    var kinds = { m: [movies, 'Película'], s: [series, 'Serie'] };
    var slots = [['m', 0], ['s', 0], ['m', 1], ['m', 2], ['s', 1], ['s', 2]];
    var used = {};
    function takeRank(kind, n) {
      var it = kinds[kind][0][n];
      if (!it || used[kind + n]) { return false; }
      used[kind + n] = true;
      hero.push(it);
      ranks.push('N.º ' + (n + 1) + ' · ' + kinds[kind][1]);
      return true;
    }
    for (var i = 0; i < slots.length; i++) {
      if (takeRank(slots[i][0], slots[i][1])) { continue; }
      var other = slots[i][0] === 'm' ? 's' : 'm';
      /* Del N.º 4 en adelante: los tres primeros ya tienen su recuadro. */
      for (var n = 3; n < kinds[other][0].length; n++) {
        if (takeRank(other, n)) { break; }
      }
    }
    bentoPage(page, hero, { titles: true, dots: 0, shade: true });
    badgeBentoRanks(page, ranks);
    var y = catalogStartY();
    y = appendNewRow(page, newestItems(10), y, 'Recién agregados');
    y = appendRankRow(page, movies, y, 'Top 10 películas');
    y = appendRankRow(page, series, y, 'Top 10 series');
    var rest = withoutItems(rootVodItems('featured', 'destacado'), movies.concat(series));
    if (rest.length) { appendCatalogGrid(page, rest, y, 'Títulos destacados'); }
    return true;
  }

  /* The mosaic of Películas / Series picks its six tiles from the first
     HERO_POOL titles of the section, Spanish first. */
  var HERO_POOL = 12;

  /* Ask, in the background, the languages of the titles these pages put
     first (rankings + mosaic candidates).  When they are known the pages are
     rebuilt in Spanish-first order; the posters of the rankings are fetched
     at the same time so the rows open with their artwork. */
  var RANK_PAGES = [1, 2, 3];          /* Destacados, Películas, Series */
  var pagesDirty = {};
  var rankWarmSeq = 0;
  var rankPrefetch = [];
  function rankPagesChanged() {
    document.dispatchEvent(new Event('xuper:ranks-updated'));
    for (var i = 0; i < RANK_PAGES.length; i++) { pagesDirty[RANK_PAGES[i]] = true; }
    rebuildDirtyPage(TABS[state.tab] ? TABS[state.tab].page : -1, false);
  }
  /* A page is rebuilt when it is opened, or right away if it is on screen
     but untouched (not scrolled, focus outside it). */
  function rebuildDirtyPage(idx, entering) {
    if (!pagesDirty[idx] || !pages[idx]) { return; }
    var old = pages[idx];
    var current = old.classList.contains('is-current');
    if (current && !entering && state.screen === 'home' &&
        (old.scrollTop > 0 || (state.focus && closest(state.focus, '.home-page') === old))) { return; }
    pagesDirty[idx] = false;
    if (!pagesBuilt[idx]) { return; }
    /* A fresh element: the old one keeps scroll listeners of its grid. */
    var fresh = el('div', old.className);
    old.parentNode.replaceChild(fresh, old);
    pages[idx] = fresh;
    pagesBuilt[idx] = false;
    if (current) { ensurePageBuilt(idx); schedulePosterMemoryPass(); }
  }
  function warmRankPages() {
    if (!window.XUPER_DESKTOP) { return; }
    var seq = ++rankWarmSeq;
    var raw = function (test) { return portalRowItems(test).slice(0, 10); };
    var tops = raw(function (r, n) { return isTopRow(n) && isMovieRow(n); })
      .concat(raw(function (r, n) { return isTopRow(n) && !isMovieRow(n); }));
    /* Kept referenced so the downloads are not dropped half way. */
    rankPrefetch = [];
    for (var t = 0; t < tops.length; t++) {
      if (tops[t].poster) { var pre = new Image(); pre.decoding = 'async'; pre.src = tops[t].poster; rankPrefetch.push(pre); }
    }
    var wanted = tops.concat(rootVodItems('movies', 'pelicula').slice(0, HERO_POOL),
                             rootVodItems('series', 'serie').slice(0, HERO_POOL));
    var pending = 0, done = false;
    function finish() {
      if (done || seq !== rankWarmSeq) { return; }
      done = true;
      rankPagesChanged();
    }
    for (var w = 0; w < wanted.length; w++) {
      if (!wanted[w] || !wanted[w]._portal || knownLang(wanted[w])) { continue; }
      pending++;
      requestLang(wanted[w], function () { pending--; if (pending <= 0) { finish(); } });
    }
    if (!pending) { finish(); return; }
    /* A new search empties the language queue; do not wait forever. */
    setTimeout(finish, 90000);
  }

  function buildRootPageDesktop(page, root, category, ranked, rankTitle, moreTitle) {
    var all = rootVodItems(root, category);
    if (!all.length && !ranked.length) { return false; }
    var hero = all.length ? spanishSorted(all.slice(0, HERO_POOL)).slice(0, 6) : ranked.slice(0, 6);
    bentoPage(page, hero, { titles: true, dots: 0, shade: true });
    var y = appendRankRow(page, ranked, catalogStartY(), rankTitle);
    var rest = withoutItems(all, hero);
    if (rest.length) { appendCatalogGrid(page, rest, y, moreTitle); }
    return true;
  }

  function buildFeaturedPage(page) {
    if (window.XUPER_DESKTOP && buildFeaturedPageDesktop(page)) { return; }
    var all = allVodFor('destacado');
    var items = all.slice(0, 6);
    var real = !!(items[0] && items[0]._portal);
    bentoPage(page, items, { titles: real, dots: real ? 4 : 0, shade: real });
    var rest = all.slice(6);
    if (rest.length) {
      appendCatalogGrid(page, rest, catalogStartY(), 'Títulos destacados');
    }
  }

  function buildMoviesPage(page) {
    if (window.XUPER_DESKTOP &&
        buildRootPageDesktop(page, 'movies', 'pelicula', topMovieItems(), 'Top 10 películas', 'Más películas')) { return; }
    var all = allVodFor('pelicula');
    var items = all.slice(0, 6);
    var real = !!(items[0] && items[0]._portal);
    bentoPage(page, items, { titles: real, dots: real ? 4 : 0, shade: real });
    var rest = all.slice(6);
    if (rest.length) {
      appendCatalogGrid(page, rest, catalogStartY(), 'Más películas');
    }
  }

  function buildSeriesPage(page) {
    if (window.XUPER_DESKTOP &&
        buildRootPageDesktop(page, 'series', 'serie', topSeriesItems(), 'Top 10 series', 'Más series')) { return; }
    var all = allVodFor('serie');
    var items = all.slice(0, 6);
    var real = !!(items[0] && items[0]._portal);
    bentoPage(page, items, { titles: real, dots: real ? 3 : 2, shade: real });
    var rest = all.slice(6);
    if (rest.length) {
      appendCatalogGrid(page, rest, catalogStartY(), 'Más series');
    }
  }

  function buildAnimePage(page) {
    var all = allVodFor('anime');
    var items = all.slice(0, 6);
    var real = !!(items[0] && items[0]._portal);
    bentoPage(page, items, { titles: real, dots: real ? 3 : 2, shade: real });
    var rest = all.slice(6);
    if (rest.length) {
      appendCatalogGrid(page, rest, catalogStartY(), 'Anime y animación');
    }
  }

  function novelCatalogItems() {
    var out = [];
    for (var i = 0; i < VOD.length; i++) {
      var item = VOD[i];
      var text = norm([
        item.row || '', item.category || '', item.kind || '', item.title || '', item.alias || '',
        item.genres && item.genres.join ? item.genres.join(' ') : (item.genres || '')
      ].join(' '));
      if (text.indexOf('novela') !== -1 || text.indexOf('telenovela') !== -1) {
        out.push(item);
      }
    }
    return out;
  }

  function buildNovelsPage(page) {
    /* The portal already includes its novela rows in the loaded home roots.
       Filter those exact records only: no synthetic catalog and no secondary
       query that could return a different host/list.

       Keep the six featured tiles above, but do not remove those titles from
       the catalogue below.  The portal currently delivers ten items in its
       official "Telenovelas" row; slicing at six made "Más novelas" look as
       if the category only had four titles. */
    var all = novelCatalogItems();
    if (!all.length) {
      var empty = el('div', 'catalog-empty', 'No se encontraron novelas en el catálogo actual.');
      abs(empty, 192, 170, 1500, 80);
      page.appendChild(empty);
    } else {
      var items = all.slice(0, 6);
      var real = !!(items[0] && items[0]._portal);
      bentoPage(page, items, { titles: real, dots: real ? 3 : 2, shade: real });
      appendCatalogGrid(page, all, catalogStartY(), 'Más novelas');
    }
  }

  /* KIDS: hero 831x534 + 2x2 grid 413x222 on the right, a subtitle line and a
     horizontal poster row (7 columns, last one clipped by the screen edge). */
  function buildKidsPage(page) {
    var source = vodFor('infantil', 12, 0);
    if (!source.length) { source = VOD; }
    var real = !!(source[0] && source[0]._portal);
    if (window.XUPER_DESKTOP) { buildKidsPageDesktop(page, source, real); return; }
    page.appendChild(makeBento(source[0], 192, 38.5, 831, 534, { shade: true, title: real }));
    var cells = [
      [1029, 38.5], [1446, 38.5], [1029, 269.5], [1446, 269.5]
    ];
    for (var i = 0; i < cells.length; i++) {
      page.appendChild(makeBento(source[(i + 1) % source.length], cells[i][0], cells[i][1],
                                 413, 222, {}));
    }
    page.appendChild(bentoDots(833, 468.5, 4, 0));
    if (source[0]) {
      var sub = el('div', 'kids-subtitle', source[0].tagline || source[0].title);
      abs(sub, 192, 526.5, 1249, 40);
      page.appendChild(sub);
    }
    var row = el('div', 'poster-row');
    abs(row, 192, 578.5, 1920, 310);
    for (var k = 0; k < 7; k++) {
      var it = source[k % source.length];
      if (!it) { break; }
      row.appendChild(makePoster(it, k * 266, 0, 266, 310, { gold: true }));
    }
    page.appendChild(row);
  }

  /* Same grid rules as the other pages: hero + 2x2 tiles, 16 px apart, then
     a row of seven posters that fits inside the right margin. */
  function buildKidsPageDesktop(page, source, real) {
    var g = GRID_GAP, x0 = 192, top = BENTO.bigY;
    var heroW = BENTO.bigW, heroH = BENTO.bigH;
    var cellW = BENTO.smallW, cellH = (heroH - g) / 2;
    page.appendChild(makeBento(source[0], x0, top, heroW, heroH, { shade: true, title: real }));
    var cx = [x0 + heroW + g, x0 + heroW + g + cellW + g];
    var cy = [top, top + cellH + g];
    var n = 1;
    for (var r = 0; r < 2; r++) {
      for (var c = 0; c < 2; c++) {
        page.appendChild(makeBento(source[n % source.length], cx[c], cy[r], cellW, cellH, {}));
        n++;
      }
    }
    page.appendChild(bentoDots(x0 + heroW - 141 - 36, top + heroH - 34, 4, 0));
    var y = top + heroH + 32;
    if (source[0]) {
      var sub = el('div', 'kids-subtitle', 'Para los más pequeños');
      abs(sub, x0, y, 1249, 40);
      page.appendChild(sub);
    }
    y += 50;
    var pw = Math.floor((1664 - g * 6) / 7), ph = Math.round(pw * 1.5);
    var row = el('div', 'poster-row');
    abs(row, x0, y, 1664, ph);
    for (var k = 0; k < 7; k++) {
      var it = source[k % source.length];
      if (!it) { break; }
      row.appendChild(makePoster(it, k * (pw + g), 0, pw, ph, { gold: true }));
    }
    page.appendChild(row);
  }

  /* EXPLORAR: hero 1249x703 + three stacked 413x226 tiles on the right,
     provider row label and logo strip underneath. */
  function buildExplorePage(page) {
    var source = VOD.length ? VOD : [];
    if (window.XUPER_DESKTOP) { buildExplorePageDesktop(page, source); return; }
    page.appendChild(makeBento(source[0], 192, 38.5, 1249, 703, { shade: true }));
    for (var i = 0; i < 3; i++) {
      page.appendChild(makeBento(source[(i + 1) % source.length], 1446, 38.5 + i * 231,
                                 413, 226, { badge: i === 2 ? 'Adult' : '' }));
    }
    page.appendChild(el('div', 'explore-row-title', 'Netflix'));
    var strip = el('div', 'explore-strip');
    abs(strip, 192, 811.5, 1920, 130);
    for (var k = 0; k < 8; k++) {
      var cell = el('div', 'explore-logo');
      abs(cell, k * 272, 0, 260, 120);
      strip.appendChild(cell);
    }
    page.appendChild(strip);
  }

  /* EXPLORAR on desktop: hero + three tiles on the same 16 px grid. The
     provider logo strip had no logos to show, so it is left out. */
  function buildExplorePageDesktop(page, source) {
    if (!source.length) { return; }
    var g = GRID_GAP, x0 = 192, top = BENTO.bigY;
    var sideW = BENTO.smallW, heroW = 1664 - g - sideW, heroH = Math.round(heroW * 9 / 16);
    var tileH = (heroH - g * 2) / 3;
    page.appendChild(makeBento(source[0], x0, top, heroW, heroH, { shade: true, title: true }));
    for (var i = 0; i < 3; i++) {
      page.appendChild(makeBento(source[(i + 1) % source.length], x0 + heroW + g, top + i * (tileH + g),
                                 sideW, tileH, { badge: i === 2 ? 'Adultos' : '' }));
    }
    var rest = source.slice(4);
    if (rest.length) { appendCatalogGrid(page, rest, top + heroH + 48, 'Más para explorar'); }
  }

  /* ============================================================ VOD DETAIL */
  function openDetail(item) {
    /* A video floating in the PiP window keeps playing (and keeps its own
       player state) while the viewer browses other titles. */
    var floating = keepFloatingVideo() && state.playerItem !== item;
    if (!floating) { stopPlayerVideo(); }
    resumeDecidedKey = '';   // a new visit asks "Seguir viendo" again
    resumeCarry = null;      // the point chosen on the previous visit is not reused
    state.detail = item;
    state.streamError = '';
    if (!floating) {
      state.playerMode = 'vod';
    applyModeAspect();
      state.playerItem = item;
      state.playerEpisode = null;
    }
    lastVodAttempt = { phase: 'ficha y capítulos', status: 'cargando', error: '' };
    state.detailReturn = { screen: state.screen, focus: state.focus };
    state.detailRange = 0;
    state.detailSeason = 0;
    state.detailEpisode = null;

    if (item.seasons && item.seasons.length) {
      for (var s = 0; s < item.seasons.length; s++) {
        if (item.seasons[s].id === item.id) {
          state.detailSeason = s;
          break;
        }
      }
    }
    if (item.episodes && item.episodes.length) {
      state.detailEpisode = item.episodes[0];
    }
    applyPendingHistoryEpisode(item);

    /* New title: forget the previous audio/subtitle/rendition choice and ask
       the portal for this one's real tracks (cached for the dialog/panel). */
    if (!floating) {
      resetMediaSelection();
      restoreSmoothMode(item);
    }
    ensureMediaInfo(item);

    buildDetail(item);
    showScreen('detail');

    /* Mostrar reproductor en recuadro mini */
    if (!playerStage) { buildPlayer(); }
    var scrPlayer = $('screen-player');
    if (scrPlayer) {
      scrPlayer.classList.add('is-mini');
      scrPlayer.classList.add('is-active');
    }

    var f = detailButtons ? detailButtons.querySelector('.focusable') : null;
    if (f) { setFocus(f); }

    if (item._detailsLoaded) {
      if (autoPreviewAllowed(item)) { startPlayerVideo(item, state.detailEpisode); }
    } else {
      if (autoPreviewAllowed(item)) { setPlayerStatus('Preparando la reproducción…'); }
      loadVodDetail(item, function (loaded) {
        if (loaded && state.screen === 'detail' && state.detail === loaded) {
          applyPendingHistoryEpisode(loaded);
          if (autoPreviewAllowed(loaded)) { startPlayerVideo(loaded, state.detailEpisode); }
        }
      });
    }
  }

  function toggleSynopsis() {
    var screen = $('screen-detail');
    if (!screen) { return; }
    var open = !screen.classList.contains('is-synopsis-open');
    screen.classList.toggle('is-synopsis-open', open);
    var more = document.querySelector('.detail-more');
    if (more) {
      more.textContent = window.XUPER_DESKTOP ? (open ? '✕  Cerrar' : 'Leer más') : (open ? 'Menos' : 'Más');
    }
  }

  /* Line icons for the desktop detail buttons (currentColor, 24px grid). */
  var DESKTOP_DETAIL_ICONS = {
    fullscreen: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>',
    language: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 11h3M13 11h4M7 15h6M15 15h2"/></svg>',
    favorite: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.1a4.3 4.3 0 0 1 7.5 2.7C19.5 15.4 12 20 12 20z"/></svg>',
    mode: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/></svg>'
  };

  function buildDetail(item) {
    detailLeft = $('detail-left');
    detailPlayer = $('detail-player');
    detailButtons = $('detail-buttons');
    detailBottom = $('detail-bottom');
    clear(detailLeft); clear(detailButtons); clear(detailBottom);

    /* left column: 806px at 80/50 */
    var tw = el('div', 'detail-titlewrap');
    tw.appendChild(el('div', 'detail-title', item.title));
    tw.appendChild(el('div', 'detail-score', item.score));
    detailLeft.appendChild(tw);

    var metaText;
    if (item.country || item.releaseDate || item.tagline) {
      /* mTextTimeType: "country | release date | viewpoint" (reference). */
      var bits = [];
      if (item.country) { bits.push(item.country); }
      if (item.releaseDate) { bits.push(item.releaseDate); }
      if (item.tagline) { bits.push(item.tagline); }
      metaText = bits.join(' | ');
    } else {
      var parts = [];
      if (item.year && item.year !== '—') { parts.push(item.year); }
      if (item.duration && item.duration !== '—') {
        /* The player stores the measured length in seconds ("10868.57"). */
        parts.push(window.XUPER_DESKTOP ? episodeDurationLabel({ duration: item.duration }) : item.duration);
      }
      parts.push('HD');
      metaText = parts.join('  ·  ');
    }
    var metaEl = el('div', 'detail-meta', metaText);
    detailLeft.appendChild(metaEl);
    if (window.XUPER_DESKTOP) {
      /* "Audio: Español · Inglés", or a warning when there is no Spanish. */
      var audioSpan = el('span', 'detail-audio');
      metaEl.appendChild(audioSpan);
      var fillAudio = function (audio) {
        clear(audioSpan);
        var codes = audioCodes(audio).filter(function (c) { return c !== 'und'; });
        if (!codes.length) { return; }
        codes.sort(function (a, b) { return (isSpanishCode(b) ? 1 : 0) - (isSpanishCode(a) ? 1 : 0); });
        audioSpan.appendChild(el('span', 'da-label', 'Audio'));
        var shown = {};
        for (var ac = 0; ac < codes.length; ac++) {
          var name = formatAudioLang(codes[ac]);
          if (shown[name]) { continue; }
          shown[name] = true;
          audioSpan.appendChild(el('span', 'da-chip' + (isSpanishCode(codes[ac]) ? ' is-es' : ''), name));
        }
        if (!audioHasSpanish(audio)) {
          audioSpan.appendChild(audioHasSpanish(subs) ? el('span', 'da-chip is-sub', 'Subtítulos en español')
            : el('span', 'da-chip is-missing', 'Sin español'));
        }
      };
      var startLang = knownLang(item);
      var subs = startLang ? startLang.s : '';
      fillAudio(knownAudio(item));
      requestLang(item, function (lang) {
        if (!lang || state.detail !== item || !audioSpan.isConnected) { return; }
        subs = lang.s;
        fillAudio(lang.a);
      });
    }

    /* mTextUpdate: gold "T10 - E73", series only. The season comes from the
       alias ("... S10") or the season list; the count is the episode total. */
    if (isSeriesItem(item)) {
      var seasonNo = 0;
      var sm = /S(\d+)/i.exec(item.alias || '') || /T(\d+)/i.exec(item.title || '');
      if (sm) { seasonNo = parseInt(sm[1], 10) || 0; }
      if (!seasonNo && item.seasons && item.seasons.length) {
        var curSeason = item.seasons[state.detailSeason] || item.seasons[0];
        seasonNo = (curSeason && curSeason.number) || 1;
      }
      if (!seasonNo) { seasonNo = 1; }
      var epTotal = item.updateCount || item.volumeCount || (item.episodes ? item.episodes.length : 0);
      if (epTotal) {
        detailLeft.appendChild(el('div', 'detail-update', 'T' + seasonNo + ' - E' + epTotal));
      }
    }

    var genres = el('div', 'detail-genres');
    genres.appendChild(el('span', 'label', 'Género : '));
    var genreNames = displayGenres(item.genres);
    for (var g = 0; g < genreNames.length; g++) {
      /* Informational metadata must not take D-pad focus on the detail page. */
      var chip = el('div', 'chip', genreNames[g]);
      genres.appendChild(chip);
    }
    detailLeft.appendChild(genres);

    var desk = !!window.XUPER_DESKTOP;
    function emptyValue(v) { return !v || /^[\s—–\-]*$/.test(String(v)); }

    var dir = el('div', 'detail-row');
    if (desk) { dir.appendChild(el('span', 'row-label', 'Dirección')); }
    else { dir.appendChild(document.createTextNode('Director : ')); }
    var dirV = el('span', 'val', item.director);
    dir.appendChild(dirV);
    if (!(desk && emptyValue(item.director))) { detailLeft.appendChild(dir); }

    var act = el('div', 'detail-row');
    if (desk) { act.appendChild(el('span', 'row-label', 'Reparto')); }
    else { act.appendChild(document.createTextNode('Actors : ')); }
    var actV = el('span', 'val', desk ? String(item.actors || '').replace(/\s*,\s*/g, ', ') : item.actors);
    act.appendChild(actV);
    if (!(desk && emptyValue(item.actors))) { detailLeft.appendChild(act); }

    var syn = el('div', 'detail-synopsis');
    syn.appendChild(el('span', 'label', desk ? 'Sinopsis' : 'Sinopsis : '));
    syn.appendChild(el('div', 'text', item.synopsis));
    /* mTextIntroduction + tvMore: the APK expands the 2-line preview in place.
       Here the expanded block overlays the button row (documented). */
    var more = el('div', 'detail-more focusable', desk ? 'Leer más' : 'Más');
    more._activate = toggleSynopsis;
    syn.appendChild(more);
    detailLeft.appendChild(syn);

    /* player window 765x430 at right 80 / top 50. */
    clear(detailPlayer);
    detailPlayer.classList.add('focusable');
    detailPlayer._activate = function () { expandToFullscreen(item, state.detailEpisode); };
    detailPlayer._onMove = function () { return false; };
    if (window.XUPER_DESKTOP) {
      /* Title artwork while the preview loads (or when there is none),
         instead of an empty black box. Hidden once the video plays. */
      var artSrc = item.landscape || item.poster;
      if (artSrc) {
        var artImg = el('img', 'dp-art');
        artImg.alt = '';
        artImg.onerror = function () { if (this.parentNode) { this.parentNode.removeChild(this); } };
        artImg.src = artSrc;
        detailPlayer.appendChild(artImg);
      }
      detailPlayer.classList.toggle('is-playing', !!(playerVideo && !playerVideo.paused &&
        playerVideo.currentTime > 0 && state.playerItem === item));
    }

    /* buttons 276x68, gap 30 */
    var btnDefs = [
      { icon: 'icon_detail_fullscreen.png', label: 'Pantalla completa', kind: 'fullscreen' },
      { icon: 'icon_detail_subtitle_audio.png', label: 'Idioma', kind: 'language' },
      { icon: 'icon_detail_favorite.png', label: 'Favorito', kind: 'favorite' }
    ];
    /* Desktop: notifications are not implemented, so the button is left out. */
    if (isSeriesItem(item) && !desk) {
      btnDefs.push({ icon: 'icon_detail_subscribe.png', label: 'Notificaciones', kind: 'subscribe' });
    }
    if (desk) {
      btnDefs[0].label = 'Reproducir';
      btnDefs[1].label = 'Idioma y subtítulos';
    }
    for (var b = 0; b < btnDefs.length; b++) {
      var btn = el('div', 'detail-btn focusable');
      btn.setAttribute('data-kind', btnDefs[b].kind);
      if (desk && DESKTOP_DETAIL_ICONS[btnDefs[b].kind]) {
        var svgWrap = el('i', 'detail-btn-icon');
        svgWrap.innerHTML = DESKTOP_DETAIL_ICONS[btnDefs[b].kind];
        btn.appendChild(svgWrap);
      } else {
        var ico = el('img');
        ico.src = 'assets/original/vod/' + btnDefs[b].icon;
        ico.alt = '';
        btn.appendChild(ico);
      }
      btn.appendChild(el('span', null, btnDefs[b].label));
      btn._kind = btnDefs[b].kind;
      if (btnDefs[b].kind === 'favorite' && state.favs[String(item.id)]) {
        btn.classList.add('is-selected');
        btn.querySelector('span').textContent = 'En favoritos';
      }
      if (window.XUPER_DESKTOP && btnDefs[b].kind === 'subscribe') {
        btn.setAttribute('aria-disabled', 'true');
        btn.title = 'Las notificaciones del servicio no están disponibles';
      }
      btn._activate = (function (kind, it) {
        return function () {
          if (kind === 'fullscreen') { expandToFullscreen(it, state.detailEpisode); }
          else if (kind === 'language') { openPlaySettingsDialog(it); }
          else if (kind === 'favorite') {
            var enabled = toggleFavorite(it);
            this.classList.toggle('is-selected', enabled);
            var label = this.querySelector('span');
            if (label) { label.textContent = enabled ? 'En favoritos' : 'Favorito'; }
          } else if (kind === 'subscribe') {
            var img = this.querySelector('img');
            var on = img.src.indexOf('subscribed') === -1;
            img.src = 'assets/original/vod/icon_detail_' + (on ? 'subscribed' : 'subscribe') + '.png';
          }
        };
      })(btnDefs[b].kind, item);
      detailButtons.appendChild(btn);
    }
    var modeBtn = el('div', 'detail-btn focusable');
    modeBtn.setAttribute('data-kind', 'mode');
    if (desk) {
      var modeSvg = el('i', 'detail-btn-icon');
      modeSvg.innerHTML = DESKTOP_DETAIL_ICONS.mode;
      modeBtn.appendChild(modeSvg);
    } else {
      var modeIcon = el('img');
      modeIcon.src = 'assets/original/vod/icon_detail_quality.png';
      modeIcon.alt = '';
      modeBtn.appendChild(modeIcon);
    }
    function modeText() {
      if (desk) { return 'Modo fluido'; }
      return state.streamMode === 'smooth' ? 'Modo fluido: Sí' : 'Modo fluido: No';
    }
    var modeLabel = el('span', null, modeText());
    modeBtn.appendChild(modeLabel);
    if (desk) {
      modeBtn.appendChild(el('i', 'detail-switch'));
      modeBtn.title = 'Convierte el vídeo para mayor compatibilidad (usa más CPU)';
    }
    modeBtn.classList.toggle('is-on', state.streamMode === 'smooth');
    modeBtn._activate = function () {
      setSmoothMode(item, state.streamMode !== 'smooth');
      modeLabel.textContent = modeText();
      modeBtn.classList.toggle('is-on', state.streamMode === 'smooth');
      if (window.XUPER_DESKTOP && state.playerItem === item && playerVideo && playerVideo.currentSrc) restartCurrentPlayback();
    };
    detailButtons.appendChild(modeBtn);

    renderDetailBottom(item);
    refreshDetailResume(item);
  }

  /* "Seguir viendo" on the title page (Desktop).
     When the page opens for a title left half-way, the preview is loaded at
     that minute but kept PAUSED, and a compact notice over it asks first:
     "Continuar desde 9:57" or "Desde el principio".  Once the viewer decides
     (either button, "Reproducir" or a click on the video) the notice is gone
     for this visit: coming back from full screen does not show it again.
     Continuing only un-pauses the preview, so nothing jumps backwards. */
  var RESTART_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4v4.5h4.5"/></svg>';
  var PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>';
  var resumeDecidedKey = '';
  function detailResumeEpisode(item) {
    return state.detailEpisode || (state.playerItem === item ? state.playerEpisode : null);
  }
  /* The saved point still waiting for a decision on this page, or null. */
  function pendingDetailResume(item, episode) {
    if (!window.XUPER_DESKTOP || !item || state.detail !== item) { return null; }
    var point = savedResumePoint(item, episode);
    if (!point || resumeDecidedKey === resumeKey(item, episode)) { return null; }
    return point;
  }
  function decideDetailResume(item, episode, at) {
    resumeDecidedKey = resumeKey(item, episode);
    refreshDetailResume(item);
    expandToFullscreen(item, episode, at);
  }
  function refreshDetailResume(item) {
    if (!window.XUPER_DESKTOP || !detailButtons || !detailPlayer || !item || state.detail !== item) { return; }
    var play = detailButtons.querySelector('.detail-btn[data-kind="fullscreen"]');
    var ep = detailResumeEpisode(item);
    var point = pendingDetailResume(item, ep);
    var label = play && play.querySelector('span');
    var card = detailPlayer.querySelector('.dp-resume');
    if (label) { label.textContent = point ? 'Continuar · ' + shortTime(point.position) : 'Reproducir'; }
    if (play) { play.classList.toggle('is-resume', !!point); }
    detailPlayer.classList.toggle('has-resume', !!point);
    if (!point) {
      if (card) { card.parentNode.removeChild(card); }
      return;
    }
    var pct = point.duration ? Math.max(2, Math.min(100, Math.round(point.position * 100 / point.duration))) : 0;
    var epNum = (ep && (ep.number || ep.seriesNumber)) || point.episodeNumber;
    if (card) { card.parentNode.removeChild(card); }
    card = el('div', 'dp-resume');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Seguir viendo');
    var box = el('div', 'dp-resume-card');
    box.appendChild(el('div', 'dp-resume-kicker', 'Seguir viendo'));
    box.appendChild(el('div', 'dp-resume-where', (epNum ? 'Capítulo ' + epNum + ' · ' : '') +
      'Te quedaste en ' + shortTime(point.position) + (point.duration ? ' de ' + shortTime(point.duration) : '')));
    if (pct) {
      var track = el('i', 'dp-resume-bar');
      var fill = el('b');
      fill.style.width = pct + '%';
      track.appendChild(fill);
      box.appendChild(track);
    }
    var row = el('div', 'dp-resume-actions');
    function action(cls, icon, text, at) {
      var b = el('button', 'dp-resume-btn ' + cls + ' focusable');
      b.type = 'button';
      b.innerHTML = icon;
      b.appendChild(el('span', null, text));
      b._activate = function () { decideDetailResume(item, ep, at); };
      b.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); b._activate(); });
      row.appendChild(b);
      return b;
    }
    action('is-primary', PLAY_ICON, 'Continuar desde ' + shortTime(point.position), point.position);
    action('', RESTART_ICON, 'Desde el principio', 0);
    box.appendChild(row);
    card.appendChild(box);
    // The dimmed area around the card belongs to the notice: no playback from it.
    card.addEventListener('click', function (event) { event.stopPropagation(); });
    detailPlayer.appendChild(card);
  }
  /* Episode ranges are chunks of 20 ("1-20", "21-40", ...) as observed. */
  function detailRanges(count) {
    var out = [];
    for (var s = 0; s < count; s += 20) {
      out.push({ start: s, end: Math.min(count, s + 20) });
    }
    return out;
  }

  function detailSeasonLabel(item) {
    var n = 0;
    if (item.seasons && item.seasons.length > 0) {
      var cur = item.seasons[state.detailSeason] || item.seasons[0];
      n = cur && cur.number ? cur.number : state.detailSeason + 1;
    }
    if (!n) {
      var m = /S(\d+)/i.exec(item.alias || '') || /T(\d+)/i.exec(item.title || '');
      if (m) { n = parseInt(m[1], 10) || 0; }
    }
    return 'Temporada ' + (n || 1);
  }

  function selectDetailRange(index, item) {
    state.detailRange = index;
    buildDetail(item);
    var f = detailBottom.querySelector('.detail-range.is-selected');
    if (f) { setFocus(f); }
  }

  var seasonPopup = null;
  function closeSeasonPopup() {
    if (seasonPopup && seasonPopup.parentNode) {
      seasonPopup.parentNode.removeChild(seasonPopup);
      seasonPopup = null;
    }
    var arrow = detailBottom ? detailBottom.querySelector('.season-arrow') : null;
    if (arrow) { arrow.classList.remove('is-open'); }
  }

  function toggleSeasonPopup(anchorBtn, item) {
    if (seasonPopup) {
      closeSeasonPopup();
      return;
    }
    if (!item.seasons || item.seasons.length < 2) { return; }

    var arrow = anchorBtn.querySelector('.season-arrow');
    if (arrow) { arrow.classList.add('is-open'); }

    seasonPopup = el('div', 'season-popup');
    if (window.XUPER_DESKTOP) {
      /* Flow layout: open right under the season button. */
      /* Many seasons (Anatomía según Grey has 22): a compact grid of numbers
         so they all fit without scrolling. */
      var gridMode = item.seasons.length > 6;
      if (gridMode) { seasonPopup.classList.add('is-grid'); }
      abs(seasonPopup, anchorBtn.offsetLeft, anchorBtn.offsetTop + anchorBtn.offsetHeight + 8,
        gridMode ? Math.min(6, item.seasons.length) * 62 + 28 : Math.max(260, anchorBtn.offsetWidth));
      seasonPopup.style.maxHeight = gridMode ? 'none' : '360px';
    } else {
      abs(seasonPopup, 80, 100, 280, Math.min(320, item.seasons.length * 54));
    }

    for (var s = 0; s < item.seasons.length; s++) {
      (function (sIndex) {
        var sData = item.seasons[sIndex];
        var isSelected = sIndex === state.detailSeason;
        var pItem = el('div', 'season-popup-item focusable' + (isSelected ? ' is-selected' : ''));
        var sText = 'Temporada ' + (sData.number || (sIndex + 1));
        var compact = window.XUPER_DESKTOP && item.seasons.length > 6;
        pItem.appendChild(el('span', 'season-item-text', compact ? String(sData.number || (sIndex + 1)) : sText));
        if (compact) { pItem.title = sText; }

        var check = el('img', 'season-item-check');
        check.src = 'assets/original/vod/icon_nation_selected.png';
        check.alt = '';
        pItem.appendChild(check);

        pItem._activate = function () {
          closeSeasonPopup();
          if (state.detailSeason !== sIndex) {
            state.detailSeason = sIndex;
            state.detailRange = 0;
            state.detailEpisode = null;
            var targetSeason = item.seasons[sIndex];
            if (targetSeason && targetSeason.id) {
              setPlayerStatus('Cargando temporada…');
              portalServiceCall('detail', { contentId: targetSeason.id }, function (err, payload) {
                if (!err && payload && payload.returnValue !== false) {
                  if (payload.item) { mergeDetail(item, payload.item); }
                  item.episodes = payload.episodes || [];
                  item.seasonId = targetSeason.id;
                  targetSeason._episodes = item.episodes;
                  state.detailEpisode = item.episodes[0] || null;
                }
                buildDetail(item);
                if (state.detailEpisode) {
                  startPlayerVideo(item, state.detailEpisode);
                }
                var sBtn = detailBottom ? detailBottom.querySelector('.detail-season') : null;
                if (sBtn) { setFocus(sBtn); }
              });
            }
          } else {
            var sBtn2 = detailBottom ? detailBottom.querySelector('.detail-season') : null;
            if (sBtn2) { setFocus(sBtn2); }
          }
        };

        seasonPopup.appendChild(pItem);
      })(s);
    }

    detailBottom.appendChild(seasonPopup);
    var focusedChild = seasonPopup.children[state.detailSeason] || seasonPopup.children[0];
    /* Desktop: focus without scrolling the page. Revealing the current
       season pushed the whole "Episodios" section out of view. */
    if (focusedChild) { setFocus(focusedChild, !!window.XUPER_DESKTOP); }
  }

  /* Desktop layout: one scrollable column (episodes, then related titles)
     laid out by CSS instead of fixed TV coordinates. */
  function renderDetailBottomDesktop(item) {
    var episodes = (isSeriesItem(item) && item.episodes) ? item.episodes : [];
    var ranges = detailRanges(episodes.length);
    if (state.detailRange >= ranges.length) { state.detailRange = 0; }
    detailBottom.classList.add('scrollable', 'dd-flow');

    if (isSeriesItem(item)) {
      var epSection = el('section', 'dd-section');
      var head = el('div', 'dd-head');
      head.appendChild(el('h2', 'dd-title', 'Episodios'));

      var seasonBtn = el('div', 'detail-season focusable');
      seasonBtn.appendChild(el('span', 'season-text', detailSeasonLabel(item)));
      var multi = item.seasons && item.seasons.length > 1;
      if (multi) {
        var arrow = el('i', 'season-arrow');
        arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
        seasonBtn.appendChild(arrow);
      } else {
        seasonBtn.classList.add('is-single');
      }
      seasonBtn._activate = function () {
        if (!multi) { return; }
        toggleSeasonPopup(seasonBtn, item);
      };
      head.appendChild(seasonBtn);
      if (episodes.length) {
        head.appendChild(el('span', 'dd-count', episodes.length + (episodes.length === 1 ? ' episodio' : ' episodios')));
      }
      epSection.appendChild(head);

      if (episodes.length > 20) {
        var rangeRow = el('div', 'detail-ranges dd-ranges');
        for (var i = 0; i < ranges.length; i++) {
          (function (idx) {
            var tab = el('div', 'detail-range focusable' + (idx === state.detailRange ? ' is-selected' : ''),
                         (ranges[idx].start + 1) + '–' + ranges[idx].end);
            tab._activate = function () { selectDetailRange(idx, item); };
            rangeRow.appendChild(tab);
          })(i);
        }
        epSection.appendChild(rangeRow);
      }

      if (episodes.length) {
        var current = ranges[state.detailRange] || { start: 0, end: episodes.length };
        var grid = el('div', 'detail-episodes dd-grid');
        for (var e = current.start; e < current.end; e++) {
          (function (ep, index) {
            var isPlaying = state.detailEpisode && (state.detailEpisode.id === ep.id || state.detailEpisode === ep);
            var tile = el('div', 'detail-episode focusable' + (isPlaying ? ' is-playing' : ''));
            var numText = (ep.number !== undefined && ep.number !== null) ? String(ep.number) : String(index + 1);
            tile.appendChild(el('span', 'ep-num', numText));
            var info = el('span', 'ep-info');
            var title = episodeDisplayTitle(item, ep, index);
            /* "Episodio 7" only repeats the big number: leave it out. */
            if (title !== 'Episodio ' + numText) {
              info.appendChild(el('span', 'ep-title', title));
            } else {
              tile.classList.add('is-generic');
            }
            var dur = episodeDurationLabel(ep);
            var metaBits = [];
            if (dur) { metaBits.push(dur); }
            var lang = episodeLangTag(ep);
            if (lang) { metaBits.push(lang); }
            info.appendChild(el('span', 'ep-meta', metaBits.join(' · ')));
            info.appendChild(el('span', 'ep-now', 'Viendo'));
            tile.appendChild(info);
            var play = el('i', 'ep-play');
            play.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
            tile.appendChild(play);
            tile.title = 'Episodio ' + numText + (title && title !== 'Episodio ' + numText ? ' · ' + title : '');
            tile._ep = ep;
            tile._activate = function () { playEpisode(item, ep); };
            grid.appendChild(tile);
          })(episodes[e], e);
        }
        epSection.appendChild(grid);
      } else {
        epSection.appendChild(el('div', 'dd-empty', 'Cargando episodios…'));
      }
      detailBottom.appendChild(epSection);
    }

    var relSection = el('section', 'dd-section');
    relSection.appendChild(el('h2', 'dd-title detail-related', 'Quizás te guste'));
    var rel = el('div', 'detail-grid dd-related');
    var seed = parseInt(item.id, 10);
    if (isNaN(seed)) {
      seed = 0;
      for (var s = 0; s < VOD.length; s++) { if (VOD[s] === item) { seed = s; break; } }
    }
    var start = (seed * 3) % Math.max(1, VOD.length - 6);
    for (var r = 0; r < 8; r++) {
      var relItem = VOD[(start + r) % VOD.length];
      if (!relItem) { continue; }
      var cell = el('div', 'cell');
      cell.appendChild(makePoster(relItem, 0, 0, 190, 279, { gold: true }));
      cell.appendChild(el('div', 'd-name', relItem.title));
      rel.appendChild(cell);
    }
    relSection.appendChild(rel);
    detailBottom.appendChild(relSection);
  }

  function renderDetailBottom(item) {
    if (window.XUPER_DESKTOP) { return renderDetailBottomDesktop(item); }
    var episodes = (isSeriesItem(item) && item.episodes) ? item.episodes : [];
    var hasEpisodes = episodes.length > 0;
    var ranges = detailRanges(episodes.length);
    if (state.detailRange >= ranges.length) { state.detailRange = 0; }

    /* Season dropdown button (flChoose / llSeanson) */
    if (isSeriesItem(item)) {
      var seasonBtn = el('div', 'detail-season focusable');
      abs(seasonBtn, 80, 42, 280, 53);
      seasonBtn.appendChild(el('span', 'season-text', detailSeasonLabel(item)));
      var arrow = el('img', 'season-arrow');
      arrow.src = 'assets/original/vod/ic_down_icon.png';
      arrow.alt = '▼';
      seasonBtn.appendChild(arrow);
      seasonBtn._activate = function () {
        if (!item.seasons || item.seasons.length < 2) { return; }
        toggleSeasonPopup(seasonBtn, item);
      };
      detailBottom.appendChild(seasonBtn);
    }

    /* Range tabs (1-20, 21-40...) */
    if (hasEpisodes && episodes.length > 20) {
      var rangeRow = el('div', 'detail-ranges');
      abs(rangeRow, 398, 51, 1522, 46);
      for (var i = 0; i < ranges.length; i++) {
        (function (idx) {
          var tab = el('div', 'detail-range focusable' + (idx === state.detailRange ? ' is-selected' : ''),
                       (ranges[idx].start + 1) + '-' + ranges[idx].end);
          abs(tab, idx * 160, 0, 150, 46);
          tab._activate = function () { selectDetailRange(idx, item); };
          rangeRow.appendChild(tab);
        })(i);
      }
      detailBottom.appendChild(rangeRow);
    }

    /* Episode grid */
    if (hasEpisodes) {
      var current = ranges[state.detailRange] || { start: 0, end: episodes.length };
      var row = el('div', 'detail-episodes scrollable');
      abs(row, 80, 149, 1840, 65);
      for (var e = current.start; e < current.end; e++) {
        (function (ep, index) {
          var isPlaying = state.detailEpisode && (state.detailEpisode.id === ep.id || state.detailEpisode === ep);
          var tile = el('div', 'detail-episode focusable' + (isPlaying ? ' is-playing' : ''));
          abs(tile, index * 160, 0, 150, 65);
          var numText = (ep.number !== undefined && ep.number !== null) ? String(ep.number) : String(e + 1);
          tile.appendChild(el('span', 'ep-num', numText));
          tile._ep = ep;
          tile._activate = function () {
            playEpisode(item, ep);
          };
          row.appendChild(tile);
        })(episodes[e], e - current.start);
      }
      detailBottom.appendChild(row);
    }

    /* mTextRelated + mGridRelated. The series layout pushes them below the
       episode selector, so the poster row is clipped by the screen edge. */
    var relatedTop = hasEpisodes ? 240 : 25;
    var gridTop = hasEpisodes ? 290 : 91;
    var heading = el('div', 'detail-related', 'Quizás te guste');
    abs(heading, 80, relatedTop, 400, 44);
    detailBottom.appendChild(heading);

    var grid = el('div', 'detail-grid scrollable');
    abs(grid, 80, gridTop, 1750, hasEpisodes ? 180 : 380);
    var seed = parseInt(item.id, 10);
    if (isNaN(seed)) {
      seed = 0;
      for (var s = 0; s < VOD.length; s++) { if (VOD[s] === item) { seed = s; break; } }
    }
    var start = (seed * 3) % Math.max(1, VOD.length - 6);
    for (var r = 0; r < 8; r++) {
      var rel = VOD[(start + r) % VOD.length];
      if (!rel) { continue; }
      var cell = el('div', 'cell');
      cell.appendChild(makePoster(rel, 0, 0, 210, 308, { gold: true }));
      cell.appendChild(el('div', 'd-name', rel.title));
      grid.appendChild(cell);
    }
    detailBottom.appendChild(grid);
  }

  /* ================================================================ SEARCH */
  function hotSearches() {
    var all = bundledCatalog();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var cat = String((all[i] && all[i].category) || '').toLowerCase();
      if (cat.indexOf('busqueda') !== -1) { out.push(normalizeVod(all[i], i + 1)); }
    }
    return out;
  }

  function buildSearch() {
    searchKeyboard = $('search-keyboard');
    searchHot = $('search-hot');
    searchResults = $('search-results');
    searchEmpty = $('search-empty');
    searchHotGrid = $('search-hot-grid');
    searchResultGrid = $('search-result-grid');
    searchNav = $('search-nav');
    clear(searchKeyboard); clear(searchHotGrid); clear(searchResultGrid);
    /* Result rows can extend beyond the first screen.  Mark their viewport as
       scrollable so reveal() follows D-pad focus down through every result. */
    if (searchResults) { searchResults.classList.add('scrollable'); }
    if (window.XUPER_DESKTOP && searchResults && !searchStateBox) {
      /* Centered state (Buscando… / error) and a small line under the counter. */
      searchStateBox = el('div', 'search-state');
      searchResults.appendChild(searchStateBox);
      searchInlineState = el('div', 'search-inline-state');
      searchResults.appendChild(searchInlineState);
    }

    /* --- keyboard panel (layout_search_keybord_full_uni) --- */
    searchInput = el(window.XUPER_DESKTOP ? 'input' : 'div', 'kb-edit focusable');
    if (window.XUPER_DESKTOP) {
      searchInput.type = 'search';
      searchInput.id = 'desktop-search-input';
      searchInput.placeholder = 'Buscar películas o series';
      searchInput.setAttribute('aria-label', 'Buscar películas o series');
      searchInput.autocomplete = 'off';
      searchInput.addEventListener('input', function (event) {
        if (!event.isComposing) setSearchQuery(searchInput.value);
      });
      searchInput.addEventListener('compositionend', function () { setSearchQuery(searchInput.value); });
      searchInput.addEventListener('keydown', function (event) {
        if (event.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); runSearch(); }
        if (event.key === 'Escape') { searchInput.blur(); back(); }
        event.stopPropagation();
      });
      searchInput._activate = function () { searchInput.focus(); };
    } else {
      searchInput._activate = function () { /* TV keyboard field */ };
    }
    searchKeyboard.appendChild(searchInput);

    var actions = el('div', 'kb-actions');
    var actionDefs = [
      { cls: 'switch', w: 100.5 },
      { cls: 'clear', w: 100.5 },
      { cls: 'del', w: 100.5 },
      { cls: 'go', w: 120 }
    ];
    for (var a = 0; a < actionDefs.length; a++) {
      var act = el('div', 'kb-action focusable ' + actionDefs[a].cls);
      act.style.width = actionDefs[a].w + 'px';
      if (actionDefs[a].cls === 'go') {
        act.textContent = 'Busca';
      } else {
        act.appendChild(el('div', 'ico'));
      }
      act._kind = actionDefs[a].cls;
      act._activate = (function (kind) {
        return function () {
          if (kind === 'switch') { toggleSearchNumeric(); }
          else if (kind === 'clear') { setSearchQuery(''); }
          else if (kind === 'del') { setSearchQuery(state.searchQuery.slice(0, -1)); }
          else { runSearch(); }
        };
      })(actionDefs[a].cls);
      actions.appendChild(act);
    }
    searchKeyboard.appendChild(actions);

    searchKeys = [];
    var rows = [
      ['A', 'Á', 'B', 'C', 'D', 'E', 'É'],
      ['F', 'G', 'H', 'I', 'Í', 'J', 'K'],
      ['L', 'M', 'N', 'Ñ', 'O', 'Ó', 'P'],
      ['Q', 'R', 'S', 'T', 'U', 'Ú', 'Ü'],
      ['V', 'W', 'X', 'Y', 'Z', ' ']
    ];
    for (var r = 0; r < rows.length; r++) {
      var row = el('div', 'kb-row');
      row.style.top = (264 + r * 88.5) + 'px';
      for (var c = 0; c < rows[r].length; c++) {
        var key = el('div', 'kb-key focusable' + (rows[r][c] === ' ' ? ' space' : ''),
          rows[r][c] === ' ' ? '' : rows[r][c]);
        key._char = rows[r][c];
        key._activate = (function (ch) {
          return function () { setSearchQuery(state.searchQuery + ch); };
        })(rows[r][c]);
        row.appendChild(key);
        searchKeys.push(key);
      }
      searchKeyboard.appendChild(row);
    }

    var feedback = el('div', 'kb-feedback focusable', 'Diagnóstico');
    feedback._activate = openDesktopDiagnostic;
    searchKeyboard.appendChild(feedback);

    /* --- hot search grid (observed "Búsqueda popular", 10 portrait cells) --- */
    renderPopularSearch();

    searchResults.classList.remove('is-active');
    searchEmpty.classList.remove('is-active');
    searchHot.classList.remove('is-hidden');
    updateSearchInput();
    applySearchKeyboardPref();
  }

  /* Columns of the poster grid: 5 next to the search box; the full-width
     "Filtrar" page fits as many as the 1920 px canvas allows. */
  function searchGridColumns() {
    return (filterPageOpen() || !searchKeyboardShown()) ? 7 : 5;
  }

  /* On-screen A–Z keyboard of the search (from the TV version).  On a PC the
     physical keyboard types into the box, so "Automático" shows it only on
     touch screens; "Mostrar" / "Ocultar" force it (Configuración global). */
  function searchKeyboardShown() {
    if (!window.XUPER_DESKTOP) { return true; }
    var pref = Number(state.playback.searchKeyboard) || 0;
    if (pref === 1) { return true; }
    if (pref === 2) { return false; }
    var touch = false;
    try {
      touch = (navigator.maxTouchPoints || 0) > 0 ||
        !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch (eTouch) { touch = false; }
    return touch;
  }
  function applySearchKeyboardPref() {
    var scr = $('screen-search');
    if (!scr || !window.XUPER_DESKTOP) { return; }
    var hide = !searchKeyboardShown();
    if (scr.classList.contains('kb-hidden') === hide) { return; }
    scr.classList.toggle('kb-hidden', hide);
    // The poster grid changes its number of columns.
    if (searchHotGrid && !state.searchQuery) { renderPopularSearch(); }
  }
  function filterPageOpen() {
    var scr = $('screen-search');
    return !!(window.XUPER_DESKTOP && scr && scr.classList.contains('is-filter-page'));
  }

  function makeSearchCell(item, index) {
    var cell = el('div', 'search-cell');
    var cols = searchGridColumns();
    abs(cell, (index % cols) * 246, Math.floor(index / cols) * 437, 246, 437);
    cell.appendChild(makePoster(item, 0, 0, 222, 329, { gold: true }));
    cell.appendChild(el('div', 's-name', item.title));
    return cell;
  }

  /* The catalogue filter as its own page (header "Filtrar" button): the
     search box is hidden and the filter uses the whole width. */
  function openFilter() {
    if (!searchKeyboard) { buildSearch(); }
    clearSearchState();
    var scr = $('screen-search');
    if (scr) { scr.classList.add('is-filter-page'); }
    for (var v = 0; v < HOT_VIEWS.length; v++) { if (HOT_VIEWS[v].key === 'filter') { hotView = v; } }
    showScreen('search');
    renderPopularSearch();
    var first = filterPanel && (filterPanel.querySelector('.filter-chip.is-selected') || filterPanel.querySelector('.filter-chip'));
    if (first) { setFocus(first, true); }
    if (searchHot) { searchHot.scrollTop = 0; }
  }
  function closeFilterPage() {
    var scr = $('screen-search');
    if (scr && scr.classList.contains('is-filter-page')) {
      scr.classList.remove('is-filter-page');
      // The search box opens on its usual first view afterwards.
      if (HOT_VIEWS[hotView] && HOT_VIEWS[hotView].key === 'filter') { hotView = 0; }
    }
  }

  function openSearch() {
    if (!searchKeyboard) { buildSearch(); }
    closeFilterPage();   // coming from the "Filtrar" page: usual search view
    applySearchKeyboardPref();
    showScreen('search');
    if (!state.searchQuery) { renderPopularSearch(); }
    setFocus(searchInput);
    if (window.XUPER_DESKTOP) searchInput.focus();
  }

  function popularSearchItems() {
    var featured = allVodFor('destacado');
    var out = featured && featured.length ? featured.slice(0, 10) : [];
    if (!out.length) { out = hotSearches(); }
    if (!out.length) { out = VOD.slice(0, 10); }
    return out;
  }

  /* Titles of the portal rows that pass `test(root, name)`, in portal order,
     without repeats. Before the first catalogue refresh only the single
     `row` each merged title kept is known, which is still a fair fallback. */
  function portalRowItems(test) {
    var byId = {}, out = [], seen = {}, i, j;
    for (i = 0; i < VOD.length; i++) { byId[String(VOD[i].id)] = VOD[i]; }
    function add(id) {
      var it = byId[String(id)];
      if (it && !seen[it.id]) { seen[it.id] = true; out.push(it); }
    }
    if (portalRows.length) {
      for (i = 0; i < portalRows.length; i++) {
        if (test(portalRows[i].root, portalRows[i].name)) {
          for (j = 0; j < portalRows[i].ids.length; j++) { add(portalRows[i].ids[j]); }
        }
      }
    } else {
      for (i = 0; i < VOD.length; i++) { if (VOD[i].row && test('', VOD[i].row)) { add(VOD[i].id); } }
    }
    return out;
  }

  function isTopRow(name) { return /top\s*\d+/i.test(name); }
  function isMovieRow(name) { return /pel[ií]cula|movie/i.test(name); }

  /* Newest year that has its own row ("2026", "2026 Peliculas teatrales"). */
  function premiereYear() {
    var now = new Date().getFullYear();
    for (var y = now; y >= now - 1; y--) {
      var re = new RegExp('^\\s*' + y + '(?:\\b|$)');
      var found = portalRowItems(function (root, name) { return re.test(name); });
      if (found.length) { return { year: y, items: found }; }
    }
    return { year: now, items: [] };
  }

  /* The three views of the search screen. The portal has no "popular
     searches" service; its real rankings are the TOP15 rows of Destacados. */
  var HOT_VIEWS = [
    { key: 'movies', tab: 'Top películas', title: 'Películas más vistas' },
    { key: 'series', tab: 'Top series', title: 'Series más vistas' },
    { key: 'new', tab: 'Estrenos', title: 'Estrenos' },
    { key: 'filter', tab: 'Filtrar', title: 'Filtrar catálogo' }
  ];
  var hotView = 0;

  function hotViewItems(key) {
    if (key === 'movies') { return topMovieItems(); }
    if (key === 'series') { return topSeriesItems(); }
    if (key === 'filter') { return filteredItems().items; }
    var premiere = premiereYear();
    /* Most recently placed first (shelveTime "YYYY-MM-DD hh:mm:ss"). */
    var sorted = premiere.items.slice().sort(function (a, b) {
      return String(b.shelveTime || '').localeCompare(String(a.shelveTime || ''));
    });
    return spanishSorted(sorted.slice(0, 30));
  }

  function hotViewTitle(view) {
    return view.key === 'new' ? 'Estrenos ' + premiereYear().year : view.title;
  }

  function buildHotTabs() {
    if (!searchHot || searchHot._tabs) { return; }
    var refresh = searchHot.querySelector('.search-hot-refresh');
    if (!window.XUPER_DESKTOP) {
      /* TV layout keeps its single pill: it now steps through the views. */
      if (refresh) {
        refresh.classList.add('focusable');
        refresh._activate = function () {
          hotView = (hotView + 1) % HOT_VIEWS.length;
          renderPopularSearch();
        };
      }
      searchHot._tabs = [];
      return;
    }
    if (refresh) { refresh.style.display = 'none'; }
    searchHot.classList.add('scrollable');
    /* Posters load only when visible: tell the loader when the list moves. */
    searchHot.addEventListener('scroll', schedulePosterMemoryPass, { passive: true });
    var bar = el('div', 'hot-tabs');
    bar.setAttribute('role', 'tablist');
    searchHot._tabs = [];
    for (var v = 0; v < HOT_VIEWS.length; v++) {
      var tab = el('div', 'hot-tab focusable', HOT_VIEWS[v].tab);
      tab.setAttribute('role', 'tab');
      tab._activate = (function (index) {
        return function () { hotView = index; renderPopularSearch(); };
      })(v);
      bar.appendChild(tab);
      searchHot._tabs.push(tab);
    }
    searchHot.insertBefore(bar, searchHotGrid);
  }

  /* ------------------------------------------------ catalogue filter (Filtrar)
     Works on the titles the catalogue already loaded. The portal sends no
     release year in its lists, so "Agregado" uses shelveTime (upload date). */
  var GENRE_ES = {
    'action': 'Acción', 'accion': 'Acción', 'adventure': 'Aventura', 'aventura': 'Aventura',
    'animation': 'Animación', 'animacion': 'Animación', 'cartoon': 'Animación', 'anime': 'Anime',
    'comedy': 'Comedia', 'comedia': 'Comedia', 'crime': 'Crimen', 'documentary': 'Documental',
    'drama': 'Drama', 'family': 'Familiar', 'familiar': 'Familiar', 'fantasy': 'Fantasía', 'fantasia': 'Fantasía',
    'horror': 'Terror', 'terror': 'Terror', 'mystery': 'Misterio', 'romance': 'Romance',
    'sci-fi': 'Ciencia ficción', 'science fiction': 'Ciencia ficción', 'ciencia ficcion': 'Ciencia ficción',
    'thriller': 'Suspenso', 'war': 'Bélica', 'guerra': 'Bélica', 'western': 'Western', 'history': 'Historia',
    'biography': 'Biografía', 'music': 'Música', 'musical': 'Música', 'sport': 'Deportes',
    'reality-tv': 'Reality', 'game show': 'Reality'
  };
  var FILTER_ROWS = [
    { key: 'type', label: 'Tipo', options: [['all', 'Todo'], ['movie', 'Películas'], ['series', 'Series']] },
    { key: 'genre', label: 'Género', options: null },
    { key: 'added', label: 'Agregado', options: [[0, 'Cualquier fecha'], [7, 'Últimos 7 días'], [30, 'Últimos 30 días'], [90, 'Últimos 90 días']] },
    { key: 'lang', label: 'Idioma', options: [['any', 'Cualquiera'], ['audio', 'Audio español'], ['spanish', 'Audio o subtítulos español']] },
    { key: 'sort', label: 'Orden', options: [['recent', 'Recientes'], ['score', 'Puntuación'], ['az', 'A-Z']] }
  ];
  var filterState = { type: 'all', genre: '', added: 0, lang: 'any', sort: 'recent' };
  var filterPanel = null;
  var filterRedrawTimer = null;
  var FILTER_LANG_ASK = 60; /* unknown languages asked per pass */

  function itemGenresEs(item) {
    var out = [], gs = item.genres || [];
    for (var i = 0; i < gs.length; i++) {
      var g = GENRE_ES[norm(String(gs[i]).trim())];
      if (g && out.indexOf(g) === -1) { out.push(g); }
    }
    return out;
  }

  /* Catalogue titles the filter works on: portal titles, no trailers. */
  function filterPool() {
    var portal = [], all = [], i;
    for (i = 0; i < VOD.length; i++) {
      if (VOD[i].type === 'trailer') { continue; }
      all.push(VOD[i]);
      if (VOD[i]._portal || VOD[i].portal) { portal.push(VOD[i]); }
    }
    return portal.length ? portal : all;
  }

  /* Genres present in the catalogue, most common first (3 titles or more). */
  function filterGenres(pool) {
    var count = {}, i, j;
    for (i = 0; i < pool.length; i++) {
      var gs = itemGenresEs(pool[i]);
      for (j = 0; j < gs.length; j++) { count[gs[j]] = (count[gs[j]] || 0) + 1; }
    }
    return Object.keys(count).filter(function (g) { return count[g] >= 3; })
      .sort(function (a, b) { return count[b] - count[a] || a.localeCompare(b); });
  }

  function shelveMs(item) {
    var t = Date.parse(String(item.shelveTime || '').replace(' ', 'T'));
    return isNaN(t) ? 0 : t;
  }

  /* {items, pending}: titles that pass every filter, in the chosen order;
     `pending` lists titles whose language is not known yet. */
  function filteredItems() {
    var pool = filterPool(), out = [], pending = [], f = filterState;
    var since = f.added ? Date.now() - f.added * 86400000 : 0;
    for (var i = 0; i < pool.length; i++) {
      var it = pool[i];
      var series = isSeriesItem(it);
      if (f.type === 'movie' && series) { continue; }
      if (f.type === 'series' && !series) { continue; }
      if (f.genre && itemGenresEs(it).indexOf(f.genre) === -1) { continue; }
      if (since && shelveMs(it) < since) { continue; }
      if (f.lang !== 'any') {
        var lang = knownLang(it);
        if (!lang) { pending.push(it); continue; }
        var rank = langRank(lang);
        if (rank > (f.lang === 'audio' ? 0 : 1)) { continue; }
      }
      out.push(it);
    }
    var withIndex = out.map(function (it, n) { return { it: it, n: n }; });
    withIndex.sort(function (a, b) {
      var d = 0;
      if (f.sort === 'recent') { d = shelveMs(b.it) - shelveMs(a.it); }
      else if (f.sort === 'score') { d = (parseFloat(b.it.score) || 0) - (parseFloat(a.it.score) || 0); }
      else { d = String(a.it.title || '').localeCompare(String(b.it.title || ''), 'es', { sensitivity: 'base' }); }
      return d || a.n - b.n;
    });
    out = withIndex.map(function (x) { return x.it; });
    /* "Cualquiera" still puts Spanish first when "Priorizar español" is on. */
    if (f.lang === 'any') { out = spanishSorted(out); }
    return { items: out, pending: pending };
  }

  function buildFilterPanel() {
    if (filterPanel) { return; }
    filterPanel = el('div', 'filter-panel');
    searchHot.insertBefore(filterPanel, searchHotGrid);
  }

  function renderFilterChips() {
    clear(filterPanel);
    var genres = filterGenres(filterPool());
    if (filterState.genre && genres.indexOf(filterState.genre) === -1) { filterState.genre = ''; }
    for (var r = 0; r < FILTER_ROWS.length; r++) {
      var def = FILTER_ROWS[r];
      var options = def.options;
      if (def.key === 'genre') {
        options = [['', 'Todos']].concat(genres.map(function (g) { return [g, g]; }));
      }
      var row = el('div', 'filter-row');
      row.appendChild(el('div', 'filter-label', def.label));
      var chips = el('div', 'filter-chips');
      for (var o = 0; o < options.length; o++) {
        var on = filterState[def.key] === options[o][0];
        var chip = el('div', 'filter-chip focusable' + (on ? ' is-selected' : ''), options[o][1]);
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-checked', on ? 'true' : 'false');
        chip._activate = (function (key, value) {
          return function () {
            if (filterState[key] === value) { return; }
            filterState[key] = value;
            renderFilterView(key + ':' + value);
          };
        })(def.key, options[o][0]);
        chips.appendChild(chip);
      }
      row.appendChild(chips);
      filterPanel.appendChild(row);
    }
    filterPanel.appendChild(el('div', 'filter-status'));
  }

  /* Redraws the chips and the grid. `focusKey` ("type:movie") puts the focus
     back on the chip that was just chosen. */
  function renderFilterView(focusKey) {
    buildFilterPanel();
    filterPanel.style.display = '';
    var keepScroll = searchHot.scrollTop;
    var focusId = state.focus && state.focus._item && searchHotGrid.contains(state.focus) ? state.focus._item.id : null;
    renderFilterChips();
    var result = filteredItems();
    var items = result.items;
    clear(searchHotGrid);
    for (var h = 0; h < items.length; h++) {
      var cell = makeSearchCell(items[h], h);
      var poster = cell.querySelector('.poster');
      if (poster) { setAudioTag(poster, knownLang(items[h])); }
      searchHotGrid.appendChild(cell);
    }
    var totalNode = searchHot.querySelector('.search-hot-total span');
    if (totalNode) { totalNode.textContent = String(items.length); }
    var status = filterPanel.querySelector('.filter-status');
    if (result.pending.length) {
      status.textContent = 'Comprobando el idioma de ' + result.pending.length + ' títulos… los resultados irán apareciendo.';
    } else if (!items.length) {
      status.textContent = 'Ningún título cumple estos filtros. Prueba a quitar alguno.';
    } else {
      status.textContent = '';
    }
    /* The grid starts under the panel, whatever its height. */
    searchHotGrid.style.top = (filterPanel.offsetTop + filterPanel.offsetHeight + 24) + 'px';
    searchHotGrid.style.height = (Math.ceil(items.length / searchGridColumns()) * 437) + 'px';
    searchHot.scrollTop = focusKey ? 0 : keepScroll;
    askFilterLanguages(result.pending, items);
    schedulePosterMemoryPass();
    if (focusKey) {
      var parts = focusKey.split(':');
      var rowIndex = -1;
      for (var r = 0; r < FILTER_ROWS.length; r++) { if (FILTER_ROWS[r].key === parts[0]) { rowIndex = r; } }
      var rowEl = filterPanel.querySelectorAll('.filter-row')[rowIndex];
      var sel = rowEl && rowEl.querySelector('.filter-chip.is-selected');
      if (sel) { setFocus(sel, true); }
    } else if (focusId) {
      var cells = searchHotGrid.querySelectorAll('.poster');
      for (var c = 0; c < cells.length; c++) {
        if (cells[c]._item && cells[c]._item.id === focusId) { setFocus(cells[c], true); break; }
      }
    }
  }

  /* Languages are asked in small passes; each answer refreshes the view. */
  function askFilterLanguages(pending, shown) {
    var ask = pending.slice(0, FILTER_LANG_ASK);
    /* Tags for the first visible cards too. */
    for (var s = 0; s < shown.length && s < 40; s++) { if (!knownLang(shown[s])) { ask.push(shown[s]); } }
    for (var i = 0; i < ask.length; i++) {
      (function (item) {
        requestLang(item, function () {
          if (state.screen !== 'search' || HOT_VIEWS[hotView].key !== 'filter' || state.searchQuery) { return; }
          if (filterRedrawTimer) { return; }
          filterRedrawTimer = setTimeout(function () {
            filterRedrawTimer = null;
            if (state.screen === 'search' && HOT_VIEWS[hotView].key === 'filter' && !state.searchQuery) { renderFilterView(); }
          }, 700);
        });
      })(ask[i]);
    }
  }

  function renderPopularSearch() {
    if (!searchHotGrid || state.searchQuery) { return; }
    buildHotTabs();
    var view = HOT_VIEWS[hotView];
    if (view.key === 'filter' && window.XUPER_DESKTOP) {
      var tn = searchHot.querySelector('.search-hot-title');
      if (tn) { tn.textContent = view.title; }
      for (var ft = 0; ft < searchHot._tabs.length; ft++) {
        searchHot._tabs[ft].classList.toggle('is-selected', ft === hotView);
        searchHot._tabs[ft].setAttribute('aria-selected', ft === hotView ? 'true' : 'false');
      }
      renderFilterView();
      return;
    }
    if (filterPanel) { filterPanel.style.display = 'none'; }
    searchHotGrid.style.top = '';
    clear(searchHotGrid);
    var hotItems = hotViewItems(view.key);
    var title = hotViewTitle(view);
    /* No portal rows (sample catalogue, offline): old behaviour. */
    if (!hotItems.length) { hotItems = popularSearchItems(); title = 'Sugerencias'; }
    var titleNode = searchHot.querySelector('.search-hot-title');
    if (titleNode) { titleNode.textContent = title; }
    var totalNode = searchHot.querySelector('.search-hot-total span');
    if (totalNode) { totalNode.textContent = String(hotItems.length); }
    var refresh = searchHot.querySelector('.search-hot-refresh');
    if (refresh && !window.XUPER_DESKTOP) { refresh.textContent = HOT_VIEWS[(hotView + 1) % HOT_VIEWS.length].tab; }
    for (var t = 0; t < searchHot._tabs.length; t++) {
      searchHot._tabs[t].classList.toggle('is-selected', t === hotView);
      searchHot._tabs[t].setAttribute('aria-selected', t === hotView ? 'true' : 'false');
    }
    for (var h = 0; h < hotItems.length; h++) {
      searchHotGrid.appendChild(makeSearchCell(hotItems[h], h));
    }
    if (window.XUPER_DESKTOP) {
      searchHotGrid.style.height = (Math.ceil(hotItems.length / searchGridColumns()) * 437) + 'px';
      searchHot.scrollTop = 0;
    }
    schedulePosterMemoryPass();
  }

  function updateSearchInput() {
    if (!searchInput) { return; }
    if (window.XUPER_DESKTOP && searchInput.tagName === 'INPUT') {
      if (searchInput.value !== state.searchQuery) searchInput.value = state.searchQuery;
      return;
    }
    if (state.searchQuery) {
      searchInput.textContent = state.searchQuery;
      searchInput.classList.remove('is-placeholder');
    } else {
      searchInput.textContent = 'Buscar películas, series, directores y actores.';
      searchInput.classList.add('is-placeholder');
    }
  }

  function setSearchQuery(q) {
    state.searchQuery = q;
    updateSearchInput();
    runSearch();
  }

  function clearSearchState() {
    if (state.searchTimer) { clearTimeout(state.searchTimer); state.searchTimer = null; }
    state.searchQuery = '';
    updateSearchInput();
    if (searchResultGrid) { clear(searchResultGrid); }
    state.searchMatches = [];
    state.searchPage = 0;
    if (searchNav) { searchNav.textContent = ''; }
    if (searchResults) { searchResults.classList.remove('is-active'); }
    if (searchEmpty) { searchEmpty.classList.remove('is-active'); }
    if (searchHot) { searchHot.classList.remove('is-hidden'); }
    state.searchSeq++;
    state.searchStatus = 'done';
    state.searchRemote = null;
    if (searchRequestTimeout) { clearTimeout(searchRequestTimeout); searchRequestTimeout = null; }
    updateSearchStateUi();
  }

  function runSearch() {
    var rawQ = state.searchQuery || '';
    var q = norm(rawQ.trim());
    if (!q) {
      clearSearchState();
      return;
    }
    /* Instant local matches (0ms response) */
    var localMatches = [];
    for (var i = 0; i < VOD.length; i++) {
      var tNorm = norm(VOD[i].title || '');
      var aNorm = VOD[i].alias ? norm(VOD[i].alias) : '';
      if (tNorm.indexOf(q) !== -1 || (aNorm && aNorm.indexOf(q) !== -1)) {
        localMatches.push(VOD[i]);
      }
    }
    if (window.XUPER_DESKTOP) { runDesktopSearch(rawQ, localMatches); return; }
    renderSearchResults(localMatches);

    /* Debounced remote portal search (350ms) */
    if (state.searchTimer) { clearTimeout(state.searchTimer); }
    if (vodApi.mode === 'portal' && q.length >= 2) {
      var seq = ++state.searchSeq;
      state.searchTimer = setTimeout(function () {
        portalServiceCall('search', { value: rawQ.trim() }, function (error, payload) {
          if (seq !== state.searchSeq) { return; }
          if (error || !payload || payload.returnValue === false || !payload.items || !payload.items.length) {
            /* Keep existing local matches, never clear on empty remote response */
            return;
          }
          var merged = localMatches.slice();
          var seen = {};
          for (var m = 0; m < merged.length; m++) { seen[String(merged[m].id)] = true; }
          for (var p = 0; p < payload.items.length; p++) {
            var item = normalizeVod(payload.items[p], merged.length + 1);
            if (!seen[String(item.id)]) {
              seen[String(item.id)] = true;
              merged.push(item);
            }
          }
          renderSearchResults(merged);
        });
      }, 350);
    }
  }

  /* ------------------------------------------------------------------
     Desktop search states. The local catalogue only holds what the app has
     loaded, so 0 local matches does not mean 0 results: say "Buscando…"
     until the server answers, and only then "No hay resultados". While
     typing, keep the previous results on screen instead of blanking them.
     ------------------------------------------------------------------ */
  var searchStateBox = null, searchInlineState = null;
  var searchRequestTimeout = null;

  function runDesktopSearch(rawQ, localMatches) {
    if (state.searchTimer) { clearTimeout(state.searchTimer); state.searchTimer = null; }
    if (searchRequestTimeout) { clearTimeout(searchRequestTimeout); searchRequestTimeout = null; }
    var seq = ++state.searchSeq;
    var query = rawQ.trim();
    var remote = vodApi.mode === 'portal' && norm(query).length >= 2;
    state.searchRemote = null;
    if (!remote) {
      state.searchStatus = 'done';
      renderSearchResults(localMatches);
      return;
    }
    state.searchStatus = 'searching';
    if (localMatches.length || !(state.searchMatches && state.searchMatches.length)) {
      renderSearchResults(localMatches);
    } else {
      updateSearchStateUi();   /* keep the previous results, mark them as updating */
    }
    state.searchTimer = setTimeout(function () {
      state.searchTimer = null;
      var settled = false;
      function finish(status, matches, remoteState) {
        if (settled || seq !== state.searchSeq) { return; }
        settled = true;
        if (searchRequestTimeout) { clearTimeout(searchRequestTimeout); searchRequestTimeout = null; }
        state.searchStatus = status;
        state.searchRemote = remoteState || null;
        renderSearchResults(matches);
        maybeLoadMoreSearch();
      }
      searchRequestTimeout = setTimeout(function () { finish('error', localMatches); }, 15000);
      portalServiceCall('search', { value: query, pageNum: 1, pageSize: SEARCH_REMOTE_PAGE }, function (error, payload) {
        if (error || !payload || payload.returnValue === false) { finish('error', localMatches); return; }
        var merged = localMatches.slice();
        var seen = {};
        for (var m = 0; m < merged.length; m++) { seen[String(merged[m].id)] = true; }
        var items = payload.items || [];
        for (var p = 0; p < items.length; p++) {
          var item = normalizeVod(items[p], merged.length + 1);
          if (!seen[String(item.id)]) { seen[String(item.id)] = true; merged.push(item); }
        }
        var total = parseInt(payload.total, 10) || items.length;
        finish('done', merged, {
          query: query, seq: seq, total: total, nextPage: 2, received: items.length,
          seen: seen, loading: false, error: false,
          done: items.length < SEARCH_REMOTE_PAGE || items.length >= total
        });
      });
    }, 350);
  }

  function retrySearch() {
    runSearch();
  }

  /* ------------------------------------------------------------------
     Desktop results: one scrolling page (no "Siguiente"), grid or list
     view, 2-line titles, and the next server pages load on their own when
     the viewer scrolls near the end.
     ------------------------------------------------------------------ */
  var SEARCH_REMOTE_PAGE = 50;
  var SEARCH_VIEW_KEY = 'xuper_search_view_v1';
  var srWrap = null, srCount = null, srBody = null, srMore = null, srToggle = null;
  var srLangNote = null, srLangSwitch = null;

  function getSearchView() {
    var v = safeLocalRead(SEARCH_VIEW_KEY, 'grid');
    return v === 'list' ? 'list' : 'grid';
  }

  function setSearchView(mode) {
    safeLocalWrite(SEARCH_VIEW_KEY, mode);
    var keep = searchResults ? searchResults.scrollTop : 0;
    renderDesktopSearchList();
    if (searchResults) { searchResults.scrollTop = mode === 'list' ? 0 : keep; }
  }

  function ensureDesktopSearchLayout() {
    if (srWrap) { return; }
    srWrap = el('div', 'sr-wrap');
    var head = el('div', 'sr-head');
    srCount = el('div', 'sr-count');
    head.appendChild(srCount);
    srLangNote = el('div', 'sr-lang-note');
    srLangNote.appendChild(el('i', 'search-spinner is-small'));
    srLangNote.appendChild(document.createTextNode('Ordenando por idioma…'));
    head.appendChild(srLangNote);
    srLangSwitch = el('div', 'sr-lang-switch focusable' + (spanishFirst() ? ' is-on' : ''));
    srLangSwitch.setAttribute('role', 'switch');
    srLangSwitch.setAttribute('aria-checked', spanishFirst() ? 'true' : 'false');
    srLangSwitch.title = 'Muestra primero los títulos con audio en español y después los que tienen subtítulos en español';
    srLangSwitch.appendChild(el('span', 'sr-lang-label', 'Priorizar español'));
    srLangSwitch.appendChild(el('span', 'sr-lang-knob'));
    srLangSwitch._activate = function () {
      state.playback.noSpanish = spanishFirst() ? 1 : 0;
      saveGlobalPlayback();
      refreshPlaybackRow('noSpanish', state.playback.noSpanish);
      spanishPreferenceChanged();
      setFocus(srLangSwitch, true);
    };
    head.appendChild(srLangSwitch);
    srToggle = el('div', 'sr-toggle');
    [
      { mode: 'grid', label: 'Cuadrícula', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>' },
      { mode: 'list', label: 'Lista', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4" width="5" height="6" rx="1.5"/><rect x="10" y="5" width="11" height="2" rx="1"/><rect x="10" y="8" width="7" height="1.6" rx=".8"/><rect x="3" y="14" width="5" height="6" rx="1.5"/><rect x="10" y="15" width="11" height="2" rx="1"/><rect x="10" y="18" width="7" height="1.6" rx=".8"/></svg>' }
    ].forEach(function (v) {
      var b = el('div', 'sr-view focusable');
      b._mode = v.mode;
      b.title = 'Vista de ' + v.label.toLowerCase();
      b.innerHTML = v.icon + '<span>' + v.label + '</span>';
      b._activate = function () { setSearchView(v.mode); setFocus(b, true); };
      srToggle.appendChild(b);
    });
    head.appendChild(srToggle);
    srWrap.appendChild(head);
    if (searchInlineState) { srWrap.appendChild(searchInlineState); }
    srBody = el('div', 'sr-body');
    srWrap.appendChild(srBody);
    srMore = el('div', 'sr-more');
    srWrap.appendChild(srMore);
    searchResults.appendChild(srWrap);
    searchResults.addEventListener('scroll', maybeLoadMoreSearch);
    /* Looking at the results while their order is pending freezes what is
       on screen (see startSpanishSort). */
    searchResults.addEventListener('wheel', markSpanishSortTouched, { passive: true });
    srBody.addEventListener('pointermove', markSpanishSortTouched, { passive: true });
    srBody.addEventListener('focusin', markSpanishSortTouched);
  }

  function makeDesktopSearchCard(item) {
    var card = el('div', 'sr-card focusable');
    var art = el('div', 'sr-art');
    if (item.poster) {
      var img = document.createElement('img');
      img.className = 'sr-poster';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = item.poster;
      img.onerror = function () { this.style.visibility = 'hidden'; };
      art.appendChild(img);
    }
    card.appendChild(art);
    var info = el('div', 'sr-info');
    info.appendChild(el('div', 'sr-title', item.title || 'Sin título'));
    var bits = [];
    var year = String(item.year || item.releaseDate || '').match(/\d{4}/);
    if (year) { bits.push(year[0]); }
    bits.push(isSeriesItem(item) ? 'Serie' : 'Película');
    info.appendChild(el('div', 'sr-meta', bits.join(' · ')));
    if (item.genres && item.genres.length) {
      info.appendChild(el('div', 'sr-genres', displayGenres(item.genres).slice(0, 3).join(', ')));
    }
    /* The search answer carries no synopsis; skip the "Sin sinopsis" filler. */
    if (item.synopsis && !/^[\s—–\-]*$/.test(String(item.synopsis)) && !/^sin sinopsis/i.test(String(item.synopsis).trim())) {
      info.appendChild(el('div', 'sr-desc', String(item.synopsis)));
    }
    card.appendChild(info);
    card.title = item.title || '';
    card._item = item;
    card._activate = function () { openDetail(item); };
    if (window.XUPER_DESKTOP) {
      /* Language label, and the Spanish-first order once the answer arrives. */
      var seq = state.searchSeq;
      setAudioTag(art, knownLang(item));
      requestLang(item, function (lang) {
        if (!card.isConnected || seq !== state.searchSeq) { return; }
        setAudioTag(art, lang);
        spanishSortLangArrived();
      });
    }
    return card;
  }

  function appendSearchCards(list, offset) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      var card = makeDesktopSearchCard(normalizeVod(list[i], offset + i + 1));
      card._order = offset + i;          /* portal order, for a stable sort */
      frag.appendChild(card);
    }
    srBody.appendChild(frag);
  }

  /* ---- "Priorizar español": order of the search results.
     The language of each title arrives one by one (the portal answers one
     call at a time), so cards must not jump while being looked at:
       - the list is sorted once, when every language is known or after
         SPANISH_SORT_WAIT ms, with unknown titles in the middle;
       - if the user scrolls, moves the mouse or the focus into the results
         before that, only the part below the screen is sorted;
       - if nobody touched the list, one last full sort happens when the
         last language arrives;
       - otherwise new answers only re-sort the part not seen yet. */
  var SPANISH_SORT_WAIT = 4000;
  var spanishSort = { seq: -1, waiting: false, touched: false, deadline: null, later: null };

  function searchCards() {
    return srBody ? [].slice.call(srBody.querySelectorAll(':scope > .sr-card')) : [];
  }
  function firstUnseenCard(cards) {
    var bottom = searchResults.getBoundingClientRect().bottom;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getBoundingClientRect().top >= bottom - 1) { return i; }
    }
    return cards.length;
  }
  function sortSearchCards(from) {
    var cards = searchCards();
    var tail = cards.slice(from);
    if (tail.length < 2) { return; }
    var useRank = spanishFirst();
    var ranked = tail.map(function (card) {
      return { card: card, rank: useRank ? langRank(knownLang(card._item)) : 0, order: card._order || 0 };
    });
    ranked.sort(function (a, b) { return a.rank - b.rank || a.order - b.order; });
    var changed = false;
    for (var i = 0; i < ranked.length; i++) { if (ranked[i].card !== tail[i]) { changed = true; break; } }
    if (!changed) { return; }
    var anchor = tail[tail.length - 1].nextSibling;
    var frag = document.createDocumentFragment();
    for (var j = 0; j < ranked.length; j++) { frag.appendChild(ranked[j].card); }
    srBody.insertBefore(frag, anchor);
    schedulePosterMemoryPass();
  }
  function allSearchLangsKnown() {
    var cards = searchCards();
    for (var i = 0; i < cards.length; i++) { if (!knownLang(cards[i]._item)) { return false; } }
    return true;
  }
  function setSpanishSortNote(on) {
    if (srLangNote) { srLangNote.classList.toggle('is-active', !!on); }
  }
  function finishSpanishWait() {
    if (!spanishSort.waiting) { return; }
    spanishSort.waiting = false;
    if (spanishSort.deadline) { clearTimeout(spanishSort.deadline); spanishSort.deadline = null; }
    setSpanishSortNote(false);
    spanishSort.finalSort = !spanishSort.touched;
    sortSearchCards(spanishSort.touched ? firstUnseenCard(searchCards()) : 0);
  }
  /* A fresh result list (new search or the remote answer). */
  function startSpanishSort() {
    if (spanishSort.deadline) { clearTimeout(spanishSort.deadline); }
    if (spanishSort.later) { clearTimeout(spanishSort.later); }
    spanishSort = { seq: state.searchSeq, waiting: false, touched: false, deadline: null, later: null };
    if (!spanishFirst()) { setSpanishSortNote(false); return; }
    if (allSearchLangsKnown()) { setSpanishSortNote(false); sortSearchCards(0); return; }
    spanishSort.waiting = true;
    setSpanishSortNote(true);
    spanishSort.deadline = setTimeout(finishSpanishWait, SPANISH_SORT_WAIT);
  }
  function spanishSortLangArrived() {
    if (spanishSort.seq !== state.searchSeq || !spanishFirst()) { return; }
    if (spanishSort.waiting) {
      if (allSearchLangsKnown()) { finishSpanishWait(); }
      return;
    }
    if (spanishSort.later) { return; }
    spanishSort.later = setTimeout(function () {
      spanishSort.later = null;
      if (spanishSort.seq !== state.searchSeq || !srBody) { return; }
      if (spanishSort.finalSort && !spanishSort.touched && allSearchLangsKnown()) {
        spanishSort.finalSort = false;
        sortSearchCards(0);
        return;
      }
      sortSearchCards(firstUnseenCard(searchCards()));
    }, 700);
  }
  function markSpanishSortTouched() { spanishSort.touched = true; }
  /* The switch or the Configuración row changed: re-sort everything now
     (the user asked for it, so a jump is expected). */
  function spanishPreferenceChanged() {
    rankPagesChanged();
    if (srLangSwitch) {
      srLangSwitch.classList.toggle('is-on', spanishFirst());
      srLangSwitch.setAttribute('aria-checked', spanishFirst() ? 'true' : 'false');
    }
    if (!srBody || !searchResults || !searchResults.classList.contains('is-active')) { return; }
    if (spanishSort.waiting) { spanishSort.waiting = false; setSpanishSortNote(false); }
    if (spanishSort.deadline) { clearTimeout(spanishSort.deadline); spanishSort.deadline = null; }
    sortSearchCards(0);
  }

  function updateSearchCount() {
    if (!srCount) { return; }
    var shown = (state.searchMatches || []).length;
    var remote = state.searchRemote;
    var total = Math.max(shown, remote ? remote.total + (shown - remote.received > 0 ? shown - remote.received : 0) : shown);
    srCount.textContent = total === 1 ? '1 resultado' : (total + ' resultados');
  }

  function updateSearchMore() {
    if (!srMore) { return; }
    clear(srMore);
    var remote = state.searchRemote;
    if (!remote || remote.done) { srMore.className = 'sr-more'; return; }
    srMore.className = 'sr-more is-active';
    if (remote.error) {
      srMore.appendChild(document.createTextNode('No se pudieron cargar más resultados. '));
      var retry = el('span', 'search-retry-link focusable', 'Reintentar');
      retry._activate = function () { remote.error = false; loadMoreSearch(); };
      srMore.appendChild(retry);
      return;
    }
    srMore.appendChild(el('i', 'search-spinner is-small'));
    srMore.appendChild(document.createTextNode(remote.loading ? 'Cargando más resultados…' : 'Baja para ver más resultados'));
  }

  function maybeLoadMoreSearch() {
    var remote = state.searchRemote;
    if (!remote || remote.done || remote.loading || remote.error || !searchResults) { return; }
    if (remote.seq !== state.searchSeq) { return; }
    var gap = searchResults.scrollHeight - searchResults.scrollTop - searchResults.clientHeight;
    if (gap < 700) { loadMoreSearch(); }
  }

  function loadMoreSearch() {
    var remote = state.searchRemote;
    if (!remote || remote.done || remote.loading) { return; }
    remote.loading = true;
    updateSearchMore();
    portalServiceCall('search', { value: remote.query, pageNum: remote.nextPage, pageSize: SEARCH_REMOTE_PAGE }, function (error, payload) {
      if (state.searchRemote !== remote || remote.seq !== state.searchSeq) { return; }
      remote.loading = false;
      if (error || !payload || payload.returnValue === false) {
        remote.error = true;
        updateSearchMore();
        return;
      }
      var items = payload.items || [];
      var fresh = [];
      for (var p = 0; p < items.length; p++) {
        var item = normalizeVod(items[p], (state.searchMatches || []).length + fresh.length + 1);
        if (!remote.seen[String(item.id)]) { remote.seen[String(item.id)] = true; fresh.push(item); }
      }
      var offset = state.searchMatches.length;
      state.searchMatches = state.searchMatches.concat(fresh);
      if (fresh.length) { appendSearchCards(fresh, offset); spanishSortLangArrived(); }
      remote.received += items.length;
      remote.nextPage++;
      if (payload.total) { remote.total = parseInt(payload.total, 10) || remote.total; }
      if (items.length < SEARCH_REMOTE_PAGE || remote.received >= remote.total) { remote.done = true; }
      updateSearchCount();
      updateSearchMore();
      setTimeout(maybeLoadMoreSearch, 0);
    });
  }

  function renderDesktopSearchList() {
    ensureDesktopSearchLayout();
    var matches = state.searchMatches || [];
    var view = getSearchView();
    searchHot.classList.add('is-hidden');
    searchResults.classList.add('is-active');
    clear(searchResultGrid);
    if (searchNav) { searchNav.textContent = ''; }
    clear(srBody);
    dropQueuedAudio();
    srBody.className = 'sr-body is-' + view;
    var views = srToggle.children;
    for (var v = 0; v < views.length; v++) { views[v].classList.toggle('is-selected', views[v]._mode === view); }
    if (!matches.length) {
      searchEmpty.classList.add('is-active');
      srWrap.hidden = true;
      updateSearchStateUi();
      return;
    }
    searchEmpty.classList.remove('is-active');
    srWrap.hidden = false;
    appendSearchCards(matches, 0);
    startSpanishSort();
    updateSearchCount();
    updateSearchStateUi();
    updateSearchMore();
  }

  function updateSearchStateUi() {
    if (!searchStateBox || !searchInlineState) { return; }
    var count = (state.searchMatches || []).length;
    var status = state.searchStatus || 'done';
    clear(searchStateBox);
    clear(searchInlineState);
    searchStateBox.className = 'search-state';
    searchInlineState.className = 'search-inline-state';
    if (!count && status === 'searching') {
      searchEmpty.classList.remove('is-active');
      searchStateBox.classList.add('is-active');
      searchStateBox.appendChild(el('div', 'search-spinner'));
      searchStateBox.appendChild(el('div', 'search-state-title', 'Buscando…'));
      searchStateBox.appendChild(el('div', 'search-state-hint', 'Consultando el catálogo completo'));
      return;
    }
    if (!count && status === 'error') {
      searchEmpty.classList.remove('is-active');
      searchStateBox.classList.add('is-active');
      searchStateBox.appendChild(el('div', 'search-state-title', 'No se pudo completar la búsqueda'));
      searchStateBox.appendChild(el('div', 'search-state-hint', netOnline()
        ? 'El servidor de Xuper TV no respondió (tu internet funciona). Inténtalo otra vez en un momento.'
        : 'Sin conexión a internet. Revisa tu wifi o el cable e inténtalo otra vez.'));
      var retry = el('div', 'search-retry focusable', 'Reintentar');
      retry._activate = retrySearch;
      searchStateBox.appendChild(retry);
      return;
    }
    if (count && status === 'searching') {
      searchInlineState.classList.add('is-active');
      searchInlineState.appendChild(el('i', 'search-spinner is-small'));
      searchInlineState.appendChild(document.createTextNode('Buscando más en el servidor…'));
      return;
    }
    if (count && status === 'error') {
      searchInlineState.classList.add('is-active', 'is-error');
      searchInlineState.appendChild(document.createTextNode(netOnline() ? 'El servidor no respondió al buscar más. ' : 'Sin internet: no se pudo buscar más. '));
      var retry2 = el('span', 'search-retry-link focusable', 'Reintentar');
      retry2._activate = retrySearch;
      searchInlineState.appendChild(retry2);
    }
  }

  var SEARCH_PAGE_SIZE = 10;

  function renderSearchResults(matches) {
    /* A short query can match hundreds of portal titles.  webOS 4 runs out
       of media/UI memory if every poster is inserted at once, so retain the
       complete result list in JS but render one 2-row page at a time. */
    state.searchMatches = matches || [];
    state.searchPage = 0;
    renderSearchResultPage(0, -1);
  }

  function renderSearchResultPage(requestedPage, focusIndex) {
    if (window.XUPER_DESKTOP) { renderDesktopSearchList(); return; }
    var matches = state.searchMatches || [];
    searchHot.classList.add('is-hidden');
    searchResults.classList.add('is-active');
    clear(searchResultGrid);
    if (matches.length === 0) {
      searchEmpty.classList.add('is-active');
      if (searchNav) { searchNav.textContent = ''; }
      updateSearchStateUi();
      return;
    }
    searchEmpty.classList.remove('is-active');
    updateSearchStateUi();
    var pageCount = Math.ceil(matches.length / SEARCH_PAGE_SIZE);
    var page = Math.max(0, Math.min(pageCount - 1, requestedPage || 0));
    state.searchPage = page;
    var start = page * SEARCH_PAGE_SIZE;
    var end = Math.min(matches.length, start + SEARCH_PAGE_SIZE);
    if (searchNav) {
      searchNav.textContent = 'Resultados ' + (start + 1) + '-' + end + ' de ' + matches.length +
        (pageCount > 1 ? '  ·  Página ' + (page + 1) + '/' + pageCount : '');
      if (window.XUPER_DESKTOP && pageCount > 1) {
        function pageButton(label, next, disabled) {
          var button = el('button', 'desktop-search-page focusable', label);
          button.type = 'button';
          button.disabled = disabled;
          button._activate = function () {
            if (button.disabled) return;
            searchResults.scrollTop = 0;
            renderSearchResultPage(next, 0);
          };
          searchNav.appendChild(button);
        }
        pageButton('Anterior', page - 1, page === 0);
        pageButton('Siguiente', page + 1, page + 1 === pageCount);
      }
    }
    for (var m = start; m < end; m++) {
      var localIndex = m - start;
      var cell = makeSearchCell(normalizeVod(matches[m], m + 1), localIndex);
      var poster = cell.querySelector('.poster');
      if (poster) {
        (function (indexOnPage, column) {
          poster._onMove = function (dir) {
            if (dir === 'down' && indexOnPage >= 5 && end < matches.length) {
              renderSearchResultPage(page + 1, column);
              return true;
            }
            if (dir === 'up' && indexOnPage < 5 && start > 0) {
              renderSearchResultPage(page - 1, 5 + column);
              return true;
            }
            return false;
          };
        })(localIndex, localIndex % 5);
      }
      searchResultGrid.appendChild(cell);
    }
    searchResultGrid.style.height = '874px';
    if (focusIndex >= 0) {
      var requested = searchResultGrid.querySelectorAll('.poster.focusable')[focusIndex];
      if (!requested) { requested = firstIn(searchResultGrid); }
      if (requested) { setFocus(requested); }
    } else if (state.screen === 'search' && (closest(state.focus, '.search-hot') || closest(state.focus, '.search-results'))) {
      var f = firstIn(searchResultGrid);
      if (f) { setFocus(f); }
    }
  }

  function toggleSearchNumeric() {
    state.searchNumeric = !state.searchNumeric;
    var sw = searchKeyboard.querySelector('.kb-action.switch .ico');
    if (sw) {
      sw.style.backgroundImage = 'url(assets/original/search/' +
        (state.searchNumeric ? 'ic_vod_search_abc.png' : 'ic_vod_search_123.png') + ')';
    }
    var rows = searchKeyboard.querySelectorAll('.kb-row:not(.kb-row-num)');
    if (!state.searchNumeric) {
      for (var i = 0; i < rows.length; i++) { rows[i].classList.remove('hidden'); }
      searchKeys.forEach(function (k) { k.classList.remove('hidden'); });
      var old = searchKeyboard.querySelectorAll('.kb-row-num');
      for (var o = 0; o < old.length; o++) { old[o].classList.add('hidden'); }
      return;
    }
    for (var r = 0; r < rows.length; r++) { rows[r].classList.add('hidden'); }
    if (!searchKeyboard.querySelector('.kb-row-num')) {
      var digits = [['1', '2', '3', '4', '5', '6', '7'], ['8', '9', '0', ' ']];
      for (var d = 0; d < digits.length; d++) {
        var row = el('div', 'kb-row kb-row-num');
        row.style.top = (264 + d * 88.5) + 'px';
        for (var c = 0; c < digits[d].length; c++) {
          var key = el('div', 'kb-key focusable' + (digits[d][c] === ' ' ? ' space' : ''),
            digits[d][c] === ' ' ? '' : digits[d][c]);
          key._activate = (function (ch) {
            return function () { setSearchQuery(state.searchQuery + ch); };
          })(digits[d][c]);
          row.appendChild(key);
        }
        searchKeyboard.appendChild(row);
      }
    }
    var numRows = searchKeyboard.querySelectorAll('.kb-row-num');
    for (var n = 0; n < numRows.length; n++) { numRows[n].classList.remove('hidden'); }
  }

  /* ============================================================== SETTINGS */
  function buildSettings() {
    settingsMenu = $('settings-menu');
    settingsRight = $('settings-right');
    clear(settingsMenu); clear(settingsRight);

    settingsItems = [];
    for (var i = 0; i < SETTINGS_ITEMS.length; i++) {
      var item = el('div', 'settings-item focusable');
      item.innerHTML = '<span class="settings-icon">' + (SETTINGS_MENU_ICONS[SETTINGS_ITEMS[i].id] || '') + '</span>' +
        '<span class="settings-label">' + SETTINGS_ITEMS[i].label + '</span>';
      item._index = i;
      item._activate = (function (idx) {
        return function () { showSettingsPanel(idx, true); };
      })(i);
      item._onMove = function (dir) {
        if (dir === 'right') {
          var f = firstIn(settingsRight.querySelector('.settings-panel.is-active'));
          if (f) { setFocus(f); }
          return true;
        }
        return false;
      };
      settingsMenu.appendChild(item);
      settingsItems.push(item);
    }

    settingsPanels = {};
    settingsPanels.profile = buildProfilePanel();
    settingsPanels.history = buildHistoryPanel();
    settingsPanels.share = buildSharePanel();
    settingsPanels.playback = buildPlaybackPanel();
    settingsPanels.netdiag = buildNetdiagPanel();
    settingsPanels.parent = buildParentPanel();
    settingsPanels.feedback = buildFeedbackPanel();
    settingsPanels.about = buildAboutPanel();

    for (var k in settingsPanels) {
      if (settingsPanels.hasOwnProperty(k)) { settingsRight.appendChild(settingsPanels[k]); }
    }
  }

  function openSettings() {
    if (!settingsMenu) { buildSettings(); }
    showScreen('settings');
    showSettingsPanel(0, false);
    setFocus(settingsItems[0]);
  }

  function showSettingsPanel(index, focus) {
    var activeId = (SETTINGS_ITEMS[index] && SETTINGS_ITEMS[index].id) || 'profile';
    var settingsScreen = $('screen-settings');
    if (settingsScreen) { settingsScreen.classList.toggle('is-history-view', activeId === 'history'); }
    if (activeId === 'profile' && settingsPanels.profile && settingsRight) {
      var refreshedProfile = buildProfilePanel();
      settingsRight.replaceChild(refreshedProfile, settingsPanels.profile);
      settingsPanels.profile = refreshedProfile;
    } else if (activeId === 'history' && settingsPanels.history && settingsRight) {
      var refreshedHistory = buildHistoryPanel();
      settingsRight.replaceChild(refreshedHistory, settingsPanels.history);
      settingsPanels.history = refreshedHistory;
    } else if (activeId === 'netdiag' && settingsPanels.netdiag && settingsPanels.netdiag._ensureDiag) {
      settingsPanels.netdiag._ensureDiag();
    }
    for (var i = 0; i < settingsItems.length; i++) {
      settingsItems[i].classList.toggle('is-selected', i === index);
    }
    for (var k in settingsPanels) {
      if (settingsPanels.hasOwnProperty(k)) {
        settingsPanels[k].classList.toggle('is-active', k === activeId);
      }
    }
    if (focus) {
      var f = firstIn(settingsPanels[activeId]);
      /* Panels such as "Sobre nosotros" have no focusable control. In that
         case keep the focus on the selected menu entry instead of leaving a
         different, unrelated entry highlighted. */
      setFocus(f || settingsItems[index]);
    }
  }

  function panelBase(title) {
    var p = el('div', 'settings-panel');
    p.appendChild(el('div', 'sp-title', title));
    return p;
  }

  function buildPlaybackPanel() {
    var p = panelBase('Configuración global de reproducción');
    p.appendChild(el('div', 'sp-hr'));

    p.appendChild(el('div', 'sp-global-note', 'Estas preferencias se aplican automáticamente a todas las películas y series nuevas.'));
    var desk = !!window.XUPER_DESKTOP;
    var rowTops = desk ? [204, 272, 340, 408, 476, 544, 612] : [198, 307, 416];
    addOptionRow(p, rowTops[0], 'Reproductor', ['Normal (directo)', 'Modo fluido'],
      'streamMode', state.playback.streamMode === 'smooth' ? 1 : 0);
    addOptionRow(p, rowTops[1], 'Formato de pantalla', ['Pantalla completa', 'Normal', '16:9', '4:3'],
      'screen', state.playback.screen);
    addOptionRow(p, rowTops[2], 'Audio preferido', ['Español', 'Portugués', 'Inglés'],
      'audio', state.playback.audio);
    if (desk) {
      /* Same setting as the "Priorizar español" switch of the search. */
      addOptionRow(p, rowTops[3], 'Priorizar español en la búsqueda', ['Sí', 'No'],
        'noSpanish', Number(state.playback.noSpanish) === 1 ? 1 : 0);
      /* Modo fluido en equipos antiguos: convertir con la tarjeta gráfica y,
         si hace falta, a menor resolución para no saturar la CPU. */
      addOptionRow(p, rowTops[4], 'Modo fluido: aceleración', ['Tarjeta gráfica (auto)', 'Solo CPU'],
        'fluidHw', Number(state.playback.fluidHw) === 1 ? 1 : 0);
      addOptionRow(p, rowTops[5], 'Modo fluido: calidad', ['Original', '720p', '480p (equipos lentos)'],
        'fluidQuality', Math.max(0, Math.min(2, Number(state.playback.fluidQuality) || 0)));
      /* Automático: only on touch screens (a PC types with its keyboard). */
      addOptionRow(p, rowTops[6], 'Teclado en pantalla (buscador)', ['Automático', 'Mostrar', 'Ocultar'],
        'searchKeyboard', Math.max(0, Math.min(2, Number(state.playback.searchKeyboard) || 0)));
    }

    var subTop = desk ? 728 : 593;
    p.appendChild(abs(el('div', 'sp-hr'), 0, desk ? 706 : 535, 1498, 1));
    var subH = el('div', 'sp-subtitle-h', 'Subtitulos');
    subH.style.top = subTop + 'px';
    p.appendChild(subH);
    var sw = el('div', 'sp-switch focusable ' + (state.playback.subtitle ? 'on' : 'off'));
    sw.style.top = subTop + 'px';
    sw._activate = function () {
      state.playback.subtitle = !state.playback.subtitle;
      sw.className = 'sp-switch focusable ' + (state.playback.subtitle ? 'on' : 'off');
      saveGlobalPlayback();
      setFocus(sw);
    };
    p.appendChild(sw);

    addOptionRow(p, desk ? 796 : 680, 'Idioma', ['Español', 'Portugués', 'Inglés'],
      'subLang', state.playback.subLang);
    addOptionRow(p, desk ? 866 : 793, 'Tamaño', ['Normal', 'Grande', 'Pequeño'],
      'size', state.playback.size);
    addStyleRow(p, desk ? 936 : 906);
    return p;
  }

  function addOptionRow(panel, top, label, options, group, selected) {
    var row = el('div', 'pb-row');
    row.style.top = top + 'px';
    row.appendChild(el('div', 'pb-label', label));
    for (var i = 0; i < options.length; i++) {
      var opt = el('div', 'pb-opt focusable' + (i === selected ? ' is-checked' : ''));
      opt.style.marginLeft = (i === 0 ? 0 : 28) + 'px';
      opt.appendChild(el('div', 'radio'));
      opt.appendChild(el('span', null, options[i]));
      opt._group = group;
      opt._index = i;
      opt._activate = function () {
        if (this._group === 'streamMode') {
          state.playback.streamMode = this._index === 1 ? 'smooth' : 'normal';
          /* A deliberate global choice supersedes temporary per-title
             overrides from this session. */
          smoothModeByTitle = {};
          if (state.playerItem) { restoreSmoothMode(state.playerItem); }
        } else {
          state.playback[this._group] = this._index;
        }
        applyGlobalPlaybackPreferences();
        saveGlobalPlayback();
        if (this._group === 'noSpanish') { spanishPreferenceChanged(); }
        if (this._group === 'searchKeyboard') { applySearchKeyboardPref(); }
        var opts = panel.querySelectorAll('.pb-opt');
        for (var o = 0; o < opts.length; o++) {
          if (opts[o]._group === this._group) {
            opts[o].classList.toggle('is-checked', opts[o]._index === this._index);
          }
        }
      };
      row.appendChild(opt);
    }
    panel.appendChild(row);
  }

  /* Keep a Configuración row in step when the same setting changes elsewhere. */
  function refreshPlaybackRow(group, index) {
    var opts = document.querySelectorAll('.pb-opt');
    for (var o = 0; o < opts.length; o++) {
      if (opts[o]._group === group) { opts[o].classList.toggle('is-checked', opts[o]._index === index); }
    }
  }

  function addStyleRow(panel, top) {
    var row = el('div', 'pb-row');
    row.style.top = top + 'px';
    row.appendChild(el('div', 'pb-label', 'Estilo'));
    var colors = ['#ffffff', '#f6e33f', '#ffffff'];
    for (var i = 0; i < 3; i++) {
      var opt = el('div', 'pb-opt focusable' + (i === state.playback.style ? ' is-checked' : ''));
      opt.style.marginLeft = (i === 0 ? 0 : 28) + 'px';
      opt.appendChild(el('div', 'radio'));
      var aa = el('span', null, 'Aa');
      aa.style.color = colors[i];
      if (i === 2) {
        aa.style.background = '#000000';
        aa.style.display = 'inline-block';
        aa.style.width = '94px';
        aa.style.height = '50px';
        aa.style.lineHeight = '50px';
        aa.style.fontSize = '28px';
      }
      opt.appendChild(aa);
      opt._group = 'style';
      opt._index = i;
      opt._activate = function () {
        state.playback.style = this._index;
        applyGlobalPlaybackPreferences();
        saveGlobalPlayback();
        var opts = panel.querySelectorAll('.pb-opt');
        for (var o = 0; o < opts.length; o++) {
          if (opts[o]._group === 'style') {
            opts[o].classList.toggle('is-checked', opts[o]._index === this._index);
          }
        }
      };
      row.appendChild(opt);
    }
    panel.appendChild(row);
  }

  function buildPortalAccountPanel() {
    /* Two views in one card: the sign-in form, or the signed-in account with
       "Cerrar sesión".  The card is rebuilt whenever the state changes, so
       keyboard focus never lands on a hidden control. */
    var panel = panelBase('Mi cuenta');
    panel.classList.add('acct-panel');
    var card = el('div', 'acct-card');
    panel.appendChild(card);
    var busy = false;
    var notice = '';       // message carried from one view to the next
    var noticeKind = '';

    function head(title, text, signedIn) {
      var h = el('div', 'acct-head');
      var avatar = el('div', 'acct-avatar' + (signedIn ? ' is-on' : ''));
      avatar.innerHTML = SETTINGS_MENU_ICONS.profile;
      h.appendChild(avatar);
      var words = el('div', 'acct-head-text');
      words.appendChild(el('div', 'acct-title', title));
      words.appendChild(el('div', 'acct-sub', text));
      h.appendChild(words);
      return h;
    }
    function statusLine() {
      var s = el('p', 'acct-status' + (noticeKind ? ' is-' + noticeKind : ''), notice);
      s.setAttribute('role', 'status');
      notice = ''; noticeKind = '';
      return s;
    }
    function setStatus(node, message, kind) {
      node.textContent = message;
      node.className = 'acct-status' + (kind ? ' is-' + kind : '');
    }
    function keepFocus() {
      if (state.screen !== 'settings' || !panel.classList.contains('is-active')) { return; }
      if (state.focus && document.body.contains(state.focus)) { return; }
      var f = firstIn(card);
      if (f) { setFocus(f); }
    }

    function showForm(remembered) {
      clear(card);
      card.appendChild(head('Iniciar sesión', 'Entra con tu cuenta Xuper para cargar tu catálogo y reproducir.', false));
      var form = el('form', 'acct-form');
      form.setAttribute('novalidate', 'novalidate');
      function field(title, type, autocomplete, placeholder) {
        var wrap = el('label', 'acct-field');
        wrap.appendChild(el('span', 'acct-label', title));
        var box = el('span', 'acct-input-box');
        var input = el('input', 'acct-input focusable');
        input.type = type; input.autocomplete = autocomplete; input.placeholder = placeholder;
        input.spellcheck = false;
        input._activate = function () { input.focus(); };
        box.appendChild(input); wrap.appendChild(box); form.appendChild(wrap);
        return input;
      }
      var account = field('Correo o número de cuenta', 'text', 'username', 'tucorreo@ejemplo.com');
      var password = field('Contraseña', 'password', 'off', 'Tu contraseña');
      var reveal = el('button', 'acct-reveal focusable', 'Mostrar');
      reveal.type = 'button';
      reveal.setAttribute('aria-label', 'Mostrar u ocultar la contraseña');
      reveal._activate = function () {
        var shown = password.type === 'text';
        password.type = shown ? 'password' : 'text';
        reveal.textContent = shown ? 'Mostrar' : 'Ocultar';
      };
      reveal.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); reveal._activate(); });
      password.parentNode.appendChild(reveal);

      var button = el('button', 'acct-submit focusable', 'Iniciar sesión');
      button.type = 'submit'; form.appendChild(button);
      var status = statusLine(); form.appendChild(status);
      form.appendChild(el('p', 'acct-note', remembered
        ? 'Tu contraseña no se guarda. La sesión queda guardada y cifrada en este equipo: seguirás conectado al volver a abrir la aplicación, hasta que cierres sesión.'
        : 'Tu contraseña no se guarda. En este equipo no hay almacenamiento cifrado disponible, así que la sesión termina al cerrar la aplicación.'));

      function submit(event) {
        if (event) { event.preventDefault(); }
        if (busy) { return; }
        if (!account.value.trim() || !password.value.trim()) { setStatus(status, 'Escribe tu cuenta y tu contraseña.', 'error'); return; }
        busy = true; button.disabled = true; button.textContent = 'Conectando…';
        setStatus(status, '', '');
        var request = { userName: account.value.trim(), password: password.value };
        password.value = ''; password.type = 'password'; reveal.textContent = 'Mostrar';
        function fail(message) {
          request.password = ''; busy = false; button.disabled = false; button.textContent = 'Iniciar sesión';
          setStatus(status, message, 'error');
        }
        window.desktop.service('accountLogin', request).then(function (result) {
          request.password = '';
          if (!result || !result.returnValue) { return fail((result && result.errorText) || 'No se pudo iniciar sesión.'); }
          busy = false;
          notice = 'Sesión iniciada. Actualizando el catálogo…'; noticeKind = 'ok';
          refreshPortalCatalog();
          refresh();
        }, function () { fail('No se pudo comunicar con el servicio.'); });
      }
      form.addEventListener('submit', submit);
      button.addEventListener('click', function (event) { event.stopPropagation(); submit(event); });
      button._activate = function () { submit(); };
      card.appendChild(form);
      keepFocus();
    }

    function showAccount(info) {
      clear(card);
      card.appendChild(head(info.account || 'Cuenta Xuper', 'Cuenta conectada', true));
      var body = el('div', 'acct-session');
      body.appendChild(el('div', 'acct-badge', 'Sesión activa'));
      body.appendChild(el('p', 'acct-note', info.remembered
        ? 'La sesión está guardada y cifrada en este equipo. Seguirás conectado al volver a abrir la aplicación; tu contraseña no se guarda.'
        : 'La sesión dura hasta que cierres la aplicación; tu contraseña no se guarda.'));
      var status = statusLine(); body.appendChild(status);
      var out = el('button', 'acct-logout focusable', 'Cerrar sesión');
      out.type = 'button';
      /* Two steps: a stray Enter or click must not sign the account out. */
      var armed = null;
      function disarm() {
        if (armed) { clearTimeout(armed); armed = null; }
        out.classList.remove('is-armed'); out.textContent = 'Cerrar sesión';
      }
      out._activate = function () {
        if (busy) { return; }
        if (!armed) {
          out.classList.add('is-armed');
          out.textContent = '¿Cerrar sesión? Pulsa otra vez para confirmar';
          armed = setTimeout(disarm, 5000);
          return;
        }
        disarm();
        busy = true; out.disabled = true; out.textContent = 'Cerrando…';
        function done(message, kind) {
          busy = false; notice = message; noticeKind = kind;
          refresh();
        }
        window.desktop.service('accountLogout', {}).then(function (result) {
          if (!result || !result.returnValue) { return done((result && result.errorText) || 'No se pudo cerrar la sesión.', 'error'); }
          refreshPortalCatalog();
          done('Sesión cerrada en este equipo.', 'ok');
        }, function () { done('No se pudo comunicar con el servicio.', 'error'); });
      };
      out.addEventListener('click', function (event) { event.stopPropagation(); out._activate(); });
      body.appendChild(out);
      card.appendChild(body);
      /* No automatic focus here: it would put Enter on "Cerrar sesión". */
    }

    function refresh() {
      window.desktop.service('accountStatus', {}).then(function (result) {
        if (busy) { return; }
        if (result && result.authenticated) { return showAccount(result); }
        if (result && result.expired && !notice) { notice = 'Tu sesión venció. Vuelve a iniciar sesión.'; noticeKind = 'error'; }
        /* Signed out, the service reports whether a new session can be kept. */
        showForm(!result || result.canRemember !== false);
      }, function () { if (!busy) { showForm(true); } });
    }
    refresh();
    return panel;
  }

  function buildProfilePanel() {
    if (window.XUPER_DESKTOP && window.desktop && window.desktop.service) return buildPortalAccountPanel();
    var p = el('div', 'settings-panel account-panel');
    var avatar = el('div', 'account-avatar');
    avatar.innerHTML = SETTINGS_MENU_ICONS.profile;
    p.appendChild(avatar);
    p.appendChild(el('div', 'account-number', window.XUPER_DESKTOP ? String(localProfile.id).replace(/^TV-/, 'PC-') : localProfile.id));
    p.appendChild(el('div', 'account-type', 'Perfil local de este equipo'));
    var summary = el('div', 'account-card');
    summary.appendChild(el('div', 'account-card-title', 'Tu cuenta está lista'));
    summary.appendChild(el('div', 'account-card-text', 'Las preferencias, el historial y el capítulo que estabas viendo se guardan automáticamente en este equipo.'));
    p.appendChild(summary);
    var goHistory = el('div', 'account-history-btn focusable', 'Ver mi lista');
    goHistory._activate = function () { showSettingsPanel(1, true); };
    p.appendChild(goHistory);
    var privacy = el('div', 'account-card account-card-small');
    privacy.appendChild(el('div', 'account-card-title', 'Sin registro ni contraseña'));
    privacy.appendChild(el('div', 'account-card-text', 'Este perfil no envía tus datos a ningún servidor.'));
    p.appendChild(privacy);
    return p;
  }

  function timeAgo(ts) {
    if (!ts) { return ''; }
    var mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins < 1) { return 'Hace un momento'; }
    if (mins < 60) { return 'Hace ' + mins + ' min'; }
    var hours = Math.round(mins / 60);
    if (hours < 24) { return 'Hace ' + hours + ' h'; }
    var days = Math.round(hours / 24);
    if (days === 1) { return 'Ayer'; }
    if (days < 30) { return 'Hace ' + days + ' días'; }
    return new Date(ts).toLocaleDateString('es');
  }

  /* ------------------------------------------------------------------
     Desktop: history as a panel sliding in from the left, over the current
     screen. Nothing behind it changes (the preview video keeps playing), so
     closing it returns exactly where the viewer was.
     ------------------------------------------------------------------ */
  var historyDrawerOpen = false;
  var historyDrawer = null, historyDrawerList = null, historyDrawerBackdrop = null;
  var historyDrawerTab = 'history';
  var historyDrawerReturnFocus = null;

  function historyRecordLine(record) {
    var pos = Math.max(0, record.position || 0);
    var dur = Math.max(0, record.duration || 0);
    var pct = dur > 0 ? Math.min(100, Math.round(pos / dur * 100)) : 0;
    var left = dur > pos ? Math.max(1, Math.round((dur - pos) / 60)) : 0;
    var line = record.series
      ? ('Ep. ' + (record.episodeNumber || '?') + (left ? ' · quedan ' + left + ' min' : ''))
      : (left ? ('Quedan ' + left + ' min') : (pos ? ('Vas por ' + Math.max(1, Math.round(pos / 60)) + ' min') : ''));
    if (pct >= 95) { line = record.series ? ('Ep. ' + (record.episodeNumber || '?') + ' · terminado') : 'Terminada'; }
    return { line: line, pct: pct };
  }

  function buildHistoryDrawer() {
    historyDrawerBackdrop = el('div', 'history-drawer-backdrop');
    historyDrawerBackdrop.addEventListener('click', function (event) {
      event.stopPropagation();
      closeHistoryDrawer();
    });
    historyDrawer = el('aside', 'history-drawer');
    historyDrawer.setAttribute('role', 'dialog');
    historyDrawer.setAttribute('aria-label', 'Historial');
    var head = el('div', 'hd-head');
    var tabs = el('div', 'hd-tabs');
    [{ id: 'history', label: 'Historial' }, { id: 'favs', label: 'Favoritos' }].forEach(function (t) {
      var tab = el('div', 'hd-tab focusable', t.label);
      tab._hdTab = t.id;
      tab._activate = function () { historyDrawerTab = t.id; renderHistoryDrawer(); setFocus(tab); };
      tabs.appendChild(tab);
    });
    head.appendChild(tabs);
    var close = el('div', 'hd-close focusable');
    close.title = 'Cerrar (Esc)';
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    close._activate = closeHistoryDrawer;
    head.appendChild(close);
    historyDrawer.appendChild(head);
    historyDrawerList = el('div', 'hd-list scrollable');
    historyDrawer.appendChild(historyDrawerList);
    document.body.appendChild(historyDrawerBackdrop);
    document.body.appendChild(historyDrawer);
  }

  function historyDrawerRecords() {
    if (historyDrawerTab === 'history') { return localProfile.history || []; }
    var out = [];
    for (var v = 0; v < VOD.length; v++) {
      if (state.favs && state.favs[VOD[v].id]) {
        out.push({ id: VOD[v].id, title: VOD[v].title, poster: VOD[v].poster || VOD[v].cover, series: isSeriesItem(VOD[v]), position: 0, fav: true });
      }
    }
    return out;
  }

  function renderHistoryDrawer() {
    if (!historyDrawer) { return; }
    var tabs = historyDrawer.querySelectorAll('.hd-tab');
    for (var t = 0; t < tabs.length; t++) { tabs[t].classList.toggle('is-selected', tabs[t]._hdTab === historyDrawerTab); }
    clear(historyDrawerList);
    var records = historyDrawerRecords();
    if (!records.length) {
      historyDrawerList.appendChild(el('div', 'hd-empty', historyDrawerTab === 'history'
        ? 'Aún no has visto nada. Lo que reproduzcas aparecerá aquí para seguir donde lo dejaste.'
        : 'Todavía no tienes favoritos. Pulsa “Favorito” en una película o serie para guardarla aquí.'));
    }
    records.slice(0, 30).forEach(function (record) {
      var row = el('div', 'hd-item focusable');
      var img = document.createElement('img');
      img.className = 'hd-poster';
      img.alt = '';
      img.src = record.poster || 'assets/original/common/bg_placehoder_vertical.png';
      img.onerror = function () { this.style.visibility = 'hidden'; };
      row.appendChild(img);
      var info = el('div', 'hd-info');
      info.appendChild(el('div', 'hd-title', record.title || 'Contenido'));
      if (!record.fav) {
        var r = historyRecordLine(record);
        if (r.line) { info.appendChild(el('div', 'hd-sub', r.line)); }
        var bar = el('div', 'hd-bar');
        var fill = el('i');
        fill.style.width = r.pct + '%';
        bar.appendChild(fill);
        info.appendChild(bar);
        info.appendChild(el('div', 'hd-when', timeAgo(record.updatedAt)));
      } else {
        info.appendChild(el('div', 'hd-sub', record.series ? 'Serie' : 'Película'));
      }
      row.appendChild(info);
      var remove = el('div', 'hd-remove');
      remove.title = record.fav ? 'Quitar de favoritos' : 'Quitar del historial';
      remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>';
      remove.addEventListener('click', function (event) {
        event.stopPropagation();
        if (record.fav) {
          delete state.favs[record.id];
          safeLocalWrite(LOCAL_PROFILE_KEY, localProfile);
        } else {
          localProfile.history = (localProfile.history || []).filter(function (h) { return String(h.id) !== String(record.id); });
          safeLocalWrite(LOCAL_PROFILE_KEY, localProfile);
        }
        renderHistoryDrawer();
      });
      row.appendChild(remove);
      row.title = (record.fav ? 'Abrir ' : 'Seguir viendo ') + (record.title || '');
      row._activate = function () {
        closeHistoryDrawer(true);
        openHistoryRecord(record);
      };
      historyDrawerList.appendChild(row);
    });
    var foot = el('div', 'hd-foot');
    if (historyDrawerTab === 'history' && records.length) {
      var clearAll = el('div', 'hd-link focusable is-danger', 'Borrar historial');
      clearAll._activate = function () {
        if (!window.confirm('¿Borrar todo el historial de reproducción de este equipo?')) { return; }
        localProfile.history = [];
        safeLocalWrite(LOCAL_PROFILE_KEY, localProfile);
        renderHistoryDrawer();
      };
      foot.appendChild(clearAll);
    }
    var all = el('div', 'hd-link focusable', 'Ver en pantalla completa');
    all._activate = function () {
      var tab = historyDrawerTab;
      closeHistoryDrawer(true);
      historyViewTab = tab;
      openHistoryPage();
    };
    foot.appendChild(all);
    historyDrawerList.appendChild(foot);
  }

  function openHistoryDrawer() {
    if (state.screen === 'player' || state.screen === 'welcome') { return; }
    if (!historyDrawer) { buildHistoryDrawer(); }
    historyDrawerReturnFocus = state.focus;
    historyDrawerOpen = true;
    renderHistoryDrawer();
    historyDrawerList.scrollTop = 0;
    document.body.classList.add('is-history-drawer-open');
    var first = historyDrawerList.querySelector('.hd-item') || historyDrawer.querySelector('.hd-tab');
    if (first) { setFocus(first, true); }
  }

  function closeHistoryDrawer(navigating) {
    if (!historyDrawerOpen) { return; }
    historyDrawerOpen = false;
    document.body.classList.remove('is-history-drawer-open');
    if (!navigating && historyDrawerReturnFocus && isVisible(historyDrawerReturnFocus)) {
      setFocus(historyDrawerReturnFocus, true);
    }
    historyDrawerReturnFocus = null;
  }

  /* The "Historial" button and Ctrl+J open the side panel. */
  function openHistoryView() {
    if (window.XUPER_DESKTOP) {
      if (historyDrawerOpen) { closeHistoryDrawer(); } else { openHistoryDrawer(); }
      return;
    }
    historyViewTab = 'history';
    openHistoryPage();
  }

  /* Full-page history (Ajustes → Mi lista). Callers choose historyViewTab. */
  function openHistoryPage() {
    if (state.screen === 'player') { return; }
    if (state.screen === 'welcome') { finishWelcome(); }
    if (state.screen === 'detail') {
      /* Same cleanup as leaving the detail page: stop its preview video. */
      if (seasonPopup) { closeSeasonPopup(); }
      var scr = $('screen-detail');
      if (scr) { scr.classList.remove('is-synopsis-open'); }
      if (!keepFloatingVideo()) { stopPlayerVideo(); }  /* PiP keeps playing while browsing */
      var scrPlayer = $('screen-player');
      if (scrPlayer) { scrPlayer.classList.remove('is-mini'); scrPlayer.classList.remove('is-active'); }
    }
    openSettings();
    showSettingsPanel(1, true);
  }

  function buildHistoryPanel() {
    var p = el('div', 'settings-panel history-panel');
    var tabs = el('div', 'history-tabs');
    var tabDefs = [
      { id: 'history', label: 'Historia' },
      { id: 'favs', label: window.XUPER_DESKTOP ? 'Mis favoritos' : 'Mi favoritos' }
    ];
    for (var t = 0; t < tabDefs.length; t++) {
      (function (tab) {
        var tabEl = el('div', 'history-tab focusable' + (historyViewTab === tab.id ? ' is-selected' : ''), tab.label);
        tabEl._activate = function () {
          historyViewTab = tab.id;
          showSettingsPanel(1, true);
        };
        tabs.appendChild(tabEl);
      })(tabDefs[t]);
    }
    p.appendChild(tabs);
    p.appendChild(el('div', 'history-rule'));

    var records = [];
    if (historyViewTab === 'history') {
      records = localProfile.history || [];
    } else if (historyViewTab === 'favs') {
      for (var v = 0; v < VOD.length; v++) {
        if (state.favs && state.favs[VOD[v].id]) {
          records.push({ id: VOD[v].id, title: VOD[v].title, poster: VOD[v].poster || VOD[v].cover, series: isSeriesItem(VOD[v]), position: 0 });
        }
      }
    }
    var desk = !!window.XUPER_DESKTOP;
    var total = el('div', 'history-total', desk ? (historyViewTab === 'history' ? 'Vistos recientemente · ' : 'Guardados · ') : 'Total ');
    total.appendChild(el('span', null, String(records.length)));
    if (desk && historyViewTab === 'history' && records.length) {
      var clearBtn = el('div', 'history-clear focusable', 'Borrar historial');
      clearBtn._activate = function () {
        if (!window.confirm('¿Borrar todo el historial de reproducción de este equipo?')) { return; }
        localProfile.history = [];
        safeLocalWrite(LOCAL_PROFILE_KEY, localProfile);
        showSettingsPanel(1, true);
      };
      total.appendChild(clearBtn);
    }
    p.appendChild(total);
    var grid = el('div', 'history-grid' + (desk ? ' scrollable' : ''));
    if (!records.length) {
      grid.appendChild(el('div', 'history-grid-empty', historyViewTab === 'history'
        ? 'Aún no has visto nada. Lo que reproduzcas aparecerá aquí para seguir donde lo dejaste.'
        : 'No hay títulos para mostrar todavía.'));
    } else {
      for (var i = 0; i < records.length && i < (desk ? 30 : 15); i++) {
        (function (record) {
          var card = el('div', 'history-card focusable');
          var img = document.createElement('img');
          img.className = 'history-poster';
          img.alt = '';
          img.src = record.poster || 'assets/original/common/bg_placehoder_vertical.png';
          card.appendChild(img);
          if (desk && historyViewTab === 'history') {
            var pos = Math.max(0, record.position || 0);
            var dur = Math.max(0, record.duration || 0);
            var pct = dur > 0 ? Math.min(100, Math.round(pos / dur * 100)) : 0;
            var bar = el('div', 'history-bar');
            var fill = el('i');
            fill.style.width = pct + '%';
            bar.appendChild(fill);
            card.appendChild(bar);
            var left = dur > pos ? Math.max(1, Math.round((dur - pos) / 60)) : 0;
            var line = record.series
              ? ('Ep. ' + (record.episodeNumber || '?') + (left ? ' · quedan ' + left + ' min' : ''))
              : (left ? ('Quedan ' + left + ' min') : ('Vas por ' + Math.max(1, Math.round(pos / 60)) + ' min'));
            if (pct >= 95) { line = record.series ? ('Ep. ' + (record.episodeNumber || '?') + ' · terminado') : 'Terminada'; }
            card.appendChild(el('div', 'history-card-title', record.title || 'Contenido'));
            card.appendChild(el('div', 'history-sub', line));
            card.appendChild(el('div', 'history-when', timeAgo(record.updatedAt)));
            var playIco = el('i', 'history-play');
            playIco.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
            card.appendChild(playIco);
            card.title = 'Seguir viendo ' + (record.title || '');
            card._activate = function () { openHistoryRecord(record); };
            grid.appendChild(card);
            return;
          }
          var progress = record.series ? ('Ya miró hasta ' + (record.episodeNumber ? ('epis. ' + record.episodeNumber) : 'un episodio')) : ('Ya miró hasta ' + formatTime(record.position || 0));
          card.appendChild(el('div', 'history-progress', progress));
          card.appendChild(el('div', 'history-card-title', record.title || 'Contenido'));
          card._activate = function () { openHistoryRecord(record); };
          grid.appendChild(card);
        })(records[i]);
      }
    }
    p.appendChild(grid);
    return p;
  }

  function buildSharePanel() {
    var p = panelBase('Compartir APP');
    p.appendChild(el('div', 'sp-hr'));
    p.appendChild(el('div', 'share-copy', 'Para compartir la app, copia el archivo «Xuper Desktop Portable.exe». Si también quieres llevar tus favoritos e historial, copia junto a él la carpeta «Xuper Desktop - datos».'));
    return p;
  }

  function buildCrPanel() {
    var p = el('div', 'settings-panel');
    var head = el('div', 'cr-head');
    head.appendChild(el('span', 't', 'Contenido adulto'));
    var sw = el('div', 'sw focusable ' + (state.crOn ? 'on' : 'off'));
    sw._activate = function () {
      state.crOn = !state.crOn;
      sw.className = 'sw focusable ' + (state.crOn ? 'on' : 'off');
      setFocus(sw);
    };
    head.appendChild(sw);
    p.appendChild(head);

    p.appendChild(el('div', 'cr-tip', '(LIVE-18+，Explorar-Adult)'));
    var btn = el('div', 'cr-btn focusable', 'Cambiar contraseña de control parental');
    btn._activate = function () { /* password dialog not reconstructed */ };
    p.appendChild(btn);
    p.appendChild(el('div', 'cr-warn', 'Establecer contraseña para activar contenidos para adultos'));
    return p;
  }

  function buildParentPanel() {
    var p = el('div', 'settings-panel');
    p.appendChild(el('div', 'pl-title', 'Configuraciones del Control Parental'));
    p.appendChild(el('div', 'pl-tip', window.XUPER_DESKTOP ? 'Control parental no disponible en esta versión. No se aplica ningún bloqueo por PIN.' : 'Ingrese la contraseña de cuatro dígitos e ingrese viendo el programa de bloqueo.'));
    p.appendChild(el('div', 'pl-label', 'Contraseña inicial:'));
    var boxes = el('div', 'pl-boxes');
    for (var i = 0; i < 4; i++) {
      var b = el('div', 'pl-box focusable');
      if (window.XUPER_DESKTOP) b.setAttribute('aria-disabled', 'true');
      b._activate = function () { /* numeric capture not reconstructed */ };
      boxes.appendChild(b);
      if (i < 3) { boxes.appendChild(el('div', 'pl-sep')); }
    }
    p.appendChild(boxes);
    p.appendChild(el('div', 'pl-note', ''));
    var ok = el('div', 'pl-ok focusable', 'OK');
    if (window.XUPER_DESKTOP) ok.setAttribute('aria-disabled', 'true');
    ok._activate = function () { /* password validation not reconstructed */ };
    p.appendChild(ok);
    return p;
  }

  function buildFeedbackPanel() {
    var p = el('div', 'settings-panel');
    p.appendChild(el('div', 'fb-title', 'Ayuda y Feedback'));
    p.appendChild(el('div', 'fb-hr'));
    p.appendChild(el('div', 'fb-contact',
      'Si tiene alguna duda, puede ponerse en contacto con nosotros a través de los siguientes medios:'));
    p.appendChild(el('div', 'fb-qr-note', 'Escanee el código QR para enviar sugerencias o comentarios.'));
    if (window.XUPER_DESKTOP) {
      p.querySelector('.fb-contact').textContent = 'Abre Diagnóstico para comprobar la conexión y generar un reporte del problema.';
      p.querySelector('.fb-qr-note').textContent = 'El reporte no se envía automáticamente.';
    }
    var qr = el('div', 'fb-qr');
    if (window.XUPER_DESKTOP) qr.hidden = true;
    p.appendChild(qr);
    var help = el('div', 'fb-help focusable', 'Ayuda');
    help.textContent = 'Abrir diagnóstico';
    help._activate = openDesktopDiagnostic;
    p.appendChild(help);
    return p;
  }

  function buildUpgradePanel() {
    var p = el('div', 'settings-panel');
    p.appendChild(el('div', 'sp-title plain', 'Settings'));
    p.appendChild(abs(el('div', 'sp-hr soft'), 0, 165, 1498, 1));

    var cache = el('div', 'sp-card');
    abs(cache, 30, 198, 1360, 461);
    cache.appendChild(el('h3', null, 'Limpiar cache'));
    var rows = [
      { y: 139, label: 'Historia' },
      { y: 246, label: 'Cache de foto' },
      { y: 353, label: 'Limpiar todos' }
    ];
    for (var i = 0; i < rows.length; i++) {
      var row = el('div', 'sp-clear-row');
      row.style.top = rows[i].y + 'px';
      row.appendChild(el('span', 'lbl', rows[i].label));
      var btn = el('div', 'btn focusable', 'Limpiar');
      btn._activate = function () { /* cache clearing not implemented */ };
      row.appendChild(btn);
      cache.appendChild(row);
    }
    p.appendChild(cache);

    var upd = el('div', 'sp-card');
    abs(upd, 30, 689, 1360, 291);
    upd.appendChild(el('h3', null, 'Actualización'));
    var welcomeVer = document.querySelector('.welcome-version');
    var ver = el('div', 'sp-version', (welcomeVer && welcomeVer.textContent.trim()) || 'Windows');
    upd.appendChild(ver);
    p.appendChild(upd);
    return p;
  }

  function buildAboutPanel() {
    var p = el('div', 'settings-panel');
    p.appendChild(el('div', 'sp-title plain', 'Sobre nosotros'));
    p.appendChild(abs(el('div', 'sp-hr soft'), 0, 165, 1498, 1));
    p.appendChild(el('div', 'sp-about-body',
      'Xuper TV se dedica a ofrecer a los usuarios una amplia variedad de recursos de alta calidad. ' +
      'Aquí encontrarás miles de películas, series, animes y canales en vivo, todo reunido en un solo lugar. ' +
      'Brindamos una experiencia estable, diversa y siempre actualizada, además de contenidos gratuitos para disfrutar.'));
    var port = el('div', 'sp-about-port');
    port.appendChild(el('div', null, 'Adaptación para Windows · base pública de CristiancoDEV'));
    port.appendChild(el('div', 'sp-about-mod', 'Modificado por MAUTINO-PERU'));
    p.appendChild(port);
    return p;
  }

  /* ------------------------------------------------------- network diagnostics
     Reads only: it asks the service for the local DNS answer and the DoH answer
     of every portal/CDN host and shows where the connection breaks.  The
     bypass itself lives in the service (dnsx.js) and needs no user action. */
  var netdiagState = { running: false, report: null, error: null, runId: 0 };
  var netdiagEnv = null;

  function netdiagStateText(host) {
    if (!host) { return 'Sin datos'; }
    switch (host.verdict) {
      case 'ok': return 'Correcto';
      case 'dns-distinto': return 'DNS alterado';
      case 'dns-local-falla': return 'Bloqueado';
      case 'sin-tcp': return 'Sin conexión';
      case 'tls-falla': return 'HTTPS falla';
      case 'sin-tiempo': return 'Sin respuesta';
      default: return 'Sin datos';
    }
  }

  function netdiagStateClass(host) {
    if (!host) { return ''; }
    if (host.verdict === 'ok') { return 'ok'; }
    if (host.verdict === 'dns-distinto' || host.verdict === 'dns-local-falla' ||
        host.verdict === 'sin-tiempo' || host.timeout) { return 'warn'; }
    return 'bad';
  }

  function netdiagSummary(verdict) {
    switch (verdict) {
      case 'ok':
        return { cls: 'ok', text: 'La conexión está bien: el catálogo y los servidores de vídeo responden.' };
      case 'dns-distinto':
        return { cls: 'warn', text: 'Tu operador devuelve direcciones distintas a las reales (bloqueo por DNS). La app ya las esquiva sola.' };
      case 'dns-local-falla':
        return { cls: 'warn', text: 'Tu operador bloquea el DNS del equipo (no devuelve estos dominios). La app ya lo esquiva con su DNS seguro.' };
      case 'doh-sin-respuesta':
        return { cls: 'bad', text: 'El DNS seguro no devolvió respuesta. Revisa la conexión del equipo.' };
      case 'doh-bloqueado':
        return { cls: 'bad', text: 'La red bloquea el DNS seguro (Cloudflare y Google por HTTPS).' };
      case 'sin-salida':
        return { cls: 'bad', text: 'Los servidores no aceptan la conexión desde esta red.' };
      case 'algun-servidor':
        return { cls: 'warn', text: 'Un servidor de vídeo no respondió (suele rotar). El resto del catálogo sí responde: vuelve a analizar.' };
      case 'incompleto':
        return { cls: 'warn', text: 'La prueba no terminó: la TV no recibió respuesta de ningún servidor a tiempo. Vuelve a analizar; si se repite, apaga y enciende la TV.' };
      case 'servicio-sin-respuesta':
        return { cls: 'bad', text: 'El servicio de fondo no respondió. El reporte indica si fue el servicio completo o solo el diagnóstico.' };
      default:
        return { cls: '', text: 'Sin resultado todavía.' };
    }
  }

  function renderNetdiag(summary, list, report) {
    clear(list);
    var summaryInfo = netdiagSummary(report.verdict);
    summary.textContent = summaryInfo.text;
    summary.className = 'dg-summary' + (summaryInfo.cls ? ' ' + summaryInfo.cls : '');

    var hosts = report.hosts || [];
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      var row = el('div', 'dg-row ' + netdiagStateClass(host));
      var ips = (host.doh && host.doh.ok && host.doh.ips.length) ? host.doh.ips : (host.system.ips || []);
      var local = (host.system && host.system.ok) ? host.system.ips.join(', ') : 'sin respuesta';
      row.appendChild(el('span', 'dg-host', host.host));
      row.appendChild(el('span', 'dg-local', local));
      row.appendChild(el('span', 'dg-state', netdiagStateText(host)));
      row.appendChild(el('span', 'dg-ip', ips.join(', ')));
      list.appendChild(row);
    }

    var providers = report.providers || [];
    var okProviders = [];
    var badProviders = [];
    for (var p = 0; p < providers.length; p++) {
      if (providers[p].reachable) { okProviders.push(providers[p].ip); }
      else { badProviders.push(providers[p].ip); }
    }
    var providersKnown = providers.length > 0;
    var dnsRow = el('div', 'dg-row dns');
    dnsRow.appendChild(el('span', 'dg-host', 'DNS seguro (DoH)'));
    dnsRow.appendChild(el('span', 'dg-local', providersKnown ? (okProviders.length + '/' + providers.length + ' disponibles') : 'sin datos'));
    dnsRow.appendChild(el('span', 'dg-state', providersKnown ? (okProviders.length ? 'Correcto' : 'Bloqueado') : 'No evaluado'));
    dnsRow.appendChild(el('span', 'dg-ip', okProviders.join(', ')));
    if (!providersKnown) { dnsRow.className = 'dg-row dns warn'; }
    else if (okProviders.length) { dnsRow.className = 'dg-row dns ok'; }
    else { dnsRow.className = 'dg-row dns bad'; }
    list.appendChild(dnsRow);

    /* ── Codec row ─────────────────────────────────────────────────────── */
    var codec = report.codec || {};
    /* canPlayType() is unreliable on several Starfish/webOS builds: it may
       return an empty string even when native playback works. It is evidence
       about the browser API only, never a verdict about the TV hardware. */
    var codecKnown = !!(codec.h264 || codec.hevc || codec.hls);
    var codecRow = el('div', 'dg-row' + (codecKnown ? ' ok' : ' warn'));
    var codecDesc = [
      'H.264: ' + (codec.h264 || 'no informado'),
      'HEVC: '  + (codec.hevc || 'no informado'),
      'HLS: '   + (codec.hls  || 'no informado')
    ].join('  ');
    codecRow.appendChild(el('span', 'dg-host', 'Códec'));
    codecRow.appendChild(el('span', 'dg-local', ''));
    codecRow.appendChild(el('span', 'dg-state', codecKnown ? 'Informado' : 'No confirmado'));
    codecRow.appendChild(el('span', 'dg-ip', codecDesc));
    list.appendChild(codecRow);

    if (window.XUPER_DESKTOP) {
      var hevcOk = hevcPlayable();
      var hevcRow = el('div', 'dg-row' + (hevcOk ? ' ok' : ' warn'));
      hevcRow.appendChild(el('span', 'dg-host', 'HEVC en Directo'));
      hevcRow.appendChild(el('span', 'dg-local', ''));
      hevcRow.appendChild(el('span', 'dg-state', hevcOk ? 'Compatible' : 'No compatible'));
      hevcRow.appendChild(el('span', 'dg-ip', hevcOk ? 'La tarjeta gráfica decodifica HEVC.' : 'Los títulos HEVC se abren solos en Modo fluido.'));
      list.appendChild(hevcRow);
      var hwRow = el('div', 'dg-row warn');
      hwRow.appendChild(el('span', 'dg-host', 'Modo fluido'));
      hwRow.appendChild(el('span', 'dg-local', ''));
      var hwState = el('span', 'dg-state', 'Comprobando…');
      var hwDesc = el('span', 'dg-ip', '');
      hwRow.appendChild(hwState);
      hwRow.appendChild(hwDesc);
      list.appendChild(hwRow);
      portalServiceCall('relayInfo', {}, function (hwErr, info) {
        if (hwErr || !info || info.returnValue === false || info.available === false) {
          hwState.textContent = 'Sin FFmpeg';
          hwDesc.textContent = 'No se encontró el conversor del Modo fluido.';
          return;
        }
        var off = Number(state.playback.fluidHw) === 1;
        var q = ['original', '720p', '480p'][Math.max(0, Math.min(2, Number(state.playback.fluidQuality) || 0))];
        hwRow.className = 'dg-row ' + (info.encoder && !off ? 'ok' : 'warn');
        hwState.textContent = off ? 'Solo CPU (ajuste)' : (info.encoder ? info.label : 'Solo CPU');
        hwDesc.textContent = (info.encoder ? 'Convierte con la tarjeta gráfica (' + info.encoder + ')' : 'No hay codificador de tarjeta gráfica disponible') +
          (info.broken ? ' · falló con un título y se usó la CPU' : '') + ' · calidad ' + q + ' · probados: ' + (info.tried || []).join(', ');
      });
    }

    /* ── Layer rows: portal / sesión / live / VOD ───────────────────── */
    var layers = report.layers || {};
    var layerDefs = [
      { key: 'portal',  label: 'Portal' },
      { key: 'session', label: 'Sesión' },
      { key: 'live',    label: 'Live CDN' },
      { key: 'vod',     label: 'VOD CDN' }
    ];
    var liveFail = false;
    var vodFail = false;
    for (var li = 0; li < layerDefs.length; li++) {
      var ldef = layerDefs[li];
      var ldata = layers[ldef.key];
      if (!ldata) { continue; }
      /* A probe that hit the deadline proves nothing about the carrier: it must
         not be reported as a block, only as "no answer". */
      if (ldef.key === 'live' && !ldata.ok && !ldata.timeout) { liveFail = true; }
      if (ldef.key === 'vod' && !ldata.ok && !ldata.timeout) { vodFail = true; }
      var lrow = el('div', 'dg-row ' + (ldata.ok ? 'ok' : (ldata.timeout ? 'warn' : 'bad')));
      var ldesc = ldata.error || (ldata.status ? 'HTTP ' + ldata.status : (ldata.ok ? 'OK' : 'Error'));
      if (ldef.key === 'session') {
        ldesc = 'userId ' + (ldata.userId || '?') + '  token ' + (ldata.token || '?');
      }
      var lms = ldata.ms ? (' ' + ldata.ms + ' ms') : '';
      lrow.appendChild(el('span', 'dg-host', ldef.label));
      lrow.appendChild(el('span', 'dg-local', ''));
      lrow.appendChild(el('span', 'dg-state', ldata.ok ? 'OK' : (ldata.timeout ? 'Sin respuesta' : 'Error')));
      lrow.appendChild(el('span', 'dg-ip', ldesc + lms));
      list.appendChild(lrow);
    }

    /* A green DNS test with dead media CDNs is the classic carrier block:
       the operator answers DNS but drops the video hosts by IP or TLS SNI.
       Without this override the viewer reads "todo bien" and still sees a
       black screen, which is exactly the report we get from Chile/Colombia. */
    if (summaryInfo.cls === 'ok' && (liveFail || vodFail)) {
      var broken = (liveFail && vodFail) ? 'los canales en vivo y las películas'
        : (liveFail ? 'los canales en vivo' : 'las películas');
      summaryInfo = {
        cls: 'bad',
        text: 'El DNS responde bien, pero ' + broken + ' no se pueden abrir: ' +
          'tu operador bloquea las direcciones de vídeo (bloqueo por IP/SNI). ' +
          'Ese bloqueo no se arregla desde la app; hace falta una VPN en el router.'
      };
      summary.textContent = summaryInfo.text;
      summary.className = 'dg-summary ' + summaryInfo.cls;
    }

    if (report.partial && summaryInfo.cls !== 'bad') {
      summary.textContent += ' (La prueba no terminó a tiempo: vuelve a analizar.)';
    }

    if (netdiagEnv) {
      var s = report.screen || {};
      var parts = [];
      if (s.w && s.h) { parts.push('Pantalla ' + s.w + '×' + s.h); }
      if (s.panelW && s.panelH) { parts.push('panel ' + s.panelW + '×' + s.panelH); }
      if (s.scale) { parts.push('escala ' + (Math.round(s.scale * 100) / 100)); }
      if (report.version) { parts.push('versión ' + report.version); }
      netdiagEnv.textContent = parts.join(' · ');
    }
  }

  function reportSafeText(value) {
    /* A support photo must never expose a playable URL, signed query, token or
       request header. Keep only a short, human-readable error classification. */
    var text = String(value == null ? '' : value);
    text = text.replace(/https?:\/\/[^\s"']+/ig, '[URL OCULTA]');
    text = text.replace(/(token|signature|authorization|cookie|key)=?[^\s,&]*/ig, '$1=[OCULTO]');
    text = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');
    return text.slice(0, 150);
  }

  function layerReportState(layer) {
    if (!layer) { return 'sin datos'; }
    if (layer.ok) { return layer.status ? ('OK (HTTP ' + layer.status + ')') : 'OK'; }
    if (layer.timeout) { return 'sin respuesta'; }
    return 'error' + (layer.error ? (': ' + reportSafeText(layer.error)) : '');
  }

  function buildSupportReport(report) {
    var lines = [];
    var env = report.screen || {};
    var layers = report.layers || {};
    var hosts = report.hosts || [];
    lines.push('REPORTE DE SOPORTE XUPERTV');
    lines.push('Versión: ' + (report.version || 'desconocida'));
    lines.push('Pantalla: ' + ((env.w && env.h) ? (env.w + '×' + env.h) : 'sin datos') +
      ((env.panelW && env.panelH) ? (' | panel ' + env.panelW + '×' + env.panelH) : '') +
      (env.scale ? (' | escala ' + env.scale) : ''));
    lines.push('Red: ' + (report.verdict || 'sin resultado') + (report.partial ? ' (parcial)' : ''));
    if (report.pending) { lines.push('Diagnóstico: sin respuesta / detenido para generar este reporte'); }
    if (report.serviceError) { lines.push('Servicio: ' + reportSafeText(report.serviceError)); }
    lines.push('Portal: ' + layerReportState(layers.portal));
    lines.push('Credenciales locales (sin validar autorización): ' + layerReportState(layers.session));
    lines.push('TV en vivo: ' + layerReportState(layers.live));
    lines.push('Películas/series: ' + layerReportState(layers.vod));
    lines.push('Último intento VOD: ' + lastVodAttempt.phase + ' | ' + lastVodAttempt.status +
      (lastVodAttempt.error ? (' | ' + lastVodAttempt.error) : ''));
    lines.push('Reproductor: ' + (state.playerMode || 'sin reproducción') +
      ' | modo ' + (state.streamMode || 'normal') +
      (state.streamError ? (' | error ' + reportSafeText(state.streamError)) : ''));
    for (var i = 0; i < hosts.length && i < 5; i++) {
      lines.push('Host ' + (i + 1) + ': ' + reportSafeText(hosts[i].host) +
        ' — ' + reportSafeText(hosts[i].verdict || 'sin datos'));
    }
    lines.push('');
    lines.push('Privacidad: este reporte no incluye enlaces, tokens, cabeceras ni historial.');
    lines.push('Toma una foto de esta pantalla y envíala al soporte.');
    return lines.join('\n');
  }

  function showSupportReport(summary, list) {
    if (!netdiagState.report) {
      /* A frozen service must not prevent a user from contacting support.
         Stop only this UI run and make a report from the known local facts. */
      netdiagState.runId++;
      netdiagState.running = false;
      var vp = window.__xuperViewport || {};
      netdiagState.report = {
        version: (document.querySelector('.welcome-version') || {}).textContent || 'desconocida',
        verdict: 'sin respuesta', partial: true, pending: true,
        screen: { w: vp.w || 0, h: vp.h || 0, scale: vp.scale || 0,
          panelW: vp.panelW || 0, panelH: vp.panelH || 0 },
        layers: {}, hosts: []
      };
    }
    clear(list);
    var report = el('div', 'dg-report', buildSupportReport(netdiagState.report));
    list.appendChild(report);
    summary.className = 'dg-summary ok';
    summary.textContent = 'Reporte listo. Toma una foto de esta pantalla y envíala al soporte.';
  }

  function runNetdiag(button, summary, list) {
    /* Settings can be rebuilt while a slow TV still has a diagnostic request
       open. Give the new visible panel its own run and ignore the old reply;
       otherwise the reply paints an already-detached panel and viewers see
       an apparently empty Diagnóstico screen. */
    var runId = netdiagState.runId + 1;
    netdiagState.runId = runId;
    netdiagState.running = true;
    netdiagState.error = null;
    button.textContent = 'Analizando…';
    summary.className = 'dg-summary';
    summary.textContent = 'Consultando el DNS del equipo, el DNS seguro y los servidores…';
    clear(list);
    /* The list must never look empty while the test runs: some TVs take a while
       and "nothing happened" is the report we keep getting. */
    list.appendChild(el('div', 'dg-row', 'Analizando…'));

    function localFailure(reason) {
      if (netdiagState.runId !== runId || !netdiagState.running) { return; }
      netdiagState.running = false;
      /* Ignore the late callback from the request that just timed out. */
      netdiagState.runId++;
      netdiagState.report = {
        version: (document.querySelector('.welcome-version') || {}).textContent || 'desconocida',
        verdict: 'servicio-sin-respuesta', partial: true, serviceError: reason,
        screen: (function () {
          var vp = window.__xuperViewport || {};
          return { w: vp.w || 0, h: vp.h || 0, scale: vp.scale || 0,
            panelW: vp.panelW || 0, panelH: vp.panelH || 0 };
        })(),
        layers: {}, hosts: [], providers: []
      };
      button.textContent = 'Analizar de nuevo';
      renderNetdiag(summary, list, netdiagState.report);
    }

    /* First prove that Luna can reach our service. This is deliberately tiny
       and local: it distinguishes a missing/blocked service from a network
       diagnostic that itself is slow, instead of leaving a blank spinner. */
    /* Allow up to 25 seconds for the Node.js service to cold-boot on slower
       dual-core TVs (webOS 3.5 / 2017 models like LJ550 need 8-12 seconds). */
    var pingDone = false;
    var pingTimer = setTimeout(function () {
      if (!pingDone) { pingDone = true; localFailure('ping no respondió en 25 segundos (el servicio no arrancó)'); }
    }, 25000);
    portalServiceCall('ping', {}, function (pingError, pingPayload) {
      if (pingDone) { return; }
      pingDone = true;
      clearTimeout(pingTimer);
      if (pingError || !pingPayload) {
        localFailure('ping falló: ' + reportSafeText(pingError || 'sin respuesta'));
      }
    }, 24000);

    /* Two safety nets: one explains a slow network, the other gives the button
       back if the service never answers at all. */
    var slowTimer = setTimeout(function () {
      if (!netdiagState.running || netdiagState.runId !== runId) { return; }
      summary.textContent = 'Analizando… tu red está respondiendo lento, espera un momento.';
    }, 9000);
    var guardTimer = setTimeout(function () {
      if (!netdiagState.running || netdiagState.runId !== runId) { return; }
      localFailure('ping respondió, pero netdiag no devolvió resultado en 32 segundos');
    }, 32000);

    portalServiceCall('netdiag', (function () {
      var vp = window.__xuperViewport || {};
      var vid = playerVideo || document.querySelector('video');
      function cp(t) { return vid ? (vid.canPlayType(t) || '') : ''; }
      return {
        screenW: vp.w || 0, screenH: vp.h || 0, screenScale: vp.scale || 0,
        panelW: vp.panelW || 0, panelH: vp.panelH || 0,
        codecH264: cp('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
        codecHEVC: cp('video/mp4; codecs="hvc1.1.6.L93.B0"'),
        codecHLS:  cp('application/x-mpegURL'),
        /* Last real CDN URLs so the service can prove whether the carrier
           drops live/VOD by IP or SNI even when DNS looks perfect. */
        liveUrl: (lastCdnProbe.live && lastCdnProbe.live.url) || '',
        liveHeaders: (lastCdnProbe.live && lastCdnProbe.live.headers) || {},
        vodUrl: (lastCdnProbe.vod && lastCdnProbe.vod.url) || '',
        vodHeaders: (lastCdnProbe.vod && lastCdnProbe.vod.headers) || {}
      };
    })(), function (error, payload) {
      if (netdiagState.runId !== runId) { return; }
      clearTimeout(slowTimer);
      clearTimeout(guardTimer);
      netdiagState.running = false;
      button.textContent = 'Analizar de nuevo';
      if (button.parentNode && button.parentNode.className.indexOf('is-active') !== -1) { setFocus(button); }
      if (error || !payload) {
        netdiagState.error = error || 'sin respuesta';
        summary.className = 'dg-summary bad';
        var errMsg = String(error || '');
        if (/denied|permission|not permitted|bloqueado el servicio/i.test(errMsg)) {
          summary.textContent = SERVICE_BLOCKED_HINT;
        } else if (/exist|not found|no disponible/i.test(errMsg)) {
          summary.textContent = 'El servicio de fondo no está instalado en la TV. Reinstala la app usando el instalador .bat';
        } else if (/timeout|tiempo|espera/i.test(errMsg)) {
          summary.textContent = 'Tiempo de espera agotado. La conexión es muy lenta o el DNS de tu operador no responde.';
        } else {
          summary.textContent = 'No se pudo ejecutar la prueba (' + (errMsg || 'el servicio no respondió') + ').';
        }
        return;
      }
      netdiagState.report = payload;
      renderNetdiag(summary, list, payload);
    }, 45000);
  }

  function buildNetdiagPanel() {
    var p = panelBase('Diagnóstico de red');
    p.appendChild(el('div', 'dg-note',
      'Comprueba si tu operador de internet está bloqueando los servidores de XuperTV. ' +
      'La app ya usa un DNS seguro (DNS-over-HTTPS) para evitarlo; esta prueba solo lo muestra.'));
    p.appendChild(abs(el('div', 'sp-hr'), 0, 216, 1478, 1));

    var button = el('div', 'dg-btn focusable', 'Analizar red');
    abs(button, 52, 242, 330, 66);
    var reportButton = el('div', 'dg-btn dg-report-btn focusable', 'Generar reporte');
    abs(reportButton, 400, 242, 330, 66);
    var summary = el('div', 'dg-summary', 'Pulsa "Analizar red" para empezar.');
    abs(summary, 750, 242, 676, 66);

    var head = el('div', 'dg-head');
    abs(head, 52, 336, 1380, 40);
    head.appendChild(el('span', 'dg-host', 'Dominio'));
    head.appendChild(el('span', 'dg-local', 'DNS del equipo'));
    head.appendChild(el('span', 'dg-state', 'Estado'));
    head.appendChild(el('span', 'dg-ip', 'Dirección real (DNS seguro)'));

    var list = el('div', 'dg-list');
    abs(list, 52, 378, 1380, 450);

    var envLine = el('div', 'dg-env', '');
    abs(envLine, 52, 832, 1380, 32);
    netdiagEnv = envLine;

    var foot = el('div', 'dg-foot',
      'Si el estado dice "Bloqueado", tu operador está interceptando el nombre del servidor, pero la app ya conecta por la dirección real. ' +
      'El reproductor Normal y el Modo Fluido usan este mismo DNS seguro. ' +
      'Si el vídeo sigue sin abrir con la conexión en verde, el bloqueo es por dirección: hace falta un túnel (VPN local).');
    abs(foot, 52, 872, 1380, 150);

    button._activate = function () { runNetdiag(button, summary, list); };
    reportButton._activate = function () { showSupportReport(summary, list); };
    /* Opening the panel runs the test once: the people who need it are not
       going to press a button they do not understand. */
    p._ensureDiag = function () {
      if (netdiagState.report) {
        renderNetdiag(summary, list, netdiagState.report);
        return;
      }
      runNetdiag(button, summary, list);
    };

    p.appendChild(button);
    p.appendChild(reportButton);
    p.appendChild(summary);
    p.appendChild(head);
    p.appendChild(list);
    p.appendChild(envLine);
    p.appendChild(foot);
    return p;
  }

  function buildPendingPanel(title, text) {
    var p = el('div', 'settings-panel');
    p.appendChild(el('div', 'sp-title', title));
    p.appendChild(el('div', 'sp-hr'));
    p.appendChild(el('div', 'sp-pending', text));
    return p;
  }

  /* ================================================================ PLAYER */
  /* The player controller hides itself after a few seconds without input.
     The constant is not exposed in the decoded resources; 5000 ms is used
     until it can be measured on the running app (WSA/Android TV). */
  var INFO_HIDE_MS = window.XUPER_DESKTOP ? 3000 : 5000;
  var osdHideTimer = null;

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }

  function durationToSeconds(value) {
    if (typeof value === 'number') {
      return isFinite(value) && value > 0 ? (value > 100000 ? value / 1000 : value) : 0;
    }
    if (typeof value !== 'string') return 0;
    var raw = value.trim().toLowerCase().replace(/,/g, '.');
    if (!raw || /^(?:n\/a|none|null|undefined|unknown|infinity|—|-)$/.test(raw)) return 0;
    if (/^\d+(?:\.\d+)?$/.test(raw)) return durationToSeconds(Number(raw));
    var clock = /^(\d+):(\d{1,2}(?:\.\d+)?)(?::(\d{1,2}(?:\.\d+)?))?$/.exec(raw);
    if (clock) {
      var first = Number(clock[1]), middle = Number(clock[2]);
      if (middle >= 60 || (clock[3] != null && Number(clock[3]) >= 60)) return 0;
      return clock[3] == null ? first * 60 + middle : first * 3600 + middle * 60 + Number(clock[3]);
    }
    var total = 0, found = false;
    var unit = /(\d+(?:\.\d+)?)\s*(horas?|hours?|hrs?|h|minutos?|minutes?|mins?|min|m|segundos?|seconds?|secs?|sec|seg|s)(?![a-z])/g;
    var match;
    while ((match = unit.exec(raw))) {
      var label = match[2];
      var multiplier = label.charAt(0) === 'h' ? 3600 : label.charAt(0) === 'm' ? 60 : 1;
      total += Number(match[1]) * multiplier;
      found = true;
    }
    return found && isFinite(total) && total > 0 ? total : 0;
  }

  var vodProgressInterval = null;
  function startVodProgressTicker() {
    stopVodProgressTicker();
    vodProgressInterval = setInterval(function () {
      if (state.screen === 'player' && state.playerMode === 'vod' && playerVideo && !playerVideo.paused) {
        var cur = relayBaseUrl ? (relayStartOffset + (playerVideo.currentTime || 0)) : (playerVideo.currentTime || 0);
        var totalDur = vodPlaybackDuration();
        updateVodProgress(cur, totalDur);
        updateSubtitleDisplay(cur);
        rememberWatchProgress(cur, totalDur);
      }
    }, 500);
  }
  function stopVodProgressTicker() {
    if (vodProgressInterval) {
      clearInterval(vodProgressInterval);
      vodProgressInterval = null;
    }
  }

  function updateVodProgress(current, duration) {
    if (!vodTimeCurrent || !vodTimeTotal || !vodSeekProgress) { return; }
    if (vodScrubbing) { current = vodScrubTime; }
    var knownDuration = window.XUPER_DESKTOP ? vodPlaybackDuration() : durationToSeconds(duration);
    if (!knownDuration && !window.XUPER_DESKTOP && state.playerEpisode && state.playerEpisode.duration) {
      knownDuration = durationToSeconds(state.playerEpisode.duration);
    }
    if (!knownDuration && !window.XUPER_DESKTOP && state.playerItem && state.playerItem.duration) {
      knownDuration = durationToSeconds(state.playerItem.duration);
    }
    if (!knownDuration && !window.XUPER_DESKTOP && playerVideo && isFinite(playerVideo.duration) && playerVideo.duration > 0) {
      knownDuration = playerVideo.duration;
    }
    if (!knownDuration && !window.XUPER_DESKTOP && activeSubtitleCues && activeSubtitleCues.length) {
      var lastCue = activeSubtitleCues[activeSubtitleCues.length - 1];
      if (lastCue && lastCue.end > 0) {
        knownDuration = Math.round(lastCue.end + 60);
      }
    }

    current = Number(current) || 0;
    vodTimeCurrent.textContent = formatTime(current);

    var durationNote = $('vod-duration-note');
    if (durationNote) {
      var durationTarget = state.playerEpisode || state.playerItem;
      durationNote.hidden = !!knownDuration;
      durationNote.textContent = durationTarget && durationTarget._durationPending ?
        (window.XUPER_DESKTOP ? 'Calculando duración… Puedes usar −10 s y +10 s mientras tanto.' : 'Obteniendo duración… Puedes usar −10 s y +10 s.') : 'Duración no disponible. Puedes usar −10 s y +10 s.';
    }
    if (window.XUPER_DESKTOP && !knownDuration) {
      vodTimeTotal.textContent = '--:--:--';
      vodSeekProgress.style.width = '0%';
      if (vodSeekThumb) vodSeekThumb.style.left = '0%';
      if (vodSeekBuffered) vodSeekBuffered.style.width = '0%';
      if (vodSeekbar && vodSeekbar._bufferPool) { vodSeekbar._bufferPool.forEach(function (n) { n.style.width = '0%'; }); }
      if (vodSeekbar) {
        vodSeekbar.setAttribute('aria-valuemax', '0');
        vodSeekbar.setAttribute('aria-valuenow', String(Math.floor(current)));
        vodSeekbar.setAttribute('aria-valuetext', formatTime(current) + '; duración no disponible');
      }
      return;
    }
    if (!knownDuration || knownDuration <= 0) {
      var isSeries = isSeriesItem(state.playerItem);
      knownDuration = isSeries ? 2700 : 6300;
      if (current > knownDuration) {
        knownDuration = Math.round(current * 1.15);
      }
    }

    vodTimeTotal.textContent = formatTime(knownDuration);
    if (window.XUPER_DESKTOP) { updateVodEndTime(current, knownDuration); }
    var pct = Math.min(100, Math.max(0, (current / knownDuration) * 100));
    vodSeekProgress.style.width = pct.toFixed(2) + '%';
    if (window.XUPER_DESKTOP && vodSeekbar) {
      vodSeekbar.setAttribute('aria-valuemax', String(Math.floor(vodPlaybackDuration())));
      vodSeekbar.setAttribute('aria-valuenow', String(Math.floor(current)));
      vodSeekbar.setAttribute('aria-valuetext', formatTime(current) + ' de ' + formatTime(knownDuration));
    }
    if (vodSeekThumb) {
      vodSeekThumb.style.left = pct.toFixed(2) + '%';
    }
    paintBufferedRanges(knownDuration);
  }

  /* Light grey = what is really downloaded, each piece in its own place.
     After jumping around there are several separate pieces (the player keeps
     ~3 min ahead and some behind); painting from 0 to the end of the last
     piece made the gaps look loaded, and a click there still had to load. */
  function paintBufferedRanges(duration) {
    if (!vodSeekBuffered || !vodSeekbar || !duration) { return; }
    var ranges = [];
    var offset = relayBaseUrl ? relayStartOffset : 0;
    try {
      var b = playerVideo && playerVideo.buffered;
      for (var i = 0; b && i < b.length; i++) {
        var s = b.start(i) + offset, e = b.end(i) + offset;
        if (e - s >= 0.5) { ranges.push([s, e]); }
      }
    } catch (eB) { /* ignore */ }
    var pool = vodSeekbar._bufferPool || (vodSeekbar._bufferPool = [vodSeekBuffered]);
    while (pool.length < ranges.length) {
      var extra = el('div', 'vod-seek-buffered is-extra');
      vodSeekbar.insertBefore(extra, vodSeekProgress || null);
      pool.push(extra);
    }
    for (var p = 0; p < pool.length; p++) {
      var node = pool[p], r = ranges[p];
      if (!r) { node.style.width = '0%'; continue; }
      var left = Math.max(0, Math.min(100, r[0] / duration * 100));
      var right = Math.max(left, Math.min(100, r[1] / duration * 100));
      node.style.left = left.toFixed(2) + '%';
      node.style.width = (right - left).toFixed(2) + '%';
    }
  }


  /* Desktop: one big icon in the centre that fades by itself (play, pause,
     ±10 s, volume).  "none" is ignored: every flash ends on its own. */
  var desktopOsdTimer = null;
  function showDesktopOsd(type, amount) {
    if (!playerOsdIcon) { playerOsdIcon = $('player-osd-icon'); }
    if (!playerOsdIcon || type === 'none') { return; }
    var icon = '', text = '';
    if (type === 'pause') { icon = PLAYER_ICONS.pause; }
    else if (type === 'play') { icon = PLAYER_ICONS.play; }
    else if (type === 'forward') { icon = PLAYER_ICONS.fwd10; text = '+' + formatSeekAmount(Math.abs(amount || 10)); }
    else if (type === 'backward') { icon = PLAYER_ICONS.back10; text = '−' + formatSeekAmount(Math.abs(amount || 10)); }
    else if (type === 'volume' || type === 'mute') {
      icon = volumeIcon();
      text = liveAudio.muted ? 'Silencio' : Math.round(liveAudio.volume * 100) + ' %';
    } else { return; }
    playerOsdIcon.className = 'player-osd-icon is-modern is-active' + (text ? ' has-text' : '');
    playerOsdIcon.style.backgroundImage = 'none';
    playerOsdIcon.innerHTML = '<div class="osd-ring">' + icon + '</div>' + (text ? '<div class="osd-text">' + text + '</div>' : '');
    if (desktopOsdTimer) { clearTimeout(desktopOsdTimer); }
    desktopOsdTimer = setTimeout(function () {
      desktopOsdTimer = null;
      playerOsdIcon.classList.remove('is-active');
    }, type === 'volume' || type === 'mute' ? 900 : 650);
  }

  function showOsdIcon(type, amount) {
    if (window.XUPER_DESKTOP) { showDesktopOsd(type, amount); return; }
    if (!playerOsdIcon) { playerOsdIcon = $('player-osd-icon'); }
    if (!playerOsdIcon) { return; }
    if (osdHideTimer) { clearTimeout(osdHideTimer); osdHideTimer = null; }
    if (type === 'pause') {
      playerOsdIcon.style.backgroundImage = 'url(assets/original/common/icon_status_pause.png)';
      playerOsdIcon.classList.add('is-active');
    } else if (type === 'forward') {
      playerOsdIcon.style.backgroundImage = 'url(assets/original/common/icon_status_forward.png)';
      playerOsdIcon.classList.add('is-active');
      osdHideTimer = setTimeout(function () {
        playerOsdIcon.classList.remove('is-active');
      }, 900);
    } else if (type === 'backward') {
      playerOsdIcon.style.backgroundImage = 'url(assets/original/common/icon_status_backward.png)';
      playerOsdIcon.classList.add('is-active');
      osdHideTimer = setTimeout(function () {
        playerOsdIcon.classList.remove('is-active');
      }, 900);
    } else {
      playerOsdIcon.classList.remove('is-active');
    }
  }

  function togglePlayerPlayPause() {
    if (!playerVideo) { return; }
    /* Canal en vivo que sigue en el vídeo de la vista previa de Inicio. */
    var shown = shownPlayerVideo();
    if (shown !== playerVideo) {
      if (shown.paused) { shown.play().catch(function () {}); showOsdIcon('play'); }
      else { shown.pause(); showOsdIcon('pause'); }
      showInfobar();
      return;
    }
    if (playerVideo.paused) {
      resumePlayerPlayback();
      showOsdIcon(window.XUPER_DESKTOP ? 'play' : 'none');
      showInfobar();
    } else {
      try {
        playerVideo.pause();
      } catch (eP2) {}
      showOsdIcon('pause');
      showInfobar();
    }
  }

  function scheduleInfoHide() {
    if (state.infoTimer) { clearTimeout(state.infoTimer); }
    state.infoTimer = setTimeout(function () {
      state.infoTimer = null;
      if (state.screen !== 'player' || state.channelsOpen) { return; }
      if (window.XUPER_DESKTOP && (vodScrubbing || (playerVodInfo && playerVodInfo.matches(':hover')) || (playerInfo && playerInfo.matches(':hover')) || ($('desktop-back') && $('desktop-back').matches(':hover')))) { scheduleInfoHide(); return; }
      /* A paused video keeps its controls, like any desktop player. */
      if (window.XUPER_DESKTOP && state.playerMode === 'vod' && playerVideo && playerVideo.paused) { scheduleInfoHide(); return; }
      hideInfobar();
    }, INFO_HIDE_MS);
  }

  function showInfobar() {
    state.infobar = true;
    if (window.XUPER_DESKTOP) { var sp = $('screen-player'); if (sp) { sp.classList.remove('is-idle'); } }
    if (state.playerMode === 'vod') {
      if (playerVodInfo) { playerVodInfo.classList.add('is-active'); }
      if (playerInfo) { playerInfo.classList.remove('is-active'); }
    } else {
      if (playerInfo) { playerInfo.classList.add('is-active'); }
      if (playerVodInfo) { playerVodInfo.classList.remove('is-active'); }
    }
    syncBackAutohide();
    scheduleInfoHide();
  }

  function hideInfobar() {
    if (state.infoTimer) { clearTimeout(state.infoTimer); state.infoTimer = null; }
    state.infobar = false;
    /* Desktop: the mouse pointer hides with the controls, but never while
       a settings panel or dialog is open (the user needs it to click). */
    if (window.XUPER_DESKTOP && state.screen === 'player') {
      var sp = $('screen-player');
      if (sp) { sp.classList.toggle('is-idle', !(playSettingViewOpen || dialogPlaySettingsOpen || state.episodeBrowserOpen || state.channelsOpen)); }
    }
    if (playerInfo) { playerInfo.classList.remove('is-active'); }
    if (playerVodInfo) { playerVodInfo.classList.remove('is-active'); }
    syncBackAutohide();
  }

  /* Desktop: on the player, "← Volver" hides and shows together with the
     controls (and the pointer). It stays while a panel/dialog is open, since
     those keep the controls' screen "awake" too. */
  function syncBackAutohide() {
    var back = $('desktop-back');
    if (!back) { return; }
    var sp = $('screen-player');
    var hide = !!(window.XUPER_DESKTOP && state.screen === 'player' && !state.infobar && sp &&
      !sp.classList.contains('is-mini') &&
      !(playSettingViewOpen || dialogPlaySettingsOpen || state.episodeBrowserOpen || state.channelsOpen));
    back.classList.toggle('is-autohidden', hide);
  }

  function showVodInfobar() {
    showInfobar();
  }

  function hideVodInfobar() {
    hideInfobar();
  }

  /* --- PlaySettingView (Bottom Drawer) & SelectSubTitleAndAudioDialog Controller --- */
  var playSettingView = null;
  var dialogPlaySettings = null;
  var psvSecSelection = null;
  var psvEpisodesRow = null;
  var psvBtnConfig = null;
  var psvBtnP1 = null;
  var psvBtnP2 = null;
  var psvSecAudio = null;
  var psvSecQuality = null;
  var psvQualityRow = null;
  var psvSecAspect = null;
  var psvSecPlayer = null;
  var psvBtnFeedback = null;
  var psvAspectRow = null;

  /* Season/episode browser (in-player). */
  var psvBtnEpisodes = null;
  var episodeBrowser = null;
  var peTitle = null, peSub = null, peSeasons = null, peSeasonsCol = null,
      peEpisodes = null, peSeasonLabel = null;

  var dpsAudioOptions = null;
  var dpsSubSwitch = null;
  var dpsRowLang = null;
  var dpsRowSize = null;
  var dpsRowStyle = null;
  var dpsLangOptions = null;
  var dpsSizeOptions = null;
  var dpsStyleOptions = null;
  var dpsBtnExit = null;
  var playerSubtitles = null;

  var playSettingViewOpen = false;
  var dialogPlaySettingsOpen = false;
  var playSettingTimer = null;
  var vodCurrentAudioTrack = 0;
  /* Once the user picks a language we stop auto-selecting the preferred one. */
  var vodAudioChosen = false;
  /* Older Starfish builds can report MEDIA_ERR_SRC_NOT_SUPPORTED while they
     apply a native audio PID.  It is not a failed movie and must never turn
     Normal (Directo) into Modo Fluido. */
  var audioTrackSwitchUntil = 0;
  var vodCurrentSubtitle = null;
  var vodSubActive = false;
  /* True once the user flips the switch or picks a language; from then on the
     default (Spanish when available) no longer overrides the choice. */
  var vodSubChosen = false;
  var subtitleSeq = 0;
  var vodSubSize = 'normal';
  var vodSubStyle = 'white';
  var playerCurrentAspect = 'contain';
  var lastHistorySaveAt = 0;

  /* Formato de pantalla independiente: TV en vivo por un lado (se recuerda)
     y películas / series por otro (parte de "Configuración global"). */
  var LIVE_ASPECT_KEY = 'xuper_live_aspect_v1';
  var aspectByMode = { live: 'contain', vod: null };
  try {
    var savedLiveAspect = localStorage.getItem(LIVE_ASPECT_KEY);
    if (/^(contain|16-9|4-3)$/.test(savedLiveAspect || '')) { aspectByMode.live = savedLiveAspect; }
  } catch (eLiveAspect) { /* sin almacenamiento */ }
  function aspectModeKey() { return state.playerMode === 'live' ? 'live' : 'vod'; }
  /* Aplica al reproductor el formato del modo que se está viendo. */
  function applyModeAspect() {
    var mode = aspectModeKey();
    var aspect = aspectByMode[mode] || (mode === 'vod' ? globalAspectValue() : 'contain');
    playerCurrentAspect = aspect;
    if (playerVideo) {
      playerVideo.classList.remove('aspect-cover', 'aspect-contain', 'aspect-16-9', 'aspect-4-3');
      playerVideo.classList.add('aspect-' + aspect);
    }
    renderPlaySettingAspectOptions();
    var sc = playerInfo && playerInfo.querySelector('.pi-scale');
    if (sc && mode === 'live') {
      sc.textContent = aspect === '16-9' ? '16:9' : (aspect === '4-3' ? '4:3' : 'Normal');
      layoutInfoTexts();
    }
  }

  function globalAspectValue() {
    return ['cover', 'contain', '16-9', '4-3'][Number(state.playback.screen) || 0] || 'contain';
  }

  function globalSubtitleSize() {
    return ['normal', 'big', 'small'][Number(state.playback.size) || 0] || 'normal';
  }

  function globalSubtitleStyle() {
    return ['white', 'yellow', 'black'][Number(state.playback.style) || 0] || 'white';
  }

  function applyGlobalPlaybackPreferences() {
    vodSubSize = globalSubtitleSize();
    vodSubStyle = globalSubtitleStyle();
    if (!vodSubChosen) { vodSubActive = !!state.playback.subtitle; }
    setPlayerAspect(globalAspectValue(), 'vod');
    applySubtitleStyles();
  }

  function preferredLanguageCode() {
    return ['es', 'pt', 'en'][Number(state.playback.audio) || 0] || 'es';
  }

  function preferredSubtitleCode() {
    return ['es', 'pt', 'en'][Number(state.playback.subLang) || 0] || 'es';
  }

  function languageMatchesPreference(label, code) {
    var value = String(label || code || '').toLowerCase();
    var wanted = code || 'es';
    if (wanted === 'es') {
      return /^(es|spa|esp|lat|cast)|espa|latino|latin|castell/i.test(value);
    }
    if (wanted === 'pt') { return /^(pt|por)|portu/.test(value); }
    if (wanted === 'en') { return /^(en|eng|ing)|ingl/.test(value); }
    return false;
  }

  /* Only real viewing counts.  The automatic preview on the title page and
     the moments while "¿Seguir donde lo dejaste?" is on screen would
     otherwise overwrite the saved place with a few seconds from the start. */
  var watchCounted = !window.XUPER_DESKTOP;
  function rememberWatchProgress(current, duration, force) {
    var item = state.playerItem;
    if (!watchCounted || !item || !item.id || current < 3) { return; }
    var now = Date.now();
    if (!force && now - lastHistorySaveAt < 15000) { return; }
    lastHistorySaveAt = now;
    var episode = state.playerEpisode;
    var key = String(item.id);
    var record = {
      id: key,
      title: item.title || item.name || 'Contenido',
      poster: item.poster || item.cover || '',
      series: !!isSeriesItem(item),
      episodeId: episode && episode.id ? String(episode.id) : '',
      episodeNumber: episode ? (episode.number || episode.seriesNumber || '') : '',
      position: Math.floor(current),
      duration: Math.floor(vodPlaybackDuration() || durationToSeconds(duration) || 0),
      updatedAt: now
    };
    var next = [record];
    var old = localProfile.history || [];
    for (var i = 0; i < old.length && next.length < 30; i++) {
      if (String(old[i].id) !== key) { next.push(old[i]); }
    }
    localProfile.history = next;
    safeLocalWrite(LOCAL_PROFILE_KEY, localProfile);
  }

  var pendingHistoryRecord = null;
  /* A series opens on the episode the viewer was watching (not always on
     episode 1), whether the page was opened from the history or from any
     row.  A finished episode moves on to the next one. */
  function applyPendingHistoryEpisode(item) {
    if (!item || !item.episodes || !item.episodes.length) { return; }
    var record = pendingHistoryRecord;
    if (!record || String(record.id) !== String(item.id)) {
      record = null;
      var list = localProfile.history || [];
      for (var h = 0; h < list.length; h++) {
        if (String(list[h].id) === String(item.id)) { record = list[h]; break; }
      }
    }
    if (!record || !record.episodeId) { return; }
    for (var i = 0; i < item.episodes.length; i++) {
      if (String(item.episodes[i].id) === String(record.episodeId)) {
        var pick = i;
        var pos = Number(record.position) || 0, dur = Number(record.duration) || 0;
        if (window.XUPER_DESKTOP && dur > 0 && dur - pos < Math.max(90, dur * 0.05) && i + 1 < item.episodes.length) { pick = i + 1; }
        state.detailEpisode = item.episodes[pick];
        state.playerEpisode = item.episodes[pick];
        state.detailRange = Math.floor(pick / 20);   // the 20-episode block that holds it
        return;
      }
    }
  }

  function openHistoryRecord(record) {
    if (!record) { return; }
    /* Un título de la Videoteca se abre en su ficha, no en la del portal. */
    if (window.XUPER_DESKTOP && /^vt:/.test(String(record.id))) { vtOpenFromHistory(record); return; }
    for (var i = 0; i < VOD.length; i++) {
      if (String(VOD[i].id) === String(record.id)) {
        pendingHistoryRecord = record;
        openDetail(VOD[i]);
        return;
      }
    }
    /* Catalog refreshes can group seasons or replace the visible root list.
       Recover by grouped season id/title, and finally recreate a portal item
       from the durable history record so its real id can still be resolved. */
    var wantedTitle = norm(record.title || '');
    for (var v = 0; v < VOD.length; v++) {
      var candidate = VOD[v];
      var seasons = candidate._catalogSeasons || [];
      var seasonMatch = false;
      for (var s = 0; s < seasons.length; s++) {
        if (String(seasons[s].id) === String(record.id)) { seasonMatch = true; break; }
      }
      if (seasonMatch || (wantedTitle && norm(candidate.title || '') === wantedTitle)) {
        pendingHistoryRecord = record;
        openDetail(candidate);
        return;
      }
    }
    var recovered = normalizeVod({
      id: record.id,
      title: record.title,
      poster: record.poster,
      type: record.series ? 'teleplay' : 'movie',
      portal: true
    }, 0);
    recovered._portal = true;
    pendingHistoryRecord = record;
    openDetail(recovered);
  }
  var activeSubtitleCues = [];
  /* mediaInfo payloads keyed by episode/movie content id. */
  var mediaInfoCache = {};
  var mediaInfoPending = {};
  var dialogReturnFocus = null;

  function parseTimestamp(s) {
    if (!s) return 0;
    var p = s.replace(',', '.').split(':');
    if (p.length === 3) {
      return (parseFloat(p[0]) * 3600) + (parseFloat(p[1]) * 60) + parseFloat(p[2]);
    }
    return 0;
  }

  function parseSRT(data) {
    var cues = [];
    if (!data) return cues;
    var blocks = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n');
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].trim().split('\n');
      if (lines.length >= 2) {
        var timeLine = (lines[0].indexOf('-->') !== -1) ? lines[0] : lines[1];
        var textLines = (lines[0].indexOf('-->') !== -1) ? lines.slice(1) : lines.slice(2);
        if (timeLine && timeLine.indexOf('-->') !== -1) {
          var m = timeLine.split('-->');
          var start = parseTimestamp(m[0].trim());
          var end = parseTimestamp(m[1].trim());
          var txt = textLines.join('<br>').replace(/<font[^>]*>/gi, '').replace(/<\/font>/gi, '').trim();
          if (txt) cues.push({ start: start, end: end, text: txt });
        }
      }
    }
    return cues;
  }

  function loadSubtitleTrack(sub) {
    subtitleSeq++;
    var mySeq = subtitleSeq;
    if (!sub || !sub.url) {
      activeSubtitleCues = [];
      if (playerSubtitles) playerSubtitles.innerHTML = '';
      return;
    }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', sub.url, true);
      xhr.onload = function () {
        if (mySeq !== subtitleSeq) { return; }
        if (xhr.status >= 200 && xhr.status < 300) {
          activeSubtitleCues = parseSRT(xhr.responseText);
        }
      };
      xhr.send();
    } catch (eSub) { /* ignore */ }
  }

  function applySubtitleStyles() {
    if (!playerSubtitles) return;
    playerSubtitles.classList.remove('size-small', 'size-normal', 'size-big');
    playerSubtitles.classList.add('size-' + vodSubSize);
    playerSubtitles.classList.remove('color-white', 'color-yellow', 'color-black');
    playerSubtitles.classList.add('color-' + vodSubStyle);
  }

  function updateSubtitleDisplay(currentSec) {
    if (!playerSubtitles) return;
    if (!vodSubActive || !activeSubtitleCues || !activeSubtitleCues.length) {
      if (playerSubtitles.innerHTML !== '') playerSubtitles.innerHTML = '';
      return;
    }
    var cue = null;
    for (var i = 0; i < activeSubtitleCues.length; i++) {
      if (currentSec >= activeSubtitleCues[i].start && currentSec <= activeSubtitleCues[i].end) {
        cue = activeSubtitleCues[i];
        break;
      }
    }
    if (cue) {
      var html = '<span class="player-subtitles-text">' + cue.text + '</span>';
      if (playerSubtitles.innerHTML !== html) {
        playerSubtitles.innerHTML = html;
      }
    } else {
      if (playerSubtitles.innerHTML !== '') {
        playerSubtitles.innerHTML = '';
      }
    }
  }

  /* ---- Real portal audio/subtitle metadata -------------------------------
     PlaySettingView and the "Ajuste de reproducir" dialog read the same data
     the portal returns for startPlayVOD: the audio PID list and the subtitle
     file list.  It is fetched once per episode/movie and cached; playback
     still goes through resolve(). */
  function playSettingsItem() {
    if (state.screen === 'detail') { return state.detail || null; }
    return state.playerItem || state.detail || null;
  }

  /* "Modo fluido" is a per-title preference: turning it on for one movie must
     not leak into the next one, while a series keeps it across its episodes
     (same series id). */
  var smoothModeByTitle = {};
  /* Stops an automatic Normal -> Fluido retry from looping if FFmpeg itself
     cannot open a particular title. Cleared when the viewer opens a title. */
  var autoSmoothFallbackKey = '';

  function smoothModeKey(item) {
    if (!item) { return ''; }
    /* A manual mode is a series preference while chapters are playing.  The
       previous key used the current episode id, so selecting Fluido in E1
       silently reverted to Normal in E2 and could leave its resolver waiting
       on an incompatible direct pipeline. */
    if (isSeriesItem(item)) {
      return 'series:' + (item.seriesContentId || item.seriesId || item.seasonId || item.id || '');
    }
    var ep = mediaInfoEpisode(item);
    return (ep && ep.id) ? ep.id : (item.id || '');
  }

  /* Videoteca always plays Directo: its sources are H.264/AAC HLS that the
     player decodes as is (checked 13/11/2026), so the FFmpeg conversion of
     Modo fluido only added delay and CPU, and its own download path skipped
     the proxy check. The global setting still applies to everything else. */
  function restoreSmoothMode(item) {
    if (item && item._videoteca) { state.streamMode = 'normal'; return; }
    var key = smoothModeKey(item);
    if (key && smoothModeByTitle.hasOwnProperty(key)) {
      state.streamMode = smoothModeByTitle[key] ? 'smooth' : 'normal';
    } else {
      state.streamMode = state.playback.streamMode === 'smooth' ? 'smooth' : 'normal';
    }
  }

  function setSmoothMode(item, on) {
    if (item && item._videoteca) { state.streamMode = 'normal'; return; }
    var key = smoothModeKey(item);
    state.streamMode = on ? 'smooth' : 'normal';
    if (key) { smoothModeByTitle[key] = !!on; }
  }

  /* Called when a different title is opened, never when zapping episodes. */
  function resetMediaSelection() {
    autoSmoothFallbackKey = '';
    vodCurrentAudioTrack = 0;
    vodAudioChosen = false;
    vodCurrentSubtitle = null;
    vodSubActive = false;
    vodSubChosen = false;
    subtitleSeq++;
    state.trackIndex = 0;
    state.trackChosen = false;
    state.trackAuto = false;
    qualityAdvancedOpen = false;
    activeSubtitleCues = [];
    if (playerSubtitles) { playerSubtitles.innerHTML = ''; }
  }

  function mediaInfoEpisode(item) {
    if (!item) { return null; }
    if (isSeriesItem(item)) {
      if (state.screen === 'player' && state.playerEpisode) { return state.playerEpisode; }
      if (state.detailEpisode) { return state.detailEpisode; }
      return (item.episodes && item.episodes[0]) || null;
    }
    return null;
  }

  function mediaInfoKey(item) {
    if (!item) { return ''; }
    var ep = mediaInfoEpisode(item);
    return (ep && ep.id) ? ep.id : (item.id || '');
  }

  function ensureMediaInfo(item, done) {
    done = done || function () {};
    /* Videoteca: no es contenido del portal (le preguntaba por un título que no existe). */
    if (!item || item._videoteca) { return done(null); }
    var key = mediaInfoKey(item);
    if (!key) { return done(null); }
    if (mediaInfoCache[key]) {
      applySubtitleDefaults(mediaInfoCache[key]);
      return done(mediaInfoCache[key]);
    }
    if (mediaInfoPending[key]) { mediaInfoPending[key].push(done); return; }
    mediaInfoPending[key] = [done];

    var ep = mediaInfoEpisode(item);
    var params = { contentId: key };
    var seriesRef = item.seasonId || item.id;
    if (ep && ep.id && seriesRef && ep.id !== seriesRef) { params.seriesContentId = seriesRef; }
    portalServiceCall('mediaInfo', params, function (error, payload) {
      var waiters = mediaInfoPending[key] || [];
      delete mediaInfoPending[key];
      var info = (!error && payload && payload.returnValue !== false) ? payload : null;
      if (info) {
        mediaInfoCache[key] = info;
        var infoDuration = durationToSeconds(info.duration);
        if (infoDuration) {
          (ep || item).duration = infoDuration;
          document.dispatchEvent(new CustomEvent('xuper:duration'));
        }
        applySubtitleDefaults(info);
      }
      for (var i = 0; i < waiters.length; i++) {
        try { waiters[i](info); } catch (eWaiter) { /* ignore */ }
      }
    });
  }

  /* The portal lists audio PIDs in stream order ("por,spa,eng").  The real
     app preselects Spanish when present, so do the same. */
  function preferredAudioIndex(rawAudio) {
    var parts = (rawAudio || '').split(/[,\/]/);
    var preferred = preferredLanguageCode();
    for (var i = 0; i < parts.length; i++) {
      if (languageMatchesPreference(parts[i].trim(), preferred)) { return i; }
    }
    return 0;
  }

  function audioLanguageList(info) {
    var out = [];
    var parts = ((info && info.audio) || '').split(/[,\/]/);
    for (var i = 0; i < parts.length; i++) {
      var code = parts[i].trim();
      if (!code) { continue; }
      out.push({ index: i, code: code, label: formatAudioLang(code) });
    }
    return out;
  }

  function subtitleLanguageList(info) {
    var out = [];
    var subs = (info && info.subtitles) || [];
    for (var i = 0; i < subs.length; i++) {
      out.push({ lang: subs[i].lang, url: subs[i].url, format: subs[i].format });
    }
    /* The real dialog lists Español before Inglés for this catalog. */
    out.sort(function (a, b) {
      var pa = /^(es|spa|esp)$/i.test(a.lang || '') ? 0 : 1;
      var pb = /^(es|spa|esp)$/i.test(b.lang || '') ? 0 : 1;
      return pa - pb;
    });
    return out;
  }

  /* The real app opens with subtitles ON and Spanish selected when the portal
     returns subtitle files. Keep the user's choice once they touch the switch
     or pick a language. */
  function applySubtitleDefaults(info) {
    var list = subtitleLanguageList(info);
    if (!vodSubChosen) {
      /* Desktop: with subtitles off globally, a title with no Spanish audio
         still opens with Spanish subtitles when it ships them. */
      var spanishSubsOnly = false;
      if (window.XUPER_DESKTOP && !state.playback.subtitle && info && info.audio && !audioHasSpanish(info.audio)) {
        for (var ss = 0; ss < list.length; ss++) {
          if (languageMatchesPreference(list[ss].lang, 'es')) { spanishSubsOnly = list[ss]; break; }
        }
      }
      if (spanishSubsOnly) {
        vodSubActive = true;
        vodCurrentSubtitle = spanishSubsOnly;
        loadSubtitleTrack(vodCurrentSubtitle);
        return;
      }
      if (!state.playback.subtitle) {
        vodSubActive = false;
        vodCurrentSubtitle = null;
        loadSubtitleTrack(null);
        return;
      }
      if (!list.length) {
        vodSubActive = false;
        vodCurrentSubtitle = null;
        loadSubtitleTrack(null);
        return;
      }
      vodSubActive = true;
      vodCurrentSubtitle = list[0];
      for (var pref = 0; pref < list.length; pref++) {
        if (languageMatchesPreference(list[pref].lang, preferredSubtitleCode())) {
          vodCurrentSubtitle = list[pref];
          break;
        }
      }
      loadSubtitleTrack(vodCurrentSubtitle);
      return;
    }
    if (!vodSubActive) { return; }
    if (!list.length) {
      vodSubActive = false;
      vodCurrentSubtitle = null;
      loadSubtitleTrack(null);
      return;
    }
    /* New episode with the same preference: keep the language if the new
       episode ships it, otherwise fall back to the first file. */
    var stillThere = false;
    if (vodCurrentSubtitle) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url === vodCurrentSubtitle.url) {
          vodCurrentSubtitle = list[i];
          stillThere = true;
          break;
        }
      }
    }
    if (!stillThere) {
      vodCurrentSubtitle = list[0];
      loadSubtitleTrack(vodCurrentSubtitle);
    }
  }

  function qualityLabel(track) {
    var q = String((track && track.quality) || '').trim().toUpperCase();
    var h = track && track.height;
    if (!q && h) { q = String(h) + 'P'; }
    if (q === '4K' || q === '2160P' || q === 'UHD') { return '4K'; }
    if (/^\d+$/.test(q)) { return q + 'P'; }
    return q || 'AUTO';
  }

  function schedulePlaySettingHide() {
    if (playSettingTimer) { clearTimeout(playSettingTimer); }
    playSettingTimer = setTimeout(function () {
      closePlaySettingView();
    }, 8000);
  }

  function openPlaySettingView() {
    if (!playSettingView) { buildPlayer(); }
    if (!playSettingView) return;
    playSettingViewOpen = true;
    dialogPlaySettingsOpen = false;
    hideInfobar();

    renderPlaySettingView();
    playSettingView.classList.add('is-active');
    if (playerSubtitles) { playerSubtitles.classList.add('shift-up'); }

    /* Audio languages, subtitle files and renditions come from the portal;
       refresh the rows as soon as the service answers. */
    ensureMediaInfo(state.playerItem, function () {
      if (playSettingViewOpen) { renderPlaySettingView(); }
    });

    schedulePlaySettingHide();

    /* Seasons are selected in detail; this panel contains only chapters. */
    var item = state.playerItem;
    if (isSeriesItem(item) && psvEpisodesRow) {
      var chapter = psvEpisodesRow.querySelector('.psv-ep-btn');
      if (chapter) { setFocus(chapter); return; }
    }
    if (isSeriesItem(item) && psvBtnEpisodes) {
      setFocus(psvBtnEpisodes);
      return;
    }
    if (psvBtnConfig) { setFocus(psvBtnConfig); }
  }

  function closePlaySettingView() {
    if (playSettingTimer) { clearTimeout(playSettingTimer); playSettingTimer = null; }
    playSettingViewOpen = false;
    if (playSettingView) { playSettingView.classList.remove('is-active'); }
    if (playerSubtitles) { playerSubtitles.classList.remove('shift-up'); }
    if (state.screen === 'player' && !dialogPlaySettingsOpen) {
      setFocus(playerStage);
    }
  }

  function renderPlaySettingView() {
    /* Keep the d-pad where the user was: the rows rebuild their pills, so a
       plain re-render used to leave focus on a detached node (the OK press
       then did nothing and the panel closed by timeout). */
    var focusRow = state.focus ? closest(state.focus, '.psv-row') : null;
    var focusRowId = focusRow ? focusRow.id : '';
    var focusText = (focusRow && state.focus) ? state.focus.textContent : '';

    renderPlaySettingSelection();
    renderPlaySettingAudio();
    renderPlaySettingQuality();
    renderPlaySettingPlayerOptions();
    renderPlaySettingAspectOptions();
    renderPlaySettingRowFocus();

    if (!playSettingViewOpen || !focusRowId || !playSettingView) { return; }
    var rows = playSettingView.querySelectorAll('.psv-row');
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].id !== focusRowId) { continue; }
      var btns = rows[r].querySelectorAll('.focusable');
      var match = null;
      for (var b = 0; b < btns.length; b++) {
        if (btns[b].textContent === focusText) { match = btns[b]; break; }
      }
      var target = match || firstIn(rows[r]);
      if (target) { setFocus(target, true); }
      break;
    }
  }

  function renderPlaySettingAudio() {
    if (!psvSecAudio) { return; }
    /* Always present: it is the entry point to "Ajuste de reproducir". */
    psvSecAudio.classList.remove('is-hidden');
  }

  /* ud/n1.dd() builds the RESOLUCIÓN row from the portal's quality map and
     shows shifted labels: the 720p copy is titled "1080P" and the 1080p copy
     "4K". Mirror that so the row matches the real app. */
  function qualityChoices(info) {
    var tracks = (info && info.tracks) || [];
    var out = [];
    var seen = {};
    for (var i = 0; i < tracks.length; i++) {
      var raw = String(tracks[i].quality || '').toLowerCase().replace(/p$/, '');
      var label = raw === '480' ? '480P'
                : raw === '720' ? '1080P'
                : raw === '1080' ? '4K'
                : qualityLabel(tracks[i]);
      if (seen[label]) { continue; }
      seen[label] = true;
      out.push({ label: label, trackIndex: i });
    }
    /* The APK adds a "4K" pill whenever the 720p copy is present and the
       portal has no separate 1080p entry. */
    if (seen['1080P'] && !seen['4K']) { out.push({ label: '4K', trackIndex: -1 }); }
    return out;
  }

  /* Desktop "Calidad" row. Most portal episodes have a single version, so the
     row only appears when the current episode offers more than one height.
     The choice is a preferred height (e.g. 720) kept for later titles too;
     "Automática" lets the service pick the most compatible version. */
  var QUALITY_PREF_KEY = 'xuper_quality_pref_v1';
  function preferredQualityHeight() {
    return parseInt(safeLocalRead(QUALITY_PREF_KEY, 0), 10) || 0;
  }
  function trackLines(track) {
    var h = parseInt(track && track.height, 10) || 0;
    if (h) { return h; }
    var m = /(\d{3,4})\s*[pi]?/i.exec(String((track && track.quality) || ''));
    return m ? parseInt(m[1], 10) : 0;
  }
  function currentTrackInfo() {
    var item = state.playerItem;
    if (!item) { return null; }
    var ep = state.playerEpisode;
    return mediaInfoCache[(ep && ep.id) || ''] || mediaInfoCache[mediaInfoKey(item)] || null;
  }

  /* "Calidad" row, two levels:
       simple   - Automática + one button per height (kept for later titles);
       advanced - "Versiones": every rendition with codec and container, for
                  this title only (e.g. 1080p HEVC TS vs 1080p H.264 MP4).
     With Modo fluido on, its conversion quality is right here as well, so it
     is not buried in Ajustes.  The last line shows what is really playing
     (portal labels can be wrong: a "1080p" TS measured 1280×534 on a phone). */
  var qualityAdvancedOpen = false;

  /* ---- Another version when a version's server does not answer ----------
     Each version of a title can come from a different CDN server (measured
     12/11/2026: the 1080p MP4 server did not answer while the 1080p HEVC TS
     played).  Order: same height in another format, then the next lower
     height; Modo fluido stays the last resort (it reused the same failing
     version).  The version that worked is remembered for the session. */
  /* `tried` only lives during one chain of consecutive failures: it is cleared
     when a version gives a picture and when a playback starts for any reason
     other than this fallback (`pending` marks the fallback's own restarts).
     Without that, a version that failed once stayed "tried" for the session. */
  var versionFallback = { key: '', tried: {}, pending: false };
  var workingVersionByTitle = {};
  function versionFallbackBegin() {
    if (versionFallback.pending) { versionFallback.pending = false; return; }
    versionFallback.key = '';
    versionFallback.tried = {};
  }
  function versionTitleKey() {
    var item = state.playerItem;
    if (!item) { return ''; }
    return (mediaInfoKey(item) || smoothModeKey(item) || item.id || '') + '|' + ((state.playerEpisode && state.playerEpisode.id) || '');
  }
  function tryOtherVersion(reason) {
    if (!window.XUPER_DESKTOP || state.playerMode !== 'vod' || !state.playerItem) { return false; }
    var info = currentTrackInfo();
    var tracks = (info && info.tracks) || [];
    if (tracks.length < 2) { return false; }
    var key = versionTitleKey();
    if (versionFallback.key !== key) { versionFallback = { key: key, tried: {}, pending: false }; }
    var current = Number(info.selectedIndex) || 0;
    versionFallback.tried[current] = true;
    var currentH = trackLines(tracks[current]);
    var pick = -1, i, h;
    // 1) same height, another format
    for (i = 0; i < tracks.length; i++) {
      if (!versionFallback.tried[i] && trackLines(tracks[i]) === currentH) { pick = i; break; }
    }
    // 2) the closest lower height
    if (pick < 0) {
      var bestLower = -1;
      for (i = 0; i < tracks.length; i++) {
        h = trackLines(tracks[i]);
        if (!versionFallback.tried[i] && h < currentH && h > bestLower) { bestLower = h; pick = i; }
      }
    }
    // 3) the closest higher height (the lowest version failed)
    if (pick < 0) {
      var bestHigher = Infinity;
      for (i = 0; i < tracks.length; i++) {
        h = trackLines(tracks[i]);
        if (!versionFallback.tried[i] && h > currentH && h < bestHigher) { bestHigher = h; pick = i; }
      }
    }
    if (pick < 0) { return false; }
    versionFallback.tried[pick] = true;
    versionFallback.pending = true;
    delete workingVersionByTitle[key];
    state.trackIndex = pick;
    state.trackChosen = true;
    state.trackAuto = true;
    var label = trackVersionLabel(tracks[pick]);
    playTimingLog('versión ' + trackVersionLabel(tracks[current]) + ' falló (' + reason + ') → probando ' + label);
    setPlayerStatus('El servidor de esta versión no responde. Probando ' + label + '…');
    var item = state.playerItem;
    setTimeout(function () {
      if (state.playerMode === 'vod' && state.playerItem === item) { restartCurrentPlayback(); }
    }, 0);
    return true;
  }
  function versionsExhausted() {
    var info = currentTrackInfo();
    var tracks = (info && info.tracks) || [];
    if (tracks.length < 2 || versionFallback.key !== versionTitleKey()) { return false; }
    for (var i = 0; i < tracks.length; i++) { if (!versionFallback.tried[i]) { return false; } }
    return true;
  }
  /* Remember the version that gave a picture after a switch. */
  document.addEventListener('playing', function (event) {
    if (!event.target || event.target.id !== 'player-video' || state.playerMode !== 'vod') { return; }
    // A picture: the failure chain is over.
    versionFallback.key = '';
    versionFallback.tried = {};
    versionFallback.pending = false;
    if (!state.trackAuto) { return; }
    var info = currentTrackInfo();
    if (info) { workingVersionByTitle[versionTitleKey()] = Number(info.selectedIndex) || 0; }
  }, true);
  /* A fatal hls.js error (TS in Directo) does not always reach video.onerror. */
  document.addEventListener('xuper:hls-fatal', function () {
    if (state.playerMode === 'vod' && state.streamMode === 'normal') { tryOtherVersion('hls.js'); }
  });
  /* The 30 s loading watchdog: the version's server accepted the request but
     no picture came.  Same chain as a player error, so every version is tried
     once at most and the chain ends when one gives a picture. */
  vodTimeoutFallback = function () {
    if (tryOtherVersion('sin imagen en 30 s')) { return 'switched'; }
    return versionsExhausted() ? 'exhausted' : '';
  };
  function codecName(t) {
    var c = String((t && t.codec) || '');
    return /265|hevc/i.test(c) ? 'HEVC' : /264|avc/i.test(c) ? 'H.264' : (c || '?');
  }
  function trackVersionLabel(t) {
    var parts = [trackLines(t) ? trackLines(t) + 'p' : String((t && t.quality) || '?'), codecName(t),
      String((t && t.format) || '?').toUpperCase()];
    if (t && t.bitrateKbps) { parts.push((t.bitrateKbps / 1000).toFixed(1).replace('.', ',') + ' Mbit/s'); }
    if (codecName(t) === 'HEVC' && !hevcPlayable()) { parts.push('usa Modo fluido'); }
    return parts.join(' · ');
  }
  function qualityButton(label, selected, onPick, extraClass) {
    var b = el('button', 'psv-btn focusable' + (selected ? ' is-selected' : '') + (extraClass ? ' ' + extraClass : ''));
    b.appendChild(el('span', 'psv-check', '✔'));
    b.appendChild(document.createTextNode(label));
    b._activate = function () { if (!selected || extraClass === 'psv-btn-toggle') { onPick(); } };
    psvQualityRow.appendChild(b);
    return b;
  }
  /* Videoteca "Calidad": the qualities of its HLS (Automática / 720p / 480p),
     switched live by hls.js without reloading. Kept for later Videoteca
     titles; the portal's own versions and Modo fluido rows are not used. */
  var VT_QUALITY_KEY = 'xuper_vt_quality_v1';
  function vtQualityPref() {
    return parseInt(safeLocalRead(VT_QUALITY_KEY, 0), 10) || 0;
  }
  function renderVtQuality() {
    var levels = (playerVideo && playerVideo._xuperLevels) || [];
    var heights = [];
    levels.forEach(function (l) { if (l.height && heights.indexOf(l.height) === -1) { heights.push(l.height); } });
    heights.sort(function (a, b) { return b - a; });
    if (state.playerMode !== 'vod' || heights.length < 2) {
      psvSecQuality.classList.add('is-hidden');
      return;
    }
    psvSecQuality.classList.remove('is-hidden');
    var pref = vtQualityPref();
    var effective = 0;
    if (pref) {
      heights.forEach(function (h) { if (h <= pref && h > effective) { effective = h; } });
      if (!effective) { effective = heights[heights.length - 1]; }
    }
    var now = playerVideo._xuperLevelNow ? playerVideo._xuperLevelNow() : null;
    function pick(h) {
      safeLocalWrite(VT_QUALITY_KEY, h);
      if (playerVideo._xuperSetLevel) { playerVideo._xuperSetLevel(h); }
      renderPlaySettingQuality();
      schedulePlaySettingHide();
    }
    qualityButton('Automática' + (!effective && now && now.height ? ' · ' + now.height + 'p' : ''), !effective, function () { pick(0); });
    heights.forEach(function (h) { qualityButton(h + 'p', effective === h, function () { pick(h); }); });
    var w = playerVideo.videoWidth, hgt = playerVideo.videoHeight;
    if (w && hgt) { psvQualityRow.appendChild(el('div', 'psv-quality-now', 'Reproduciendo: ' + w + '×' + hgt)); }
  }
  document.addEventListener('xuper:hls-levels', function () {
    if (playSettingViewOpen && state.playerItem && state.playerItem._videoteca) { renderPlaySettingQuality(); }
  });

  function renderPlaySettingQuality() {
    if (!window.XUPER_DESKTOP || !psvSecQuality || !psvQualityRow) { return; }
    if (state.playerItem && state.playerItem._videoteca) { clear(psvQualityRow); renderVtQuality(); return; }
    var info = currentTrackInfo();
    var tracks = (info && info.tracks) || [];
    var smooth = state.streamMode === 'smooth';
    clear(psvQualityRow);
    if (state.playerMode !== 'vod' || (tracks.length < 2 && !smooth)) {
      psvSecQuality.classList.add('is-hidden');
      return;
    }
    psvSecQuality.classList.remove('is-hidden');

    if (tracks.length >= 2) {
      var heights = [];
      for (var i = 0; i < tracks.length; i++) {
        var h = trackLines(tracks[i]);
        if (h && heights.indexOf(h) === -1) { heights.push(h); }
      }
      heights.sort(function (a, b) { return b - a; });
      var pref = preferredQualityHeight();
      // A version switched in by the server fallback still counts as automatic.
      var chosen = state.trackChosen && !state.trackAuto ? (Number(state.trackIndex) || 0) : -1;
      var playing = info.selected || {};
      var selectedH = chosen < 0 ? ((pref && heights.indexOf(pref) !== -1) ? pref : 0) : -1;
      var pickHeight = function (hh) {
        safeLocalWrite(QUALITY_PREF_KEY, hh);
        state.trackChosen = false;
        state.trackAuto = false;
        state.trackIndex = 0;
        delete workingVersionByTitle[versionTitleKey()];
        renderPlaySettingQuality();
        restartCurrentPlayback();
      };
      /* The height buttons belong to Directo; Modo fluido shows only its own
         quality below, because the saved height is not applied there. */
      if (!smooth) {
        qualityButton('Automática' + (selectedH === 0 && trackLines(playing) ? ' · ' + trackLines(playing) + 'p ' + codecName(playing) : ''),
          selectedH === 0, function () { pickHeight(0); });
        if (heights.length >= 2) {
          heights.forEach(function (hh) { qualityButton(hh + 'p', selectedH === hh, function () { pickHeight(hh); }); });
        }
      }
      qualityButton(qualityAdvancedOpen ? 'Versiones ▾' : 'Versiones (avanzado) ▸', qualityAdvancedOpen, function () {
        qualityAdvancedOpen = !qualityAdvancedOpen;
        renderPlaySettingQuality();
      }, 'psv-btn-toggle');
      if (qualityAdvancedOpen) {
        var playingIndex = Number(info.selectedIndex) || 0;
        tracks.forEach(function (t, index) {
          var label = trackVersionLabel(t) + (index === playingIndex ? '  ▶' : '');
          qualityButton(label, chosen === index, function () {
            state.trackIndex = index;
            state.trackChosen = true;
            state.trackAuto = false;
            renderPlaySettingQuality();
            restartCurrentPlayback();
          }, 'psv-btn-version');
        });
      }
    }

    if (smooth) {
      var fq = Math.max(0, Math.min(2, Number(state.playback.fluidQuality) || 0));
      ['Fluido: original', 'Fluido: 720p', 'Fluido: 480p (más ligero)'].forEach(function (label, q) {
        qualityButton(label, fq === q, function () {
          state.playback.fluidQuality = q;
          saveGlobalPlayback();
          renderPlaySettingQuality();
          restartCurrentPlayback();
        }, 'psv-btn-fluid');
      });
    }

    var w = playerVideo && playerVideo.videoWidth, hgt = playerVideo && playerVideo.videoHeight;
    var now = info && info.selected ? codecName(info.selected) + ' · ' + String(info.selected.format || '?').toUpperCase() : '';
    if (w && hgt) {
      psvQualityRow.appendChild(el('div', 'psv-quality-now', 'Reproduciendo: ' + w + '×' + hgt +
        (now ? ' · ' + now : '') + (smooth ? ' · convertido por Modo fluido' : '')));
    }
  }

  /* The APK turns the title of the row that holds focus white and 40px. */
  function renderPlaySettingRowFocus() {
    if (!playSettingView) { return; }
    var rows = playSettingView.querySelectorAll('.psv-row');
    for (var i = 0; i < rows.length; i++) { rows[i].classList.remove('is-row-focused'); }
    var row = state.focus ? closest(state.focus, '.psv-row') : null;
    if (row) { row.classList.add('is-row-focused'); }
  }

  function renderPlaySettingSelection() {
    if (!psvSecSelection) return;
    var item = state.playerItem;
    if (!item || !isSeriesItem(item)) {
      psvSecSelection.style.display = 'none';
      return;
    }
    psvSecSelection.style.display = 'block';
    if (!psvEpisodesRow) return;

    clear(psvEpisodesRow);

    var seasons = seriesSeasons(item);
    var season = seasons[state.playerSeasonIndex] || seasons[0];
    var episodes = (season && season.id === (item.seasonId || item.id) && item.episodes && item.episodes.length)
      ? item.episodes : ((season && season._episodes) || item.episodes || []);
    if (!episodes.length) {
      psvEpisodesRow.appendChild(el('div', 'psv-selection-empty', 'Temporadas y episodios'));
      return;
    }
    var currentIndex = 0;
    for (var c = 0; c < episodes.length; c++) {
      if (state.playerEpisode && (episodes[c].id === state.playerEpisode.id || episodes[c].number === state.playerEpisode.number)) { currentIndex = c; break; }
    }
    var ranges = detailRanges(episodes.length);
    if (state.playerEpisodeRange === undefined || state.playerEpisodeRange >= ranges.length) {
      state.playerEpisodeRange = Math.floor(currentIndex / 20);
    }
    var range = ranges[state.playerEpisodeRange] || ranges[0];
    /* reveal() only follows .scrollable containers.  Without this class the
       d-pad could focus episode 16+ outside the visible row, making a
       20-episode page look capped around fifteen entries. */
    var numberRow = el('div', 'psv-episode-numbers scrollable');
    for (var i = range.start; i < range.end; i++) {
      (function (ep, idx) {
        var epNo = String(ep.number !== undefined && ep.number !== null ? ep.number : idx + 1);
        /* Desktop keeps the number visible and marks the current one by style. */
        var label = (idx === currentIndex && !window.XUPER_DESKTOP) ? '▶' : epNo;
        var btn = el('button', 'psv-ep-btn focusable' + (idx === currentIndex ? ' is-selected is-current' : ''), label);
        btn._activate = function () { chooseEpisode(ep); };
        numberRow.appendChild(btn);
      })(episodes[i], i);
    }
    psvEpisodesRow.appendChild(numberRow);
    var rangeRow = el('div', 'psv-episode-ranges scrollable');
    for (var r = 0; r < ranges.length; r++) {
      (function (idx, part) {
        var btn = el('button', 'psv-range-btn focusable' + (idx === state.playerEpisodeRange ? ' is-selected' : ''),
          (part.start + 1) + '-' + part.end);
        btn._activate = function () {
          state.playerEpisodeRange = idx;
          renderPlaySettingSelection();
          var first = psvEpisodesRow.querySelector('.psv-ep-btn');
          if (first) { setFocus(first); }
        };
        rangeRow.appendChild(btn);
      })(r, ranges[r]);
    }
    psvEpisodesRow.appendChild(rangeRow);
  }

  /* ================= Season/episode browser (in-player) =================
     Netflix-style list: season rail on the left, episode rows on the right.
     Episodes for other seasons are fetched once from the portal and cached on
     the season object.  The series id (item.id) is never overwritten, so the
     resolver keeps sending seriesContentId = the real series. */
  function seriesSeasons(item) {
    if (item && item.seasons && item.seasons.length) { return item.seasons; }
    return [{ id: item ? item.id : '', number: 1 }];
  }

  function seasonEpisodes(item, season, done) {
    done = done || function () {};
    if (!item || !season) { return done([]); }
    if (season.id === (item.seasonId || item.id) && item.episodes && item.episodes.length) {
      season._episodes = item.episodes;
      return done(item.episodes);
    }
    if (season._episodes) { return done(season._episodes); }
    if (season._loading) {
      season._wait = season._wait || [];
      season._wait.push(done);
      return;
    }
    season._loading = true;
    season._wait = [done];
    portalServiceCall('detail', { contentId: season.id }, function (error, payload) {
      season._loading = false;
      var eps = (!error && payload && payload.returnValue !== false && payload.episodes)
        ? payload.episodes : [];
      if (eps.length) { season._episodes = eps; }
      var waiters = season._wait || [];
      season._wait = [];
      for (var i = 0; i < waiters.length; i++) {
        try { waiters[i](eps); } catch (eWaiter) { /* ignore */ }
      }
    });
  }

  function episodeDisplayTitle(item, ep, index) {
    var num = (ep && ep.number !== undefined && ep.number !== null) ? ep.number : (index + 1);
    var raw = String((ep && (ep.title || ep.name)) || '').trim();
    var base = String((item && item.title) || '').trim()
      .replace(/[\s\-–_]*[TtSs]\d+$/, '');   /* "Serie T10" -> "Serie" */
    if (base && raw.indexOf(base) === 0) {
      raw = raw.substring(base.length);
    }
    /* Language tags like "(Español Latino)" are shown apart (episodeLangTag). */
    raw = raw.replace(/\s*[(\[][^)\]]{1,30}[)\]]\s*/g, ' ');
    raw = raw.replace(/^[\s\-–_:.]+/, '').replace(/\s{2,}/g, ' ').trim();
    /* Only a season/episode code left ("T1_06", "S01E06", "6")? Use a clean
       label instead of repeating the series name. */
    if (!raw || /^(?:[TtSs]?\d+[\s\-–_.:]*)+$/.test(raw)) {
      raw = 'Episodio ' + num;
    }
    return raw;
  }

  /* "(Español Latino) T1_23" -> "Latino"; empty when the title has no tag. */
  function episodeLangTag(ep) {
    var m = /[(\[]([^)\]]{1,30})[)\]]/.exec(String((ep && (ep.title || ep.name)) || ''));
    if (!m) { return ''; }
    var tag = m[1].trim();
    if (/latino/i.test(tag)) { return 'Latino'; }
    if (/castellano|españa/i.test(tag)) { return 'Castellano'; }
    if (/sub/i.test(tag)) { return 'Subtitulado'; }
    return tag;
  }

  function episodeDurationLabel(ep) {
    var raw = String((ep && ep.duration) || '').trim();
    /* The player may store the measured length as plain seconds ("1388.82"). */
    if (/^\d+(?:\.\d+)?$/.test(raw) && parseFloat(raw) >= 60) {
      var totalMin = Math.round(parseFloat(raw) / 60);
      var hh = Math.floor(totalMin / 60);
      return hh ? (hh + ' h ' + (totalMin % 60) + ' min') : (totalMin + ' min');
    }
    var m = /^(\d+):(\d+)(?::(\d+))?$/.exec(raw);
    if (!m) { return raw; }
    if (m[3]) {
      var h = parseInt(m[1], 10) || 0;
      var min = parseInt(m[2], 10) || 0;
      return h ? (h + ' h ' + min + ' min') : (min + ' min');
    }
    return (parseInt(m[1], 10) || 0) + ' min';
  }

  function openEpisodeBrowser() {
    var item = state.playerItem;
    if (!item || !isSeriesItem(item)) { return; }
    if (playSettingViewOpen) { closePlaySettingView(); }
    if (!episodeBrowser) { buildPlayer(); }
    if (!episodeBrowser) { return; }

    if ((!item.episodes || !item.episodes.length) && !item._detailsLoaded) {
      setPlayerStatus('Cargando capítulos…');
      loadVodDetail(item, function () {
        if (state.screen !== 'player') { return; }
        if (!state.playerEpisode && item.episodes && item.episodes.length) {
          state.playerEpisode = item.episodes[0];
          state.detailEpisode = item.episodes[0];
        }
        openEpisodeBrowser();
      });
      return;
    }

    if (!state.playerEpisode && item.episodes && item.episodes.length) {
      state.playerEpisode = item.episodes[0];
      state.detailEpisode = item.episodes[0];
      state.playerSeasonIndex = state.detailSeason || 0;
    }

    state.episodeBrowserOpen = true;
    state.browserSeason = state.playerSeasonIndex || 0;
    episodeBrowser.classList.add('is-active');
    hideVodInfobar();
    renderEpisodeBrowser();

    var cur = peEpisodes ? peEpisodes.querySelector('.pe-ep.is-current') : null;
    var f = cur || (peEpisodes ? firstIn(peEpisodes) : null) ||
            (peSeasonsCol && peSeasonsCol.style.display !== 'none' ? firstIn(peSeasons) : null);
    if (f) { setFocus(f); }
  }

  function closeEpisodeBrowser(keepFocus) {
    if (!episodeBrowser || !state.episodeBrowserOpen) { return; }
    state.episodeBrowserOpen = false;
    episodeBrowser.classList.remove('is-active');
    if (!keepFocus && state.screen === 'player' && playerStage) { setFocus(playerStage); }
  }

  function renderEpisodeBrowser() {
    var item = state.playerItem;
    if (!item || !episodeBrowser) { return; }
    var seasons = seriesSeasons(item);
    if (state.browserSeason >= seasons.length) { state.browserSeason = 0; }
    if (state.browserSeason < 0) { state.browserSeason = 0; }
    var season = seasons[state.browserSeason];
    var playingSeason = seasons[state.playerSeasonIndex] || seasons[0];
    var ep = state.playerEpisode;

    if (peTitle) { peTitle.textContent = item.title || ''; }
    if (peSub) {
      if (ep) {
        var tag = [];
        if (playingSeason && playingSeason.number) { tag.push('T' + playingSeason.number); }
        if (ep.number) { tag.push('E' + ep.number); }
        peSub.textContent = 'Reproduciendo ' + tag.join(' ') + ' · ' + episodeDisplayTitle(item, ep);
      } else {
        peSub.textContent = 'Elige un episodio';
      }
    }
    if (peSeasonLabel) {
      peSeasonLabel.textContent = 'Episodios · Temporada ' + ((season && season.number) || (state.browserSeason + 1));
    }

    renderBrowserSeasons(item, seasons);
    renderBrowserEpisodes(item, season);
  }

  function renderBrowserSeasons(item, seasons) {
    if (!peSeasons || !peSeasonsCol) { return; }
    clear(peSeasons);
    peSeasonsCol.style.display = 'flex';
    for (var i = 0; i < seasons.length; i++) {
      (function (idx) {
        var s = seasons[idx];
        var b = el('div', 'pe-season focusable', 'Temporada ' + (s.number || (idx + 1)));
        if (idx === state.browserSeason) { b.classList.add('is-selected'); }
        /* Netflix behaviour: just moving the season rail already shows that
           season's episodes, so OK is only needed to jump into the list. */
        b._onFocus = function () {
          if (state.browserSeason !== idx) { selectBrowserSeason(idx, false); }
        };
        b._activate = function () { selectBrowserSeason(idx, true); };
        peSeasons.appendChild(b);
      })(i);
    }
  }

  function renderBrowserEpisodes(item, season) {
    if (!peEpisodes || !season) { return; }
    clear(peEpisodes);
    var cached = (season.id === (item.seasonId || item.id) && item.episodes && item.episodes.length)
      ? item.episodes : (season._episodes || []);

    if (!cached.length) {
      peEpisodes.appendChild(el('div', 'pe-loading', 'Cargando episodios…'));
      seasonEpisodes(item, season, function (eps) {
        if (!state.episodeBrowserOpen) { return; }
        var now = seriesSeasons(item)[state.browserSeason];
        if (now !== season) { return; }
        renderBrowserEpisodes(item, season);
        /* Only re-anchor focus when the user is already inside the list; when
           they are browsing seasons the rail keeps the d-pad. */
        if (closest(state.focus, '#pe-episodes')) {
          var cur = peEpisodes.querySelector('.pe-ep.is-current');
          var f = cur || firstIn(peEpisodes);
          if (f) { setFocus(f); }
        }
      });
      return;
    }

    /* Keep the drawer within the small webOS 4 renderer budget.  A full
       season can contain dozens of poster images; decoding all of them while
       video is active can make the system kill the app for memory. */
    /* Desktop has no such memory limit and no artwork here: list them all. */
    var visibleEpisodes = window.XUPER_DESKTOP ? cached.length : Math.min(cached.length, 24);
    for (var i = 0; i < visibleEpisodes; i++) {
      (function (ep, idx) {
        var row = el('div', 'pe-ep focusable');
        var num = (ep.number !== undefined && ep.number !== null) ? ep.number : (idx + 1);
        row.appendChild(el('div', 'pe-num', String(num)));

        var thumb = el('div', 'pe-thumb');
        /* Deliberately no <img> per episode: remote artwork is the dominant
           memory cost in this overlay on a 1 GB webOS 4 TV. */
        var playIcon = el('div', 'pe-thumb-play', '▶');
        thumb.appendChild(playIcon);
        row.appendChild(thumb);

        var info = el('div', 'pe-info');
        info.appendChild(el('div', 'pe-name', episodeDisplayTitle(item, ep, idx)));
        var bits = [];
        var dur = episodeDurationLabel(ep);
        if (dur) { bits.push(dur); }
        if (ep.quality) { bits.push(String(ep.quality).split(',')[0].toUpperCase()); }
        if (window.XUPER_DESKTOP && episodeLangTag(ep)) { bits.push(episodeLangTag(ep)); }
        info.appendChild(el('div', 'pe-meta', bits.join('   ·   ')));
        if (ep.description) {
          info.appendChild(el('div', 'pe-desc', ep.description));
        }
        row.appendChild(info);

        /* Same id, or (without ids) same number in the season that is playing.
           Comparing only the number marked episode 1 of every season. */
        var pe = state.playerEpisode;
        var isPlaying = !!pe && (pe === ep || (pe.id && ep.id ? pe.id === ep.id :
          (pe.number !== undefined && pe.number === ep.number && state.browserSeason === state.playerSeasonIndex)));
        row.appendChild(el('div', 'pe-badge', '▶ REPRODUCIENDO'));
        if (isPlaying) {
          row.classList.add('is-current');
        }
        row._activate = function () { chooseEpisode(ep); };
        peEpisodes.appendChild(row);
      })(cached[i], i);
    }
    if (cached.length > visibleEpisodes) {
      peEpisodes.appendChild(el('div', 'pe-loading', 'Mostrando los primeros ' + visibleEpisodes + ' capítulos'));
    }
  }

  /* Repaints the rail's selection without rebuilding the nodes, so the
     focused season keeps the d-pad while the list on the right updates. */
  function updateBrowserSeasonSelection() {
    if (!peSeasons) { return; }
    var rows = peSeasons.children;
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('is-selected', i === state.browserSeason);
    }
  }

  function selectBrowserSeason(idx, moveFocus) {
    var item = state.playerItem;
    var seasons = seriesSeasons(item);
    if (!seasons[idx]) { return; }
    state.browserSeason = idx;
    updateBrowserSeasonSelection();
    if (peSeasonLabel) {
      peSeasonLabel.textContent = 'Episodios · Temporada ' + (seasons[idx].number || (idx + 1));
    }
    renderBrowserEpisodes(item, seasons[idx]);
    if (moveFocus) {
      var cur = peEpisodes ? (peEpisodes.querySelector('.pe-ep.is-current') || firstIn(peEpisodes)) : null;
      if (cur) { setFocus(cur); }
    }
  }

  function seasonIndexOfEpisode(item, ep) {
    var seasons = seriesSeasons(item);
    function has(list) {
      if (!list) { return false; }
      for (var e = 0; e < list.length; e++) {
        if (list[e] === ep || (ep.id && list[e] && list[e].id === ep.id)) { return true; }
      }
      return false;
    }
    /* The season shown in the episode browser is the most likely one. */
    var order = [];
    if (state.browserSeason !== undefined && state.browserSeason !== null) { order.push(state.browserSeason); }
    for (var i = 0; i < seasons.length; i++) { if (order.indexOf(i) === -1) { order.push(i); } }
    for (var k = 0; k < order.length; k++) {
      var s = seasons[order[k]];
      if (!s) { continue; }
      var list = (s.id === (item.seasonId || item.id) && item.episodes && item.episodes.length) ? item.episodes : s._episodes;
      if (has(list)) { return order[k]; }
    }
    return -1;
  }

  function chooseEpisode(ep) {
    var item = state.playerItem;
    if (!item || !ep) { return; }
    var seasons = seriesSeasons(item);
    var prev = seasons[state.playerSeasonIndex];
    if (prev && prev.id === (item.seasonId || item.id) && item.episodes && item.episodes.length) {
      prev._episodes = item.episodes;
    }
    /* Use the season the chosen episode belongs to. Taking the season that
       was playing sent "T6 episode 1" inside "T1", and the portal answered
       portal100008 (the programme does not exist). */
    var sIdx = seasonIndexOfEpisode(item, ep);
    if (sIdx < 0) {
      sIdx = state.episodeBrowserOpen ? (state.browserSeason || 0)
        : ((state.playerSeasonIndex !== undefined && state.playerSeasonIndex !== null) ? state.playerSeasonIndex : 0);
    }
    state.playerSeasonIndex = sIdx;
    var season = seasons[sIdx];
    if (season) {
      if (state.detailSeason !== sIdx) {
        state.detailSeason = sIdx;
        state.detailNeedsRebuild = true;
      }
      if (season.id) { item.seasonId = season.id; }
      if (season._episodes) { item.episodes = season._episodes; }
    }
    closeEpisodeBrowser();
    if (playSettingViewOpen) { closePlaySettingView(); }
    playEpisode(item, ep);
  }

  /* Single path for changing episode while watching: keeps the detail screen,
     the infobar and the resolver on the same episode. */
  function playEpisode(item, ep) {
    if (!item || !ep) { return; }
    state.playerItem = item;
    state.playerEpisode = ep;
    state.detailEpisode = ep;
    state.playerSeasonIndex = state.detailSeason || 0;
    /* Drop the previous episode's subtitles right away; the new episode
       loads its own. They stayed on screen over a failed episode switch. */
    subtitleSeq++;
    activeSubtitleCues = [];
    if (playerSubtitles) { playerSubtitles.innerHTML = ''; }
    if (playerStage && playerInfo) { updatePlayer(); }
    syncDetailEpisodeHighlight(item);
    /* Starfish retains the old UMS/video pipeline briefly after src is
       cleared.  Starting a new episode in the same turn can exceed the RAM
       budget of webOS 4, especially with the FFmpeg relay.  Release first,
       then create exactly one replacement pipeline. */
    if (state.episodeSwitchTimer) { clearTimeout(state.episodeSwitchTimer); }
    state.episodeSwitchSeq = (state.episodeSwitchSeq || 0) + 1;
    var switchSeq = state.episodeSwitchSeq;
    stopPlayerVideo();
    setPlayerStatus('Cambiando capítulo…');
    state.episodeSwitchTimer = setTimeout(function () {
      state.episodeSwitchTimer = null;
      /* Also on the title page: an episode picked there plays in its preview.
         Before, only the full-screen player restarted, so the page kept
         "Cambiando capítulo…" with no video until the 30 s watchdog showed
         "No se pudo cargar … tarda en responder". */
      if (switchSeq !== state.episodeSwitchSeq || (state.screen !== 'player' && state.screen !== 'detail')) { return; }
      startPlayerVideo(item, ep);
    }, 600);
  }

  function episodeListForCurrentSeason(item) {
    var seasons = seriesSeasons(item);
    var season = seasons[state.playerSeasonIndex] || seasons[0];
    if (!season) { return []; }
    if (season.id === (item.seasonId || item.id) && item.episodes && item.episodes.length) { return item.episodes; }
    return season._episodes || [];
  }

  function showNextEpisodeLoading(item) {
    if (!nextEpisodeLoading) { nextEpisodeLoading = $('next-episode-loading'); }
    if (!nextEpisodeLoading) { return; }
    var image = (item && (item.backdrop || item.landscape || item.poster)) || '';
    nextEpisodeLoading.style.backgroundImage = image ? 'url("' + String(image).replace(/"/g, '%22') + '")' : '';
    nextEpisodeLoading.classList.add('is-active');
  }

  function hideNextEpisodeLoading() {
    if (!nextEpisodeLoading) { nextEpisodeLoading = $('next-episode-loading'); }
    if (!nextEpisodeLoading) { return; }
    nextEpisodeLoading.classList.remove('is-active');
    nextEpisodeLoading.style.backgroundImage = '';
  }

  function advanceToNextEpisode() {
    var item = state.playerItem;
    if (!item || !isSeriesItem(item) || state.screen !== 'player') { return; }
    var episodes = episodeListForCurrentSeason(item);
    var current = state.playerEpisode;
    var index = -1;
    for (var i = 0; i < episodes.length; i++) {
      if (current && (episodes[i].id === current.id || episodes[i].number === current.number)) { index = i; break; }
    }
    if (index < 0) { return; }
    showNextEpisodeLoading(item);
    if (index + 1 < episodes.length) {
      playEpisode(item, episodes[index + 1]);
      return;
    }
    /* At the end of a season, fetch only the first chapter of the next one.
       The previous season's episode array stays cached, so this does not turn
       the compact player selector into a full all-season list. */
    var seasons = seriesSeasons(item);
    var nextSeasonIndex = (state.playerSeasonIndex || 0) + 1;
    var nextSeason = seasons[nextSeasonIndex];
    if (!nextSeason) { hideNextEpisodeLoading(); return; }
    var endedEpisode = current;
    seasonEpisodes(item, nextSeason, function (nextEpisodes) {
      if (state.playerItem !== item || state.playerEpisode !== endedEpisode || state.screen !== 'player') {
        return;
      }
      if (!nextEpisodes || !nextEpisodes.length) { hideNextEpisodeLoading(); return; }
      state.detailSeason = nextSeasonIndex;
      state.playerSeasonIndex = nextSeasonIndex;
      item.seasonId = nextSeason.id || item.seasonId;
      item.episodes = nextEpisodes;
      nextSeason._episodes = nextEpisodes;
      playEpisode(item, nextEpisodes[0]);
    });
  }

  /* Text of a TV player button, keeping its icon. */
  function setActLabel(btn, text) {
    var label = btn && btn.querySelector('.pi-act-label');
    if (label) { label.textContent = text; } else if (btn) { btn.textContent = text; }
  }

  function syncDetailEpisodeHighlight(item) {
    if (!detailBottom) { return; }
    var tiles = detailBottom.querySelectorAll('.detail-episode');
    for (var i = 0; i < tiles.length; i++) {
      var on = !!(tiles[i]._ep && state.detailEpisode && tiles[i]._ep.id === state.detailEpisode.id);
      tiles[i].classList.toggle('is-playing', on);
    }
  }

  function renderPlaySettingPlayerOptions() {
    /* Videoteca: Directo only, so no Normal / Modo fluido choice. */
    if (psvSecPlayer) {
      psvSecPlayer.classList.toggle('is-hidden', !!(state.playerItem && state.playerItem._videoteca));
    }
    /* 'normal' is the default direct path; only 'relay'/'smooth' means FFmpeg. */
    var isRelay = (state.streamMode === 'relay' || state.streamMode === 'smooth');
    if (psvBtnP1) {
      psvBtnP1.classList.toggle('is-selected', isRelay);
      var chk1 = psvBtnP1.querySelector('.psv-check');
      if (chk1) chk1.style.display = isRelay ? 'block' : 'none';
    }
    if (psvBtnP2) {
      psvBtnP2.classList.toggle('is-selected', !isRelay);
      var chk2 = psvBtnP2.querySelector('.psv-check');
      if (chk2) chk2.style.display = !isRelay ? 'block' : 'none';
    }
  }

  function renderPlaySettingAspectOptions() {
    if (!psvAspectRow) return;
    var btns = psvAspectRow.querySelectorAll('.psv-btn');
    for (var i = 0; i < btns.length; i++) {
      var asp = btns[i].getAttribute('data-aspect');
      var isSel = (asp === playerCurrentAspect);
      btns[i].classList.toggle('is-selected', isSel);
      var chk = btns[i].querySelector('.psv-check');
      if (chk) chk.style.display = isSel ? 'block' : 'none';
    }
  }

  function setPlayerAspect(aspect, mode) {
    mode = mode || aspectModeKey();
    aspectByMode[mode] = aspect || 'contain';
    if (mode === 'live') {
      try { localStorage.setItem(LIVE_ASPECT_KEY, aspectByMode.live); } catch (eSaveAspect) { /* ignore */ }
    }
    /* Solo cambia la imagen si es el modo que se está viendo. */
    if (mode === aspectModeKey()) { applyModeAspect(); }
  }

  function openPlaySettingsDialog(fromItem) {
    if (!dialogPlaySettings) { buildPlayer(); }
    if (!dialogPlaySettings) return;
    if (playSettingTimer) { clearTimeout(playSettingTimer); playSettingTimer = null; }
    dialogPlaySettingsOpen = true;
    dialogReturnFocus = state.focus;

    var item = fromItem || playSettingsItem();
    if (state.screen === 'detail') { item = state.detail || item; }

    renderDialogAudio();
    renderDialogSubtitle();
    applySubtitleStyles();

    dialogPlaySettings.classList.add('is-active');

    ensureMediaInfo(item, function () {
      if (!dialogPlaySettingsOpen) { return; }
      renderDialogAudio();
      renderDialogSubtitle();
    });

    /* Focus first audio pill or switch */
    var firstFocus = (dpsAudioOptions && dpsAudioOptions.querySelector('.focusable')) || dpsSubSwitch || dpsBtnExit;
    if (firstFocus) { setFocus(firstFocus); }
  }

  function closePlaySettingsDialog() {
    dialogPlaySettingsOpen = false;
    if (dialogPlaySettings) { dialogPlaySettings.classList.remove('is-active'); }
    if (playSettingViewOpen) {
      if (psvBtnConfig) { setFocus(psvBtnConfig); }
      schedulePlaySettingHide();
    } else if (dialogReturnFocus && isVisible(dialogReturnFocus)) {
      setFocus(dialogReturnFocus);
    } else if (state.screen === 'player') {
      setFocus(playerStage);
    }
    dialogReturnFocus = null;
  }

  function renderDialogAudio() {
    if (!dpsAudioOptions) return;
    clear(dpsAudioOptions);

    var info = mediaInfoCache[mediaInfoKey(playSettingsItem())];
    if (info && !vodAudioChosen) {
      vodCurrentAudioTrack = preferredAudioIndex(info.audio);
    }
    var tracks = audioLanguageList(info);
    if (!tracks.length) {
      /* mediaInfo has not answered yet: keep the current language visible. */
      tracks = [{ index: vodCurrentAudioTrack || 0, label: 'Español' }];
    }
    var audioNames = numberRepeated(tracks.map(function (tr) { return tr.label; }));
    for (var t = 0; t < tracks.length; t++) {
      (function (track, name) {
        var btn = el('button', 'dps-btn focusable');
        btn.textContent = name;
        if (vodCurrentAudioTrack === track.index) { btn.classList.add('is-selected'); }
        btn._activate = function () {
          switchAudioTrack(track.index);
          renderDialogAudio();
          schedulePlaySettingHide();
        };
        dpsAudioOptions.appendChild(btn);
      })(tracks[t], audioNames[t]);
    }
  }

  /* Two Spanish tracks (or subtitle files) showed as "Español, Español".
     Desktop numbers the repeated names: "Español 1", "Español 2". */
  function numberRepeated(names) {
    if (!window.XUPER_DESKTOP) { return names.slice(); }
    var total = {}, seen = {};
    names.forEach(function (n) { total[n] = (total[n] || 0) + 1; });
    return names.map(function (n) {
      if (total[n] < 2) { return n; }
      seen[n] = (seen[n] || 0) + 1;
      return n + ' ' + seen[n];
    });
  }

  function renderDialogSubtitle() {
    var info = mediaInfoCache[mediaInfoKey(playSettingsItem())];
    var list = subtitleLanguageList(info);

    if (dpsSubSwitch) {
      /* Without subtitle files there is nothing to switch on. */
      var switchRow = dpsSubSwitch.parentNode;
      if (switchRow) { switchRow.classList.toggle('is-hidden', !list.length); }
      dpsSubSwitch.classList.toggle('is-on', vodSubActive);
      var dotText = dpsSubSwitch.querySelector('.dps-switch-text');
      if (dotText) dotText.textContent = vodSubActive ? 'ON' : 'OFF';
    }

    if (dpsRowLang) dpsRowLang.classList.toggle('is-visible', vodSubActive && list.length > 0);
    if (dpsRowSize) dpsRowSize.classList.toggle('is-visible', vodSubActive && list.length > 0);
    if (dpsRowStyle) dpsRowStyle.classList.toggle('is-visible', vodSubActive && list.length > 0);

    if (!vodSubActive) return;

    /* Render languages */
    if (dpsLangOptions) {
      clear(dpsLangOptions);
      var subNames = numberRepeated(list.map(function (sb) { return formatAudioLang(sb.lang || 'Sub'); }));
      for (var s = 0; s < list.length; s++) {
        (function (sub, subName) {
          var btn = el('button', 'dps-btn focusable');
          btn.textContent = subName;
          if (vodCurrentSubtitle && vodCurrentSubtitle.url === sub.url) {
            btn.classList.add('is-selected');
          }
          btn._activate = function () {
            vodCurrentSubtitle = sub;
            vodSubActive = true;
            vodSubChosen = true;
            loadSubtitleTrack(sub);
            renderDialogSubtitle();
            schedulePlaySettingHide();
          };
          dpsLangOptions.appendChild(btn);
        })(list[s], subNames[s]);
      }
    }

    /* Size buttons */
    if (dpsSizeOptions) {
      var sBtns = dpsSizeOptions.querySelectorAll('.dps-btn');
      for (var si = 0; si < sBtns.length; si++) {
        var sz = sBtns[si].getAttribute('data-size');
        sBtns[si].classList.toggle('is-selected', sz === vodSubSize);
      }
    }

    /* Style buttons */
    if (dpsStyleOptions) {
      var stBtns = dpsStyleOptions.querySelectorAll('.dps-btn');
      for (var sti = 0; sti < stBtns.length; sti++) {
        var st = stBtns[sti].getAttribute('data-style');
        stBtns[sti].classList.toggle('is-selected', st === vodSubStyle);
      }
    }
  }

  function formatAudioLang(code) {
    var c = (code || '').toLowerCase().trim().split(/[-_]/)[0];
    if (/^(spa|esp|es|castellano|latino|lat|latam)$/.test(c)) return 'Español';
    if (/^(eng|ing|en)$/.test(c)) return 'Inglés';
    if (/^(jpn|jap|ja)$/.test(c)) return 'Japonés';
    if (/^(kor|cor|ko)$/.test(c)) return 'Coreano';
    if (/^(por|pt)$/.test(c)) return 'Portugués';
    if (/^(fra|fre|fr|franc)$/.test(c)) return 'Francés';
    if (/^(ita|it)$/.test(c)) return 'Italiano';
    if (/^(deu|ger|de)$/.test(c)) return 'Alemán';
    if (/^(chi|zho|zh)$/.test(c)) return 'Chino';
    return c ? (c.charAt(0).toUpperCase() + c.slice(1)) : 'Pista';
  }

  /* A direct MP4/TS source must stay direct when the viewer selects an audio
     language.  Some webOS media pipelines expose the native AudioTrackList;
     in that case the change is immediate and does not need FFmpeg.  Older
     sets expose no writable list, so we leave the existing source untouched
     instead of silently changing the player to Modo Fluido. */
  function selectNativeAudioTrack(trackIndex) {
    if (!playerVideo) { return false; }
    var tracks;
    try { tracks = playerVideo.audioTracks; } catch (eTracks) { return false; }
    if (!tracks || !tracks.length || !(trackIndex >= 0 && trackIndex < tracks.length)) {
      return false;
    }
    try {
      for (var i = 0; i < tracks.length; i++) {
        tracks[i].enabled = (i === trackIndex);
      }
      return true;
    } catch (eSelect) {
      return false;
    }
  }

  /* Directo source from the local service (…/stream.ts), with ?a=<n> set to
     the audio stream to play (0 = the file's first one). */
  function withDirectAudio(url, trackIndex) {
    if (!url || !/\/media\/[a-f0-9]+\/stream\.ts(?:\?|$)/i.test(url)) { return url; }
    var clean = url.replace(/([?&])a=\d+(&|$)/, function (all, pre, post) { return post ? pre : ''; }).replace(/[?&]$/, '');
    var n = Math.max(0, Number(trackIndex) || 0);
    return n > 0 ? clean + (clean.indexOf('?') === -1 ? '?' : '&') + 'a=' + n : clean;
  }
  function currentDirectSource() {
    if (!playerVideo) { return ''; }
    var node = playerVideo.querySelector('source');
    var src = (node && node.getAttribute('src')) || '';
    return /\/media\/[a-f0-9]+\/stream\.ts(?:\?|$)/i.test(src) ? src : '';
  }

  function switchAudioTrack(trackIndex) {
    /* On the detail screen the choice is only remembered for the next play. */
    if ((state.screen !== 'player' && !(window.XUPER_DESKTOP && state.screen === 'detail' && playerVideo && playerVideo.currentSrc)) || !playerVideo) {
      vodCurrentAudioTrack = trackIndex;
      vodAudioChosen = true;
      return;
    }
    /* Normal (Directo) must never be converted to Fluido merely by opening
       the audio selector.  Use the native track list when webOS provides it.
       A TV without that API keeps its playing source and clearly tells the
       viewer that a remux is required for per-track selection. */
    if (state.streamMode !== 'relay' && state.streamMode !== 'smooth') {
      /* Desktop Directo: the local service lists the chosen audio stream
         first, so reload the same source at the same second. */
      var directSrc = currentDirectSource();
      if (window.XUPER_DESKTOP && directSrc) {
        var resumeAt = playerVideo.currentTime || 0;
        var keepPaused = playerVideo.paused && state.screen === 'player';
        vodCurrentAudioTrack = trackIndex;
        vodAudioChosen = true;
        audioTrackSwitchUntil = Date.now() + 8000;
        setPlayerStatus('Cambiando idioma…');
        playUrl(withDirectAudio(directSrc, trackIndex), { startPosition: resumeAt, remainPaused: keepPaused });
        return;
      }
      if (selectNativeAudioTrack(trackIndex)) {
        vodCurrentAudioTrack = trackIndex;
        vodAudioChosen = true;
        audioTrackSwitchUntil = Date.now() + 5000;
        setPlayerStatus('Idioma cambiado');
      } else {
        setPlayerStatus('Este reproductor no permite cambiar audio en Normal. Usa Modo Fluido para esa pista.');
      }
      return;
    }
    vodCurrentAudioTrack = trackIndex;
    vodAudioChosen = true;
    /* HTML5 cannot pick a PID inside a TS/MP4, so the FFmpeg relay maps it
       with -map 0:a:<n>. */
    if (relayBaseUrl) {
      var curSec = relayStartOffset + (playerVideo.currentTime || 0);
      playUrl(relayBaseUrl + '?start=' + Math.floor(curSec) + '&a=' + trackIndex);
      return;
    }
    restartCurrentPlayback();
  }

  function restartCurrentPlayback() {
    if (!playerVideo) return;
    var curSec = relayBaseUrl ? (relayStartOffset + (playerVideo.currentTime || 0)) : (playerVideo.currentTime || 0);
    /* Restarted (another version, quality) before reaching the chosen
       "continue" point: keep that point instead of going back to 0. */
    var carried = resumeCarryFor(state.playerItem, state.playerEpisode);
    if (carried && curSec < carried - 5) { curSec = carried; }
    var wasPaused = playerVideo.paused;
    var item = state.playerItem;
    stopPlayerVideo();
    setPlayerStatus('Cambiando reproductor…');
    resolvePlayerStream(item, function (url) {
      if (url) {
        if (isRelayUrl(url)) {
          var seekUrl = url + '?start=' + Math.floor(curSec);
          if (vodCurrentAudioTrack) { seekUrl += '&a=' + vodCurrentAudioTrack; }
          playUrl(seekUrl, { remainPaused: wasPaused });
        } else {
          playUrl(url, { startPosition: curSec, remainPaused: wasPaused });
        }
      } else if (!state.streamError) {
        setPlayerStatus('Sin fuente de reproducción');
      }
    });
  }

  function buildPlayer() {
    playerStage = $('player-stage');
    playerInfo = $('player-infobar');
    playerVodInfo = $('player-vod-infobar');
    playerChannels = $('player-channels');
    categoryPicker = $('player-categories');
    pcatGrid = $('pcat-grid');
    pcatSub = $('pcat-sub');
    playerVideo = $('player-video');
    playerStatus = $('player-status');
    nextEpisodeLoading = $('next-episode-loading');
    playerOsdIcon = $('player-osd-icon');
    playerFrame = playerStage ? playerStage.querySelector('.player-frame') : null;

    vodInfobarPoster = $('vod-infobar-poster');
    vodInfobarTitle = $('vod-infobar-title');
    vodTimeCurrent = $('vod-time-current');
    vodTimeTotal = $('vod-time-total');
    vodSeekbar = $('vod-seekbar');
    vodSeekProgress = $('vod-seek-progress');
    vodSeekBuffered = $('vod-seek-buffered');
    vodSeekThumb = $('vod-seek-thumb');

    if (vodSeekbar) {
      vodSeekbar.classList.add('focusable');
      vodSeekbar._activate = function () { leaveVodScrub(true); };
      vodSeekbar._onMove = function (dir) {
        if (dir === 'left') { moveVodScrub(-1); return true; }
        if (dir === 'right') { moveVodScrub(1); return true; }
        if (dir === 'down' || dir === 'up') { leaveVodScrub(false); return true; }
        return false;
      };
    }

    /* PlaySettingView elements */
    playSettingView = $('player-playsetting-view');
    psvSecSelection = $('psv-sec-selection');
    psvEpisodesRow = $('psv-episodes-row');
    psvBtnEpisodes = $('psv-btn-episodes');
    psvBtnConfig = $('psv-btn-config');
    psvBtnP1 = $('psv-btn-p1');
    psvBtnP2 = $('psv-btn-p2');
    psvSecAudio = $('psv-sec-audio');
    psvSecQuality = $('psv-sec-quality');
    psvQualityRow = $('psv-quality-row');
    psvSecAspect = $('psv-sec-aspect');
    psvSecPlayer = $('psv-sec-player');
    psvBtnFeedback = $('psv-btn-feedback');
    psvAspectRow = $('psv-aspect-row');

    /* Season/episode browser */
    episodeBrowser = $('player-episodes');
    peTitle = $('pe-title');
    peSub = $('pe-sub');
    peSeasons = $('pe-seasons');
    peSeasonsCol = $('pe-seasons-col');
    peEpisodes = $('pe-episodes');
    peSeasonLabel = $('pe-season-label');

    if (psvBtnEpisodes) {
      psvBtnEpisodes._activate = function () { openEpisodeBrowser(); };
    }

    if (psvBtnFeedback) {
      if (window.XUPER_DESKTOP) psvBtnFeedback.textContent = 'Diagnóstico';
      psvBtnFeedback._activate = openDesktopDiagnostic;
    }

    if (psvBtnConfig) {
      psvBtnConfig._activate = function () {
        openPlaySettingsDialog();
      };
    }
    if (psvBtnP1) {
      psvBtnP1._activate = function () {
        /* Explicit user action must always recreate the source.  Never use
           the visual selection or a stale URL as a reason to skip it. */
        setSmoothMode(playSettingsItem(), true);
        renderPlaySettingPlayerOptions();
        renderPlaySettingQuality();
        schedulePlaySettingHide();
        restartCurrentPlayback();
      };
    }
    if (psvBtnP2) {
      psvBtnP2._activate = function () {
        setSmoothMode(playSettingsItem(), false);
        renderPlaySettingPlayerOptions();
        renderPlaySettingQuality();
        schedulePlaySettingHide();
        restartCurrentPlayback();
      };
    }
    if (psvAspectRow) {
      var aBtns = psvAspectRow.querySelectorAll('.psv-btn');
      for (var ai = 0; ai < aBtns.length; ai++) {
        (function (b) {
          b._activate = function () {
            var asp = b.getAttribute('data-aspect');
            setPlayerAspect(asp);
          };
        })(aBtns[ai]);
      }
    }

    /* Modal Dialog elements */
    dialogPlaySettings = $('dialog-playsettings');
    dpsAudioOptions = $('dps-audio-options');
    dpsSubSwitch = $('dps-sub-switch');
    dpsRowLang = $('dps-row-lang');
    dpsRowSize = $('dps-row-size');
    dpsRowStyle = $('dps-row-style');
    dpsLangOptions = $('dps-lang-options');
    dpsSizeOptions = $('dps-size-options');
    dpsStyleOptions = $('dps-style-options');
    dpsBtnExit = $('dps-btn-exit');
    playerSubtitles = $('player-subtitles');

    if (dpsSubSwitch) {
      dpsSubSwitch._activate = function () {
        vodSubChosen = true;
        vodSubActive = !vodSubActive;
        if (!vodSubActive) {
          loadSubtitleTrack(null);
        } else {
          var info = mediaInfoCache[mediaInfoKey(playSettingsItem())];
          var subs = subtitleLanguageList(info);
          if (!vodCurrentSubtitle && subs.length) {
            vodCurrentSubtitle = subs[0];
          }
          if (vodCurrentSubtitle) {
            loadSubtitleTrack(vodCurrentSubtitle);
          }
        }
        renderDialogSubtitle();
        schedulePlaySettingHide();
      };
    }

    if (dpsSizeOptions) {
      var sBtns = dpsSizeOptions.querySelectorAll('.dps-btn');
      for (var si = 0; si < sBtns.length; si++) {
        (function (b) {
          b._activate = function () {
            vodSubSize = b.getAttribute('data-size') || 'normal';
            applySubtitleStyles();
            renderDialogSubtitle();
          };
        })(sBtns[si]);
      }
    }

    if (dpsStyleOptions) {
      var stBtns = dpsStyleOptions.querySelectorAll('.dps-btn');
      for (var sti = 0; sti < stBtns.length; sti++) {
        (function (b) {
          b._activate = function () {
            vodSubStyle = b.getAttribute('data-style') || 'white';
            applySubtitleStyles();
            renderDialogSubtitle();
          };
        })(stBtns[sti]);
      }
    }

    if (dpsBtnExit) {
      dpsBtnExit._activate = function () {
        closePlaySettingsDialog();
      };
    }

    applySubtitleStyles();
    applyGlobalPlaybackPreferences();

    clear(playerInfo); clear(playerChannels);

    playerStage.classList.add('focusable');
    playerStage._onMove = function (dir) {
      if (state.playerMode === 'vod') {
        if (dir === 'left') { playerSeek(-10); return true; }
        if (dir === 'right') { playerSeek(10); return true; }
        if (dir === 'down') {
          openPlaySettingView();
          return true;
        }
        if (dir === 'up') {
          enterVodScrub();
          return true;
        }
        return false;
      }
      if (dir === 'left') { openChannelPanel(); return true; }
      if (dir === 'right') { closeChannelPanel(); return true; }
      if (dir === 'up') { setChannel(state.channel - 1); return true; }
      if (dir === 'down') { setChannel(state.channel + 1); return true; }
      return false;
    };
    playerStage._activate = function () {
      if (window.XUPER_DESKTOP && state.screen === 'detail') {
        expandToFullscreen(state.detail, state.detailEpisode);
        return;
      }
      if (state.playerMode === 'vod') {
        togglePlayerPlayPause();
        return;
      }
      if (state.infobar) { hideInfobar(); }
      else { showInfobar(); }
    };

    if (window.XUPER_DESKTOP) bindDesktopPlayback();

    /* --- infobar (layout_live_infobar, 160dp = 240px) --- */
    playerInfo.appendChild(el('div', 'pi-logo'));
    playerInfo.appendChild(el('div', 'pi-index'));
    var nameRow = el('div', 'pi-namerow');
    var nm = el('div', 'pi-name');
    nameRow.appendChild(nm);
    var uhd = el('div', 'pi-uhd');
    uhd.style.left = '20px';
    nameRow.appendChild(uhd);
    playerInfo.appendChild(nameRow);
    playerInfo.appendChild(el('div', 'pi-date'));
    playerInfo.appendChild(el('div', 'pi-range'));
    playerInfo.appendChild(el('div', 'pi-now'));
    playerInfo.appendChild(el('div', 'pi-next'));
    var seek = el('div', 'pi-seek');
    seek.appendChild(el('div', 'bar'));
    playerInfo.appendChild(seek);
    playerInfo.appendChild(el('div', 'pi-menu', 'info'));
    playerInfo.appendChild(el('div', 'pi-quality', 'HD'));
    playerInfo.appendChild(el('div', 'pi-scale', 'Normal'));
    playerInfo.appendChild(el('div', 'pi-func', 'Selecion de función'));

    var actions = el('div', 'pi-actions');
    var actDefs = [
      { label: 'Pip', right: 446, w: 67, hidden: true },
      { label: 'HD', right: 389, w: 67 },
      { label: 'Anterior', right: 333, w: 67 },
      { label: 'Formato', right: 249, w: 120 },
      { label: 'Favorito', right: 219, w: 67 },
      { label: 'Reproductor 1', right: 151, w: 90 },
      { label: 'Bloquear', right: 107, w: 67 },
      { label: 'Feedback', right: 50, w: 67 }
    ];
    if (window.XUPER_DESKTOP) actDefs.push({ label: 'Canales', right: 0, w: 90 });
    for (var i = 0; i < actDefs.length; i++) {
      var d = actDefs[i];
      if (d.hidden) { continue; }
      var b = el('div', 'pi-act focusable', d.label);
      if (window.XUPER_DESKTOP) {
        var actIcon = { 'HD': 'hd', 'Anterior': 'prev', 'Formato': 'aspect', 'Favorito': 'star',
          'Reproductor 1': 'retry', 'Bloquear': 'lock', 'Feedback': 'pulse', 'Canales': 'channels' }[d.label];
        b.innerHTML = (actIcon ? PLAYER_ICONS[actIcon] : '') + '<span class="pi-act-label"></span>';
        b.querySelector('.pi-act-label').textContent = d.label;
      }
      b.style.width = (d.w * 1.5) + 'px';
      b.style.left = (1920 - d.right * 1.5 - d.w * 1.5) + 'px';
      b._kind = d.label;
      if (window.XUPER_DESKTOP) {
        if (d.label === 'HD' || d.label === 'Bloquear') {
          b.setAttribute('aria-disabled', 'true');
          b.title = d.label === 'HD' ? 'La calidad de esta señal es automática' : 'Bloqueo por PIN no disponible';
        }
        if (d.label === 'Reproductor 1') setActLabel(b, 'Reintentar');
        if (d.label === 'Feedback') setActLabel(b, 'Diagnóstico');
      }
      b._activate = (function (label) {
        return function () {
          if (label === 'Anterior') { setChannel(state.channel - 1); }
          else if (label === 'Formato') {
            var sc = playerInfo.querySelector('.pi-scale');
            sc.textContent = sc.textContent === 'Normal' ? '16:9' : (sc.textContent === '16:9' ? '4:3' : 'Normal');
            if (window.XUPER_DESKTOP) setPlayerAspect(sc.textContent === 'Normal' ? 'contain' : (sc.textContent === '16:9' ? '16-9' : '4-3'), 'live');
            layoutInfoTexts();
          } else if (label === 'Favorito') {
            var ch = CHANNELS[state.channel];
            if (ch && ch.m3u) {
              /* Canal de Mis listas: favorito de la lista, no de la TV. */
              ch.fav = mlToggleFav(ch.m3u, function () { mlSyncFavMarks(); });
              this.classList.toggle('is-selected', ch.fav);
              setActLabel(this, ch.fav ? 'En favoritos' : 'Favorito');
            } else if (ch) {
              ch.fav = toggleFavorite({ id: 'live:' + (ch.channelCode || ch.id || ch.name) });
              this.classList.toggle('is-selected', ch.fav);
              setActLabel(this, ch.fav ? 'En favoritos' : 'Favorito');
            }
          } else if (label === 'Canales') { openChannelPanel(); }
          else if (label === 'Feedback') { openDesktopDiagnostic(); }
          else if (label === 'Reproductor 1') { startLiveChannel(CHANNELS[state.channel], true); }
        };
      })(d.label);
      actions.appendChild(b);
    }
    /* Desktop: volume on the TV player too (button, slider, wheel). */
    if (window.XUPER_DESKTOP) { actions.insertBefore(buildVolumeControl('is-live'), actions.firstChild); }
    playerInfo.appendChild(actions);

    /* --- channel panel (frag_live_channel) with category bar and addons --- */
    var pcHeader = el('div', 'pc-header');
    pcHeader.appendChild(el('div', 'pc-title', 'Canales de TV'));
    playerChannels.appendChild(pcHeader);

    var pcCategories = el('div', 'pc-categories scrollable');
    pcCategories.id = 'pc-categories';
    playerChannels.appendChild(pcCategories);

    playerChannels.appendChild(el('div', 'pc-div'));
    var list = el('div', 'pc-list scrollable');
    playerChannels.appendChild(list);
    renderPlayerCategories();
    renderPlayerChannels();

    var menu = el('div', 'pc-menu');
    menu.appendChild(el('div', 'ic'));
    menu.appendChild(el('div', 'l1', 'Presione [OK] para reproducir'));
    menu.appendChild(el('div', 'l2', '(Arriba: Categorías · OK: Filtrar)'));
    playerChannels.appendChild(menu);
  }

  function renderPlayerCategories() {
    if (!playerChannels) { return; }
    var bar = playerChannels.querySelector('.pc-categories');
    if (!bar) { return; }
    var cats = liveCategories && liveCategories.length ? liveCategories : [
      { id: 76182, name: 'Todos' },
      { id: 76206, name: 'Deportes' },
      { id: 76205, name: 'Cine y Series' },
      { id: 76188, name: 'Colombia' },
      { id: 76191, name: 'España' },
      { id: 76197, name: 'México' },
      { id: 'addons', name: '➕ Addons M3U', isAddon: true }
    ];

    /* The portal returns 38 columns.  Rebuilding all 39 pills on every filter
       detached the focused node mid-keypress, so the rail looked alive but the
       d-pad had nowhere to go ("no puedo navegar hacia las categorías").
       The bar is now rebuilt only when the column list itself changes;
       selecting a category just swaps the is-selected class. */
    var key = '';
    for (var kk = 0; kk < cats.length; kk++) { key += cats[kk].id + '|'; }
    var focusedCat = (state.focus && state.focus._cat) ? state.focus._cat : null;

    if (key !== renderedCategoryKey) {
      clear(bar);
      var pills = [];
      for (var i = 0; i < cats.length; i++) {
        var cat = cats[i];
        var pill = el('button', 'pc-cat-pill focusable', cat.name);
        pill._cat = cat;
        pill._idx = i;
        pill._activate = (function (c) {
          return function () { switchLiveCategory(c); };
        })(cat);
        pill._onMove = (function (idx) {
          return function (dir) {
            if (dir === 'left') {
              if (idx > 0 && pills[idx - 1]) {
                setFocus(pills[idx - 1]);
                scrollPillIntoView(bar, pills[idx - 1]);
              }
              return true;
            }
            if (dir === 'right') {
              if (idx < pills.length - 1 && pills[idx + 1]) {
                setFocus(pills[idx + 1]);
                scrollPillIntoView(bar, pills[idx + 1]);
              } else {
                setFocus(playerStage);
              }
              return true;
            }
            if (dir === 'up') {
              /* All portal columns do not fit in the rail, so Up opens the
                 full-screen category grid (the reference app's "all columns"). */
              openCategoryPicker();
              return true;
            }
            if (dir === 'down') {
              var promo = playerChannels.querySelector('.pc-row-addon-promo');
              if (promo) { setFocus(promo); return true; }
              if (CHANNELS.length) { focusPlayerChannel(state.channel); return true; }
            }
            return false;
          };
        })(i);
        bar.appendChild(pill);
        pills.push(pill);
      }
      bar._pills = pills;
      renderedCategoryKey = key;
    }

    var current = currentLiveCategory || cats[0];
    var now = bar._pills || [];
    for (var j = 0; j < now.length; j++) {
      var p = now[j];
      if (p._cat && current && p._cat.id === current.id) { p.classList.add('is-selected'); }
      else { p.classList.remove('is-selected'); }
    }

    /* Filtering must leave the d-pad on the rail, on the same pill. */
    if (focusedCat) {
      var same = null;
      for (var m = 0; m < now.length; m++) {
        if (now[m]._cat && now[m]._cat.id === focusedCat.id) { same = now[m]; break; }
      }
      if (same) {
        if (state.focus !== same) { setFocus(same); }
        scrollPillIntoView(bar, same);
      }
    }
  }

  function scrollSelectedCategoryPill() {
    if (!playerChannels) { return; }
    var bar = playerChannels.querySelector('.pc-categories');
    var pill = bar ? bar.querySelector('.pc-cat-pill.is-selected') : null;
    if (bar && pill) { scrollPillIntoView(bar, pill); }
  }

  /* Full-screen column picker.  The reference APK opens a separate "all
     columns" screen from the live home (mIvAllColumn); 38 portal categories
     cannot fit in the 453dp in-player rail, so Up on the rail opens this grid. */
  function openCategoryPicker() {
    if (!categoryPicker) {
      categoryPicker = $('player-categories');
      pcatGrid = $('pcat-grid');
      pcatSub = $('pcat-sub');
    }
    if (!categoryPicker || !pcatGrid) { return; }
    state.categoryPickerOpen = true;
    categoryPicker.classList.add('is-active');
    hideInfobar();
    renderCategoryPicker();
    var cur = pcatGrid.querySelector('.pcat-tile.is-selected') || firstIn(pcatGrid);
    if (cur) { setFocus(cur); }
  }

  function closeCategoryPicker(keepFocus) {
    if (!categoryPicker || !state.categoryPickerOpen) { return; }
    state.categoryPickerOpen = false;
    categoryPicker.classList.remove('is-active');
    if (keepFocus) { return; }
    var pill = playerChannels ? playerChannels.querySelector('.pc-cat-pill.is-selected') : null;
    if (pill) { setFocus(pill); scrollSelectedCategoryPill(); }
    else if (state.screen === 'player' && playerStage) { setFocus(playerStage); }
  }

  function renderCategoryPicker() {
    if (!pcatGrid) { return; }
    var cats = liveCategories && liveCategories.length ? liveCategories : [];
    clear(pcatGrid);
    if (pcatSub) {
      pcatSub.textContent = cats.length
        ? (cats.length + ' categorías · elige una para filtrar los canales')
        : 'Cargando categorías…';
    }
    for (var i = 0; i < cats.length; i++) {
      (function (cat) {
        var tile = el('div', 'pcat-tile focusable');
        tile.appendChild(el('div', 'pcat-name', cat.name));
        if (currentLiveCategory && currentLiveCategory.id === cat.id) { tile.classList.add('is-selected'); }
        tile._cat = cat;
        tile._activate = function () {
          switchLiveCategory(cat);
          closeCategoryPicker(true);
          var pill = playerChannels ? playerChannels.querySelector('.pc-cat-pill.is-selected') : null;
          if (pill) { setFocus(pill); scrollSelectedCategoryPill(); }
          else { closeChannelPanel(); }
        };
        pcatGrid.appendChild(tile);
      })(cats[i]);
    }
  }

  function scrollPillIntoView(bar, pill) {
    if (!bar || !pill) { return; }
    var pl = pill.offsetLeft;
    var pw = pill.offsetWidth;
    var bl = bar.scrollLeft;
    var bw = bar.clientWidth;
    if (pl < bl) { bar.scrollLeft = pl - 20; }
    else if (pl + pw > bl + bw) { bar.scrollLeft = pl + pw - bw + 20; }
  }

  function focusPlayerChannel(index) {
    if (!CHANNELS.length) { return; }
    index = Math.max(0, Math.min(CHANNELS.length - 1, Number(index) || 0));
    if (!playerChannelRows[index]) { renderPlayerChannels(index); }
    if (playerChannelRows[index]) { setFocus(playerChannelRows[index]); }
  }

  function renderPlayerChannels(anchorIndex) {
    if (!playerChannels) { return; }
    var list = playerChannels.querySelector('.pc-list');
    if (!list) { return; }
    clear(list);
    playerChannelRows = {};

    /* If in Addons category, display manage promo header at top */
    if (currentLiveCategory && currentLiveCategory.isAddon) {
      var promo = el('div', 'pc-row-addon-promo focusable');
      promo.appendChild(el('div', 'promo-icon', '⚙️'));
      var promoInfo = el('div', 'promo-info');
      promoInfo.appendChild(el('div', 'promo-text', '➕ Administrar Addons y Listas M3U'));
      promoInfo.appendChild(el('div', 'promo-sub', 'Instala listas recomendadas o agrega tu enlace'));
      promo.appendChild(promoInfo);
      promo._activate = function () { openAddonsDialog(); };
      promo._onMove = function (dir) {
        if (dir === 'up') {
          var selCat = playerChannels.querySelector('.pc-cat-pill.is-selected') || playerChannels.querySelector('.pc-cat-pill');
          if (selCat) { setFocus(selCat); }
          return true;
        }
        if (dir === 'down') {
          if (CHANNELS.length) { focusPlayerChannel(0); }
          return true;
        }
        if (dir === 'right') { setFocus(playerStage); return true; }
        return false;
      };
      list.appendChild(promo);
    }

    if (!CHANNELS.length) {
      var emptyRow = el('div', 'pc-empty-channels', 'No hay canales disponibles en esta categoría');
      emptyRow.style.padding = '30px';
      emptyRow.style.color = '#888';
      emptyRow.style.fontSize = '20px';
      list.appendChild(emptyRow);
      return;
    }

    anchorIndex = Number(anchorIndex);
    if (!isFinite(anchorIndex)) { anchorIndex = state.channel; }
    anchorIndex = Math.max(0, Math.min(CHANNELS.length - 1, anchorIndex || 0));
    var firstChannel = Math.max(0, anchorIndex - Math.floor(LIVE_PANEL_WINDOW / 2));
    var lastChannel = Math.min(CHANNELS.length, firstChannel + LIVE_PANEL_WINDOW);
    firstChannel = Math.max(0, lastChannel - LIVE_PANEL_WINDOW);

    for (var c = firstChannel; c < lastChannel; c++) {
      var row = el('div', 'pc-row focusable');
      row._channel = c;
      var ic = el('div', 'ic');
      if (CHANNELS[c].logo) {
        ic.style.backgroundImage = 'url(' + CHANNELS[c].logo + ')';
        ic.style.backgroundSize = 'contain';
        ic.style.backgroundRepeat = 'no-repeat';
        ic.style.backgroundPosition = 'center';
      }
      var num = el('div', 'num', pad2(CHANNELS[c].index || (c + 1)));
      var nm2 = el('div', 'nm', CHANNELS[c].name);
      var epg = el('div', 'epg', CHANNELS[c].now || 'En vivo');
      row.appendChild(ic); row.appendChild(num); row.appendChild(nm2); row.appendChild(epg);
      if (c === state.channel) { row.classList.add('is-current'); }
      row._activate = (function (idx) {
        return function () {
          setChannel(idx, true);
          closeChannelPanel();
          setFocus(playerStage);
        };
      })(c);
      row._onMove = (function (idx) {
        return function (dir) {
          if (dir === 'right') { setFocus(playerStage); return true; }
          if (dir === 'up') {
            if (idx > 0) {
              focusPlayerChannel(idx - 1);
            } else if (idx === 0) {
              var promo = playerChannels.querySelector('.pc-row-addon-promo');
              if (promo) { setFocus(promo); }
              else {
                var selCat = playerChannels.querySelector('.pc-cat-pill.is-selected') || playerChannels.querySelector('.pc-cat-pill');
                if (selCat) { setFocus(selCat); }
              }
            }
            return true;
          }
          if (dir === 'down') {
            if (idx < CHANNELS.length - 1) { focusPlayerChannel(idx + 1); }
            return true;
          }
          return false;
        };
      })(c);
      list.appendChild(row);
      playerChannelRows[c] = row;
    }
  }

  var lastProxyOrigin = '';
  var lastPlayingUrl = '';
  /* Generation counter: incremented every time we start a new stream.
     Async resolve callbacks check this before calling playUrl() so that
     stale responses from previously-selected items are silently dropped. */
  var resolveSeq = 0;
  var relayBaseUrl = '';
  var relayStartOffset = 0;
  /* A fragmented MP4 relay is a one-way HTTP stream.  Several older webOS
     players do not resume that socket after a long pause; opening its local
     URL again at the same offset is the reliable native resume operation. */
  var relayPaused = false;
  var relayPausedAt = 0;
  /* Desktop (Chromium) keeps the relay connection open while paused, and
     FFmpeg reconnects to the CDN by itself (-reconnect).  Reopening the URL
     restarted the whole conversion: 10-16 s of "Cargando vídeo" after every
     pause.  Now the paused stream simply continues; it is reopened only after
     a very long pause or when it does not move again within a few seconds. */
  var RELAY_RESUME_IN_PLACE_MS = 10 * 60 * 1000;
  var RELAY_RESUME_CHECK_MS = 8000;
  var relayResumeCheck = null;

  function reopenRelayAt(position) {
    var resumeUrl = relayBaseUrl + '?start=' + position;
    if (vodCurrentAudioTrack) { resumeUrl += '&a=' + vodCurrentAudioTrack; }
    setPlayerStatus('Reanudando vídeo…');
    playUrl(resumeUrl);
  }

  function resumePlayerPlayback() {
    if (!playerVideo) { return; }
    if (relayResumeCheck) { clearTimeout(relayResumeCheck); relayResumeCheck = null; }
    if (relayPaused && relayBaseUrl && state.playerMode === 'vod') {
      var position = Math.max(0, Math.floor(relayStartOffset + (playerVideo.currentTime || 0)));
      relayPaused = false;
      var inPlace = window.XUPER_DESKTOP && Date.now() - relayPausedAt < RELAY_RESUME_IN_PLACE_MS;
      if (!inPlace) { reopenRelayAt(position); return; }
      var stream = relayBaseUrl, fromTime = playerVideo.currentTime || 0;
      relayResumeCheck = setTimeout(function () {
        relayResumeCheck = null;
        // Paused again, another title, or moving: nothing to do.
        if (relayBaseUrl !== stream || !playerVideo || playerVideo.paused || state.playerMode !== 'vod') { return; }
        if ((playerVideo.currentTime || 0) > fromTime + 0.5) { return; }
        playTimingLog('Modo fluido: tras la pausa el vídeo no avanzó en ' + (RELAY_RESUME_CHECK_MS / 1000) + ' s; se reabre en ' + position + ' s');
        reopenRelayAt(position);
      }, RELAY_RESUME_CHECK_MS);
    }
    try {
      var p = playerVideo.play();
      if (p && p.catch) { p.catch(function () {}); }
    } catch (ePlay) { /* native player rejected resume */ }
  }

  /* Accumulated seek delta + timer for debouncing rapid seek keypresses.
     webOS Starfish fires a full setPreload/dispatchBufferingStart cycle
     for every currentTime assignment, so we batch rapid presses. */
  var seekPending = 0;
  var seekTimer = null;
  /* Starfish emits transient waiting/stalled events even when its HLS buffer
     recovers before a frame is missed.  Delay the visual notice so those
     micro-events do not flash "Cargando vídeo" over a healthy channel. */
  var bufferingNoticeTimer = null;
  function clearBufferingNotice() {
    if (bufferingNoticeTimer) {
      clearTimeout(bufferingNoticeTimer);
      bufferingNoticeTimer = null;
    }
  }
  function scheduleBufferingNotice(text) {
    if (bufferingNoticeTimer || state.streamError) { return; }
    bufferingNoticeTimer = setTimeout(function () {
      bufferingNoticeTimer = null;
      if (!state.streamError && playerVideo && !playerVideo.paused && playerVideo.readyState < 3) {
        setPlayerStatus(text);
      }
    }, 700);
  }
  /* Fragmented-MP4 seeks restart the native video pipeline on webOS 4.  Do
     not start a second one until that pipeline has acknowledged the first. */
  var relaySeekInFlight = false;
  var relaySeekWatchdog = null;
  function releaseRelaySeek() {
    relaySeekInFlight = false;
    if (relaySeekWatchdog) { clearTimeout(relaySeekWatchdog); relaySeekWatchdog = null; }
  }
  function flushSeek() {
    seekTimer = null;
    if (!playerVideo || !seekPending) { seekPending = 0; return; }
    if (relayBaseUrl) {
      if (relaySeekInFlight) { seekPending = 0; return; }
      relaySeekInFlight = true;
      var curSec = relayStartOffset + (playerVideo.currentTime || 0);
      var target = Math.max(0, curSec + seekPending);
      seekPending = 0;
      var totalDur = vodPlaybackDuration();
      if (totalDur > 0 && target > totalDur - 2) { target = Math.max(0, totalDur - 2); }
      var keepPaused = playerVideo.paused;
      var seekUrl = relayBaseUrl + '?start=' + Math.floor(target) + '&a=' + (vodCurrentAudioTrack || 0);
      /* A failed upstream request must not leave controls locked forever. */
      relaySeekWatchdog = setTimeout(releaseRelaySeek, 12000);
      playUrl(seekUrl, { remainPaused: keepPaused });
      return;
    }
    var t = (playerVideo.currentTime || 0) + seekPending;
    seekPending = 0;
    var dur = vodPlaybackDuration();
    if (t < 0) { t = 0; }
    if (dur > 0 && t > dur - 1) { t = dur - 1; }
    try { playerVideo.currentTime = t; } catch (eSeek) { /* ignore */ }
  }
  function playerSeek(delta) {
    if (!playerVideo) { return; }
    seekPending += delta;
    if (seekTimer) { clearTimeout(seekTimer); }
    seekTimer = setTimeout(flushSeek, window.XUPER_DESKTOP ? 150 : 800);
    showInfobar();
    /* OSD feedback while seeking */
    showOsdIcon(delta > 0 ? 'forward' : 'backward', seekPending);
    setTimeout(function () { showOsdIcon('none'); }, 600);
  }

  function vodPlaybackPosition() {
    if (!playerVideo) { return 0; }
    return relayBaseUrl ? (relayStartOffset + (playerVideo.currentTime || 0)) : (playerVideo.currentTime || 0);
  }

  function vodPlaybackDuration() {
    var target = state.playerEpisode || state.playerItem;
    var verified = durationToSeconds(target && target._sourceDuration);
    var metadata = durationToSeconds(target && target.duration);
    var timeline = playerVideo && playerVideo._xuperTimeline;
    var completeHls = timeline && timeline.kind === 'hls' && timeline.complete ? durationToSeconds(timeline.duration) : 0;
    // Native MediaSource.duration may only describe the HLS fragments indexed
    // so far. It is never a title total until the manifest is complete.
    if (verified) return verified;
    if (timeline && timeline.kind === 'native' && timeline.complete && playerVideo.readyState >= 1 && isFinite(playerVideo.duration) && playerVideo.duration > 0) return playerVideo.duration;
    if (metadata) return metadata;
    if (completeHls) return completeHls;
    if (relayBaseUrl || (timeline && timeline.kind !== 'native')) return 0;
    return playerVideo && isFinite(playerVideo.duration) && playerVideo.duration > 0 ? playerVideo.duration : 0;
  }

  function requestVideoDuration(item, episode, payload, attempt) {
    var target = episode || item;
    if (!payload.durationId) return;
    attempt = attempt || 1;
    if (attempt === 1 && target._durationProbe === payload.durationId) return;
    target._durationProbe = payload.durationId;
    target._durationPending = true;
    portalServiceCall('mediaDuration', { durationId: payload.durationId }, function (error, answer) {
      if (target._durationProbe !== payload.durationId) return;
      var duration = !error && answer && answer.returnValue !== false ? durationToSeconds(answer.duration) : 0;
      /* Desktop: a failed measurement is retried (3 attempts in total) while
         the bar shows "Calculando duración…". */
      if (window.XUPER_DESKTOP && !duration && attempt < 3 && !durationToSeconds(target._sourceDuration)) {
        setTimeout(function () {
          if (target._durationProbe === payload.durationId) { requestVideoDuration(item, episode, payload, attempt + 1); }
        }, attempt * 4000);
        return;
      }
      target._durationPending = false;
      if (duration) {
        if (answer.verified) target._sourceDuration = duration;
        if (answer.verified || !durationToSeconds(target.duration)) target.duration = duration;
      }
      if ((state.playerEpisode || state.playerItem) === target) {
        updateVodProgress(vodPlaybackPosition(), vodPlaybackDuration());
        document.dispatchEvent(new CustomEvent('xuper:duration'));
      }
    }, window.XUPER_DESKTOP ? 25000 : 10000);
  }

  function leaveVodScrub(apply) {
    if (!vodScrubbing) { return; }
    var target = vodScrubTime;
    var before = vodPlaybackPosition();
    vodScrubbing = false;
    if (vodSeekbar) { vodSeekbar.classList.remove('is-scrubbing'); }
    if (apply && Math.abs(target - before) >= 1) { playerSeek(target - before); }
    updateVodProgress(vodPlaybackPosition(), vodPlaybackDuration());
    setFocus(playerStage);
    scheduleInfoHide();
  }

  function enterVodScrub() {
    var duration = vodPlaybackDuration();
    if (!vodSeekbar || !duration) { showInfobar(); return; }
    vodScrubTime = Math.max(0, Math.min(duration - 1, vodPlaybackPosition()));
    vodScrubbing = true;
    vodSeekbar.classList.add('is-scrubbing');
    showInfobar();
    if (state.infoTimer) { clearTimeout(state.infoTimer); state.infoTimer = null; }
    updateVodProgress(vodScrubTime, duration);
    setFocus(vodSeekbar);
  }

  function moveVodScrub(direction) {
    var duration = vodPlaybackDuration();
    if (!vodScrubbing || !duration) { return; }
    var step = Math.max(60, Math.min(300, Math.round(duration * 0.05)));
    vodScrubTime = Math.max(0, Math.min(duration - 1, vodScrubTime + (direction * step)));
    updateVodProgress(vodScrubTime, duration);
  }

  function stopPlayerVideo() {
    if (vodSeekbar && vodSeekbar._cancelDesktopScrub) vodSeekbar._cancelDesktopScrub();
    if (state.playerMode === 'vod' && playerVideo) {
      var stopPosition = relayBaseUrl ? (relayStartOffset + (playerVideo.currentTime || 0)) : (playerVideo.currentTime || 0);
      var stopDuration = vodPlaybackDuration();
      rememberWatchProgress(stopPosition, stopDuration, true);
    }
    state.streamError = '';
    clearBufferingNotice();
    setPlayerStatus('');
    showOsdIcon('none');
    stopVodProgressTicker();
    /* Keep the settings panel/dialog open across an audio/quality restart;
       back() and screen changes close them. Keep the loaded cues too: an
       audio/quality switch replaces the source but not the subtitles, and
       showScreen() clears them when the player is really left. */
    /* Cancel any pending seek */
    if (seekTimer) { clearTimeout(seekTimer); seekTimer = null; seekPending = 0; }
    releaseRelaySeek();
    relayPaused = false;
    relayBaseUrl = '';
    relayStartOffset = 0;
    /* Increment generation so any in-flight resolve() callback is ignored */
    resolveSeq++;
    var proxyToAbort = lastProxyOrigin;
    if (!proxyToAbort && lastPlayingUrl && lastPlayingUrl.indexOf('127.0.0.1') !== -1) {
      var m = /^(http:\/\/127\.0\.0\.1:\d+)/.exec(lastPlayingUrl);
      if (m) { proxyToAbort = m[1]; }
    }
    if (proxyToAbort) {
      try {
        var abortXhr = new XMLHttpRequest();
        abortXhr.open('GET', proxyToAbort + '/media/abort', true);
        abortXhr.send();
      } catch (eAbort) { /* ignore */ }
    }
    try {
      portalServiceCall('abortMedia', {}, function () {});
    } catch (eSvc) { /* ignore */ }
    lastPlayingUrl = '';
    lastProxyOrigin = '';
    if (!playerVideo) { return; }
    /* Detach the old Starfish pipeline callbacks before clearing its source.
       Otherwise an asynchronous error from the previous episode can invoke
       the new episode's handler and briefly paint a misleading código 4. */
    playerVideo.onerror = null;
    playerVideo.onwaiting = null;
    playerVideo.onstalled = null;
    playerVideo.onloadeddata = null;
    playerVideo.oncanplay = null;
    playerVideo.onloadedmetadata = null;
    playerVideo.ondurationchange = null;
    playerVideo.onplaying = null;
    playerVideo.onended = null;
    playerVideo.ontimeupdate = null;
    playerVideo.onpause = null;
    playerVideo.onplay = null;
    try { playerVideo.pause(); } catch (e) { /* ignore */ }
    try { playerVideo.currentTime = 0; } catch (e) { /* ignore */ }
    playerVideo.removeAttribute('src');
    try { playerVideo.src = ''; } catch (e) { /* ignore */ }
    while (playerVideo.firstChild) {
      playerVideo.removeChild(playerVideo.firstChild);
    }
    if (window.XUPER_DESKTOP && typeof playerVideo._xuperResetTimeline === 'function') playerVideo._xuperResetTimeline();
    /* NOTE: do NOT call playerVideo.load() here.
       A bare load() with no <source> briefly creates a WebMediaPlayerUMS
       pipeline in Starfish (AID=N) that gets destroyed milliseconds later
       when the real load() arrives, wasting one ACB slot and ~70ms. */
    playerVideo.classList.remove('is-active');
    if (playerFrame) { playerFrame.style.display = 'block'; }
  }

  /* Error del reproductor (códigos de HTML5) en palabras, con qué hacer. */
  function mediaErrorText(code) {
    var vod = state.playerMode === 'vod';
    /* Con Modo Fluido ya activado no tiene sentido sugerirlo: ahí el error casi
       siempre significa que FFmpeg perdió la conexión con el servidor del vídeo. */
    var smooth = vod && state.streamMode === 'smooth';
    var tail = ' (código ' + (code || '?') + ')';
    if (!netOnline()) { return 'Sin conexión a internet: el vídeo se detuvo. Revisa tu wifi o el cable; pulsa Reintentar cuando vuelva.' + tail; }
    if (code === 1) { return 'Se canceló la carga del vídeo. Pulsa Reintentar.' + tail; }
    if (code === 2) { return 'Se cortó la conexión con el servidor del vídeo (tu internet funciona). Pulsa Reintentar.' + tail; }
    if (smooth && (code === 3 || code === 4)) {
      return 'Modo Fluido no pudo preparar el vídeo: se cortó la conexión con el servidor del vídeo. Pulsa Reintentar o desactiva Modo Fluido.' + tail;
    }
    if (code === 3) { return 'El vídeo llegó dañado y no se pudo leer. Pulsa Reintentar' + (vod ? ' o activa Modo Fluido.' : ' o prueba otro canal.') + tail; }
    if (code === 4) { return 'Este vídeo no se puede reproducir en este equipo.' + (vod ? ' Prueba Modo Fluido.' : ' Prueba otro canal.') + tail; }
    return 'No se pudo abrir el vídeo. Pulsa Reintentar.' + tail;
  }

  function setPlayerStatus(text) {
    if (window.XUPER_DESKTOP) {
      document.dispatchEvent(new CustomEvent('xuper:player-status', { detail: {
        text: text || '', error: !!state.streamError, mode: state.playerMode,
        loading: /^(Preparando|Cargando|Conectando|Reintentando|Reanudando|Cambiando)/i.test(text || '')
      } }));
    }
    if (!playerStatus) { playerStatus = $('player-status'); }
    if (!playerStatus) { return; }
    playerStatus.classList.toggle('is-error', !!state.streamError);
    if (text) {
      playerStatus.textContent = text;
      playerStatus.classList.add('is-active');
    } else {
      playerStatus.textContent = '';
      playerStatus.classList.remove('is-active');
    }
  }

  function playUrl(url, playOptions) {
    if (!playerVideo || !url) { return; }
    playOptions = playOptions || {};
    var useNativeHlsFallback = !!playOptions.nativeHls;
    stopPlayerVideo();
    /* Videoteca: player.js starts its HLS at the saved quality and exposes
       the real qualities to the "Calidad" row. Null for every other source. */
    playerVideo._xuperVt = (window.XUPER_DESKTOP && state.playerItem && state.playerItem._videoteca)
      ? { height: vtQualityPref() } : null;
    relayPaused = false;
    lastPlayingUrl = url;
    var mOrigin = /^(http:\/\/127\.0\.0\.1:\d+)/.exec(url);
    if (mOrigin) { lastProxyOrigin = mOrigin[1]; }
    if (isRelayUrl(url)) {
      relayBaseUrl = url.split('?')[0];
      var mStart = /[?&]start=(\d+)/.exec(url);
      relayStartOffset = mStart ? parseInt(mStart[1], 10) : 0;
    } else {
      relayBaseUrl = '';
      relayStartOffset = 0;
    }
    /* A preview loaded in pause behind "Seguir viendo" is not "connecting"
       for the viewer: no banner over the title page, and no 30 s watchdog
       complaining about a slow server before anyone pressed play. */
    state.streamError = '';
    setPlayerStatus(playOptions.remainPaused && state.screen !== 'player' ? '' : 'Conectando con el vídeo…');

    /* The markup defaults to auto too, but set it again because Starfish can
       retain the previous resource's preload mode after source replacement. */
    try { playerVideo.preload = 'auto'; } catch (ePreload) { /* ignore */ }

    var rawMime = (state.playerItem && state.playerItem.streamMime) || '';
    var isHls = (url.indexOf('.m3u8') !== -1) || (rawMime.indexOf('mpegurl') !== -1) || !!(state.playerItem && state.playerItem.isHls);
    var mime = isHls ? 'application/vnd.apple.mpegurl' : ((url.indexOf('.mp4') !== -1 || rawMime.indexOf('mp4') !== -1) ? 'video/mp4' : 'video/mp2t');

    playerVideo.onerror = function () {
      hideNextEpisodeLoading();
      releaseRelaySeek();
      var code = playerVideo.error && playerVideo.error.code;
      /* Some newer webOS releases reject Starfish's legacy mediaOption
         parameter for every HLS channel and report MEDIA_ERR_SRC_NOT_SUPPORTED
         (4). Retry only live HLS once with the standard HTML5 HLS source.
         VOD and the FFmpeg Modo Fluido path are intentionally untouched. */
      if (code === 4 && state.playerMode === 'live' && isHls && !useNativeHlsFallback) {
        var failedChannelSeq = liveChannelSeq;
        setPlayerStatus('Reintentando señal con compatibilidad webOS…');
        setTimeout(function () {
          if (state.playerMode === 'live' && liveChannelSeq === failedChannelSeq) {
            playUrl(url, { nativeHls: true });
          }
        }, 0);
        return;
      }
      /* A manual language change on the direct pipeline must preserve Normal
         mode.  Do not mistake the transient native-track error for an
         unsupported stream and silently restart through the FFmpeg relay. */
      if (code === 4 && state.playerMode === 'vod' && state.streamMode === 'normal' &&
          audioTrackSwitchUntil && Date.now() < audioTrackSwitchUntil) {
        audioTrackSwitchUntil = 0;
        state.streamError = 'No fue posible cambiar el idioma en reproducción Normal';
        setPlayerStatus(state.streamError);
        return;
      }
      /* Desktop: the version's server did not answer (or the format cannot
         play here): try another version of the title before Modo fluido. */
      if ((code === 4 || code === 2) && state.playerMode === 'vod' && tryOtherVersion('código ' + code)) {
        return;
      }
      /* Some portal VOD files are rejected by a TV's direct TS pipeline even
         though the same HEVC/AAC content plays when remuxed as fragmented MP4.
         Retry once through the protected Modo Fluido route, never in a loop.
         The retry belongs to this episode only: remembering it for the whole
         series opened every following episode in Modo Fluido even after the
         viewer picked Normal. */
      if (code === 4 && state.playerMode === 'vod' && state.streamMode === 'normal' && state.playerItem && !state.playerItem._videoteca) {
        var failedItem = state.playerItem;
        var failedKey = mediaInfoKey(failedItem) || smoothModeKey(failedItem);
        if (autoSmoothFallbackKey !== failedKey) {
          autoSmoothFallbackKey = failedKey;
          state.streamMode = 'smooth';
          versionFallback.pending = true;   // last resort of the same chain
          setPlayerStatus('Reintentando película en modo compatible…');
          setTimeout(function () {
            if (state.playerMode === 'vod' && state.playerItem === failedItem && state.streamMode === 'smooth') {
              restartCurrentPlayback();
            }
          }, 0);
          return;
        }
      }
      state.streamError = window.XUPER_DESKTOP ? mediaErrorText(code) : 'No se pudo abrir el stream (código ' + (code || 'error') + ')';
      /* Every version was tried and none answered: say that, not "this video
         cannot be played on this computer". */
      if (window.XUPER_DESKTOP && state.playerMode === 'vod' && versionsExhausted()) {
        state.streamError = 'Ningún servidor de este título respondió (se probaron todas las versiones). ' +
          'Espera un momento y pulsa Reintentar. (código ' + (code || '?') + ')';
      }
      playerVideo.classList.remove('is-active');
      if (playerFrame) { playerFrame.style.display = 'block'; }
      setPlayerStatus(state.streamError);
    };
    function clearStatus() {
      clearBufferingNotice();
      setPlayerStatus('');
    }
    /* Desktop: while the video should run but has no frames yet, say so.
       A silent frozen picture looked paused and invited a click that
       really paused it. */
    function clearStatusWhenRunning() {
      if (window.XUPER_DESKTOP && !playerVideo.paused && playerVideo.readyState < 3) {
        if (!state.streamError) { setPlayerStatus('Cargando vídeo…'); }
        return;
      }
      clearStatus();
    }
    /* Directo builds its segment list progressively and HLS.js joins it at
       the newest segment, so an early seek lands short of the target (for
       example 8 s instead of 30 s). Retry until that point is available. */
    var pendingStart = 0;
    var pendingStartTimer = null;
    var pendingSrc = url;
    function stopPendingStart() {
      pendingStart = 0;
      if (pendingStartTimer) { clearInterval(pendingStartTimer); pendingStartTimer = null; }
    }
    function tryPendingStart() {
      if (!pendingStart || !playerVideo) { return stopPendingStart(); }
      var srcNow = playerVideo.currentSrc || '';
      if (srcNow.indexOf('blob:') !== 0 && srcNow !== pendingSrc && srcNow.indexOf(pendingSrc) === -1) { return stopPendingStart(); }
      if (Math.abs((playerVideo.currentTime || 0) - pendingStart) < 3) { return stopPendingStart(); }
      var s = playerVideo.seekable;
      var end = (s && s.length) ? s.end(s.length - 1) : 0;
      if (end >= pendingStart + 1) {
        try { playerVideo.currentTime = pendingStart; } catch (eSeek) { /* retry next tick */ return; }
        stopPendingStart();
      }
    }
    playerVideo.onloadeddata = clearStatusWhenRunning;
    playerVideo.oncanplay = function () {
      releaseRelaySeek();
      clearStatusWhenRunning();
      /* Loaded on purpose in pause ("Seguir viendo" waiting for a decision,
         a seek while paused): it is ready, not stuck.  Clearing "Conectando…"
         also stops the 30 s no-picture watchdog, which otherwise reloaded the
         paused video and made it jump back to 0 when the viewer pressed play. */
      if (playOptions.remainPaused && playerVideo.paused && !state.streamError) { setPlayerStatus(''); }
    };
    playerVideo.onloadedmetadata = function () {
      if (playOptions.startPosition > 0) {
        var target = playOptions.startPosition;
        try { playerVideo.currentTime = target; } catch (eStart) { /* not seekable yet */ }
        playOptions.startPosition = 0;
        if (window.XUPER_DESKTOP && !relayBaseUrl) {
          stopPendingStart();
          pendingStart = target;
          pendingStartTimer = setInterval(tryPendingStart, 500);
          setTimeout(stopPendingStart, 60000);
        }
      }
      clearStatusWhenRunning();
      /* Prefer Spanish on the direct path as well.  Android chooses this PID
         internally; on webOS it is exposed only when the native AudioTrackList
         becomes available with the loaded media metadata. */
      if (state.playerMode === 'vod' && state.streamMode === 'normal') {
        var audioInfo = (state.playerItem && state.playerItem.streamAudioInfo);
        var nativeTrack = vodAudioChosen ? vodCurrentAudioTrack : preferredAudioIndex(audioInfo);
        if (selectNativeAudioTrack(nativeTrack)) {
          vodCurrentAudioTrack = nativeTrack;
        }
      }
      if (state.playerMode === 'vod') {
        var cur = relayBaseUrl ? relayStartOffset : (playerVideo.currentTime || 0);
        var totalDur = vodPlaybackDuration();
        updateVodProgress(cur, totalDur);
      }
    };
    playerVideo.ondurationchange = function () {
      if (state.playerMode === 'vod') {
        var cur = relayBaseUrl ? (relayStartOffset + (playerVideo.currentTime || 0)) : (playerVideo.currentTime || 0);
        var totalDur = vodPlaybackDuration();
        updateVodProgress(cur, totalDur);
      }
    };
    playerVideo.onplaying = function () {
      hideNextEpisodeLoading();
      clearStatus();
    };
    playerVideo.onended = function () {
      if (state.playerMode !== 'vod') { return; }
      /* Desktop: "Cancelar" on the next-episode card stops the jump. */
      if (window.XUPER_DESKTOP && nextEpCancelled && nextEpCancelled === state.playerEpisode) { hideNextEpCard(); return; }
      hideNextEpCard();
      advanceToNextEpisode();
    };
    playerVideo.ontimeupdate = function () {
      if (playerVideo.currentTime > 0) { clearStatusWhenRunning(); }
      if (state.playerMode === 'vod') {
        var cur = relayBaseUrl ? (relayStartOffset + (playerVideo.currentTime || 0)) : (playerVideo.currentTime || 0);
        var totalDur = vodPlaybackDuration();
        updateVodProgress(cur, totalDur);
        updateSubtitleDisplay(cur);
        rememberWatchProgress(cur, totalDur);
      }
    };
    playerVideo.onpause = function () {
      stopVodProgressTicker();
      if (state.playerMode === 'vod') {
        var pausePosition = relayBaseUrl ? (relayStartOffset + (playerVideo.currentTime || 0)) : (playerVideo.currentTime || 0);
        var pauseDuration = vodPlaybackDuration();
        rememberWatchProgress(pausePosition, pauseDuration, true);
        showOsdIcon('pause');
        if (relayBaseUrl) { relayPaused = true; relayPausedAt = Date.now(); }
      }
    };
    playerVideo.onplay = function () {
      if (state.playerMode === 'vod') {
        showOsdIcon('none');
        startVodProgressTicker();
      }
    };
    playerVideo.onwaiting = function () {
      scheduleBufferingNotice('Cargando vídeo…');
    };
    playerVideo.onstalled = function () {
      scheduleBufferingNotice('Conectando…');
    };

    var transportOptions = {
      mediaTransportType: isHls ? 'HLS' : 'URI',
      option: {
        transmission: {
          playTime: { start: 0 }
        }
      }
    };
    var mediaOption = encodeURI(JSON.stringify(transportOptions));
    var typeStr = useNativeHlsFallback ? mime : (mime + ';mediaOption=' + mediaOption);

    while (playerVideo.firstChild) {
      playerVideo.removeChild(playerVideo.firstChild);
    }
    playerVideo.removeAttribute('src');
    /* Newer webOS uses the MIME type and rejects the old custom property.
       Older sets retain the existing path above as their first attempt. */
    if (!useNativeHlsFallback) {
      try { playerVideo.mediaOption = transportOptions; } catch (eOpt) {}
    } else {
      try { playerVideo.mediaOption = null; } catch (eClearOpt) {}
    }

    var srcNode = document.createElement('source');
    srcNode.setAttribute('src', url);
    srcNode.setAttribute('type', typeStr);
    if (isHls) {
      /* LG's HLS pipeline reads mediaOption from the source element. Setting
         video.src afterwards replaces that source and silently drops HLS mode
         on recent webOS releases, resulting in MEDIA_ERR_SRC_NOT_SUPPORTED. */
      try { playerVideo.load(); } catch (eHlsReset) { /* ignore */ }
    }
    playerVideo.appendChild(srcNode);

    if (!isHls) {
      /* Starfish on webOS 3–6 does not reliably start a non-HLS <source>
         alone.  Keep the source node (for mediaOption) AND assign src, also
         for the local Fluent relay.  This is the proven 1.6.15 behaviour and
         prevents the player from staying forever at “Conectando…”. */
      try { playerVideo.src = url; } catch (eSrc) {}
    }
    try { playerVideo.currentTime = 0; } catch (eCt) {}

    playerVideo.classList.add('is-active');
    if (playerFrame) { playerFrame.style.display = 'none'; }
    try {
      playerVideo.load();
      if (playOptions.remainPaused) { playerVideo.pause(); return; }
      var p = playerVideo.play();
      if (p && p.catch) {
        p.catch(function (playError) {
          if (playerVideo.error) { return; }
          /* Desktop: "click to start" only fits a real autoplay block
             (NotAllowedError). A video that could not load, or a play()
             interrupted by the next video, is not fixed by a click: showing
             that message hid the real failure (Videoteca, 13/11/2026). */
          if (window.XUPER_DESKTOP && playError) {
            if (playError.xuperReplaced || lastPlayingUrl !== url) { return; }
            if (playError.xuperUnavailable) {
              var shown = playerStatus && playerStatus.classList.contains('is-active') ? playerStatus.textContent : '';
              state.streamError = shown && !/^(Preparando|Cargando|Conectando)/i.test(shown) ? shown
                : (state.playerItem && state.playerItem._videoteca
                  ? 'El servidor de este título no entregó el vídeo. Pulsa Reintentar o elige otro servidor en la ficha.'
                  : 'No se pudo abrir el vídeo. Pulsa Reintentar.');
              setPlayerStatus(state.streamError);
              return;
            }
            if (playError.name === 'AbortError') { return; }
          }
          state.streamError = window.XUPER_DESKTOP ? 'Haz clic en el vídeo o pulsa Espacio para empezar' : 'Pulsa OK para iniciar la reproducción';
          setPlayerStatus(state.streamError);
        });
      }
    } catch (e2) {
      state.streamError = window.XUPER_DESKTOP ? 'Haz clic en el vídeo o pulsa Espacio para empezar' : 'Pulsa OK para iniciar la reproducción';
      setPlayerStatus(state.streamError);
    }
  }

  /* ¿Puede este equipo reproducir HEVC en Directo? Chromium solo lo hace
     con la tarjeta gráfica (no trae decodificador HEVC por software). */
  var hevcPlayableCache = null;
  function hevcPlayable() {
    if (hevcPlayableCache !== null) { return hevcPlayableCache; }
    var ok = false;
    try {
      var MS = window.MediaSource || window.WebKitMediaSource;
      ok = !!(MS && MS.isTypeSupported && (MS.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"') ||
        MS.isTypeSupported('video/mp4; codecs="hev1.1.6.L120.90"')));
    } catch (eHevc) { ok = false; }
    hevcPlayableCache = ok;
    return ok;
  }

  /* Portal titles need a license + CDN auth that <video> cannot send: the
     service resolves them and exposes a loopback proxy URL.
     We capture the current resolveSeq at call time; if it changes before
     the async response arrives (user navigated away), we discard the result. */
  function resolvePlayerStream(item, done) {
    var mySeq = resolveSeq;
    /* Videoteca: el vídeo lo entrega su propio servicio (Internet Archive o
       un archivo del PC), no el portal.  smooth = Modo fluido (FFmpeg). */
    if (item && item._videoteca) {
      portalServiceCall('videotecaPlay', { id: item.id, serverIndex: item._vtServerIndex || 0, smooth: false }, function (err, payload) {
        if (mySeq !== resolveSeq) { return; }
        if (err || !payload || payload.returnValue === false || !payload.url) {
          state.streamError = mlErrText(err || (payload && payload.errorText), 'No se pudo abrir este título');
          setPlayerStatus(state.streamError);
          return done('');
        }
        if (payload.duration > 0) { item._sourceDuration = payload.duration; }
        if (typeof payload.serverIndex === 'number') {
          item._vtServerIndex = payload.serverIndex;
          if (vt.detail && vt.detail.id === item.id) { vt.serverIndex = payload.serverIndex; }
        }
        item.streamMime = payload.mime || '';
        done(payload.url);
      }, 60000);
      return;
    }
    function resolveNow() {
      versionFallbackBegin();
      var params = { contentId: item.id };
      params.playbackMode = state.streamMode;
      params.forceRelay = state.streamMode === 'smooth' || state.streamMode === 'relay';
      /* A version that worked after a server failure is reused for the rest of
         the session (unless the viewer picks another one). */
      if (window.XUPER_DESKTOP && !state.trackChosen && workingVersionByTitle[versionTitleKey()] !== undefined) {
        state.trackIndex = workingVersionByTitle[versionTitleKey()];
        state.trackChosen = true;
        state.trackAuto = true;
      }
      params.trackIndex = state.trackIndex || 0;
      /* A version picked in "Versiones" is sent as-is; the height preference
         only applies to the automatic choice. */
      params.fluidHw = Number(state.playback.fluidHw) === 1 ? 'off' : 'auto';
      params.fluidHeight = [0, 720, 480][Math.max(0, Math.min(2, Number(state.playback.fluidQuality) || 0))];
      /* Modo fluido has its own quality ("Fluido: original / 720p / 480p"),
         independent of the height saved for Directo.  Its source is the
         version of that same height: converting a 1080p download down to 480p
         measured 16 s to the first picture and repeated stalls (13/11/2026). */
      if (window.XUPER_DESKTOP) {
        params.preferHeight = state.trackChosen ? 0 : (params.forceRelay ? params.fluidHeight : preferredQualityHeight());
      }
      /* Prefer the Spanish PID like the real app when mediaInfo already
         answered; the relay maps it with ffmpeg -map 0:a:<n>. */
      var ep = state.playerEpisode;
      var epKey = (ep && ep.id) || (item && item.id) || '';
      var cachedInfo = mediaInfoCache[epKey] || mediaInfoCache[mediaInfoKey(item)];
      /* Spanish is the default for every episode.  Index 0 is NOT Spanish:
         the portal lists the PIDs in stream order ("por,spa,eng"), so sending
         0 after an episode change made playback start in Portuguese (and the
         FFmpeg relay map the Portuguese PID). */
      var audioList = (cachedInfo && cachedInfo.audio) || (ep && ep.streamAudioInfo) || item.streamAudioInfo || '';
      if (vodAudioChosen) {
        vodCurrentAudioTrack = Math.max(0, Number(vodCurrentAudioTrack) || 0);
      } else {
        vodCurrentAudioTrack = preferredAudioIndex(audioList);
      }
      params.audioTrack = vodCurrentAudioTrack || 0;
      if (isSeriesItem(item)) {
        var epSeries = state.playerEpisode;
        var seriesRef = item.seasonId || item.id;
        if (epSeries && epSeries.id) {
          params.contentId = epSeries.id;
          params.seriesContentId = seriesRef;
        } else {
          if (!item.episodes || !item.episodes.length) {
            vodFailure('los capítulos', item._detailError || 'El servidor no devolvió capítulos reproducibles');
            return done('');
          }
          state.playerEpisode = item.episodes[0];
          params.contentId = item.episodes[0].id;
          params.seriesContentId = seriesRef;
        }
      }
      params.duration = durationToSeconds((state.playerEpisode || item).duration);
      var resolveMethod = params.forceRelay ? 'resolveSmooth' : 'resolve';
      lastVodAttempt = { phase: 'enlace de vídeo', status: 'cargando', error: '' };
      portalServiceCall(resolveMethod, params, function (error, payload) {
        /* Stale response: user already navigated to something else */
        if (mySeq !== resolveSeq) { return; }
        if (playbackSuperseded(error)) { return; }
        if (error || !payload || payload.returnValue === false || !(payload.proxyPath || payload.url)) {
          vodFailure('el enlace de vídeo', error || (payload && payload.errorText) || 'Respuesta vacía del servicio');
          return done('');
        }
        lastVodAttempt = { phase: 'enlace de vídeo', status: 'recibido', error: '' };
        /* Equipos sin decodificador HEVC (gráficas de antes de ~2016): en
           Directo el vídeo se quedaba cargando sin dar error. Si el título es
           HEVC y este equipo no lo reproduce, se usa el Modo fluido para este
           título (el ajuste global sigue en Directo). */
        if (!params.forceRelay && window.XUPER_DESKTOP && /hevc|h\.?265/i.test(String(payload.codec || '')) && !hevcPlayable()) {
          var hevcKey = mediaInfoKey(item) || smoothModeKey(item);
          if (autoSmoothFallbackKey !== hevcKey) {
            autoSmoothFallbackKey = hevcKey;
            /* Remembered for this title (whole series) during the session, so
               an audio change or the next episode does not go back to Directo. */
            setSmoothMode(item, true);
            setPlayerStatus('Este equipo no reproduce HEVC en Directo: usando Modo fluido…');
            versionFallback.pending = true;   // same attempt, not a new chain
            resolveNow();
            return;
          }
        }
        rememberCdnProbe('vod', payload);
        item.streamMime = payload.mime || '';
        item.streamCodec = payload.codec || '';
        if (durationToSeconds(payload.duration) > 0) {
          item.duration = durationToSeconds(payload.duration);
          if (state.playerEpisode) { state.playerEpisode.duration = payload.duration; }
        } else {
          item.duration = item.duration || 0;
        }
        item.subtitles = payload.subtitles || [];
        item.streamAudioInfo = payload.audio || item.streamAudioInfo || '';
        if (state.playerEpisode) { state.playerEpisode.streamAudioInfo = payload.audio || ''; }
        item.isHls = !!payload.isHls;
        if (!vodAudioChosen && payload.audio) {
          vodCurrentAudioTrack = preferredAudioIndex(payload.audio);
        }
        /* resolve already completed startPlayVOD.  Reuse its audio/subtitle
           metadata in the panel instead of requesting the same episode a
           second time when the viewer changes chapters. */
        var resolvedInfo = {
          audio: payload.audio || item.streamAudioInfo,
          subtitles: item.subtitles,
          tracks: payload.availableTracks || [],
          selected: payload.selectedTrack || {},
          selectedIndex: Number(payload.trackIndex) || 0,
          duration: payload.duration || 0
        };
        mediaInfoCache[mediaInfoKey(item)] = resolvedInfo;
        applySubtitleDefaults(resolvedInfo);
        /* Read-only local diagnostics for the webOS inspector.  Do not place
           the stream URL, licence or headers here. */
        try {
          window.__xuperStreamInfo = {
            selectedTrack: payload.selectedTrack || {},
            availableTracks: payload.availableTracks || []
          };
        } catch (eDiag) { /* ignore */ }
        var playable = payload.proxyPath || payload.url || '';
        if (window.XUPER_DESKTOP && !payload.isRelay) { playable = withDirectAudio(playable, vodCurrentAudioTrack); }
        done(playable);
        requestVideoDuration(item, state.playerEpisode, payload);
      });
    }
    if (isSeriesItem(item) && !state.playerEpisode && (!item.episodes || !item.episodes.length) && !item._detailsLoaded) {
      setPlayerStatus('Cargando capítulos…');
      loadVodDetail(item, function (loaded) {
        if (mySeq !== resolveSeq) { return; }
        if (!loaded) { return done(''); }
        resolveNow();
      });
      return;
    }
    resolveNow();
  }

  /* Starts the resolved stream at `startAt` seconds (0 = beginning).  The
     FFmpeg relay (Modo fluido) takes the position in its URL; the direct
     path seeks once the metadata is known. */
  function playFrom(url, startAt, paused) {
    var opts = paused ? { remainPaused: true } : {};
    if (!(startAt > 0)) { return playUrl(url, opts); }
    if (isRelayUrl(url)) {
      var u = url + (url.indexOf('?') === -1 ? '?' : '&') + 'start=' + Math.floor(startAt);
      if (vodCurrentAudioTrack && !/[?&]a=/.test(u)) { u += '&a=' + vodCurrentAudioTrack; }
      return playUrl(u, opts);
    }
    opts.startPosition = startAt;
    playUrl(url, opts);
  }

  /* Banner while the link is asked for.  None for a preview waiting in pause
     behind "Seguir viendo" (the page already says what is happening). */
  function loadingLabel(item, epNum, quiet) {
    if (quiet) { return ''; }
    if (epNum) { return 'Cargando capítulo ' + epNum + '…'; }
    return isSeriesItem(item) ? 'Cargando capítulo…' : 'Cargando película…';
  }
  function startPlayerVideo(item, episode, startAt) {
    if (!playerVideo) { return; }
    if (episode) {
      state.playerEpisode = episode;
      state.playerSeasonIndex = state.detailSeason || 0;
    }
    if (item) { state.playerItem = item; }
    var it = item || state.playerItem;
    /* The inline preview of the title page is not "watching". */
    watchCounted = !window.XUPER_DESKTOP || state.screen === 'player';
    if (startAt === undefined) { startAt = resumeCarryFor(it, state.playerEpisode); }
    /* Title page: the preview loads from where the viewer stopped, so
       "Continuar" goes full screen without waiting. */
    var holdPaused = false;
    /* The title page's preview (openDetail may start it a moment before the
       screen switches to 'detail', when the page was already loaded once). */
    if (window.XUPER_DESKTOP && state.screen !== 'player' && state.detail === it) {
      /* Loaded at the saved minute but paused until the viewer decides. */
      var detailPoint = pendingDetailResume(it, state.playerEpisode);
      if (detailPoint) { startAt = detailPoint.position; holdPaused = true; }
      if (state.detail === it) { refreshDetailResume(it); }
    }
    if (it) { restoreSmoothMode(it); }
    stopPlayerVideo();
    if (!it) { return; }
    /* The link can arrive after the viewer already pressed "Continuar" /
       "Desde el principio" (slow portal): then it must play, at the point
       chosen there, instead of loading in pause for the title page. */
    var startResolved = function (url) {
      var hold = holdPaused, at = startAt;
      if (holdPaused && state.screen === 'player') {
        hold = false;
        at = resumeCarryFor(it, state.playerEpisode);
      }
      playFrom(url, at, hold);
    };
    vodAudioChosen = false;
    vodCurrentAudioTrack = 0;
    /* resolvePlayerStream returns the same audio/subtitle metadata needed by
       the dialog.  Do not issue mediaInfo in parallel here: on every episode
       change that duplicated startPlayVOD and delayed the next chapter.  It is
       only requested while the audio PID order is still unknown, because the
       portal lists it in stream order (index 0 is not Spanish) and Modo Fluido
       maps that index inside FFmpeg. */
    if (it._videoteca) {
      setPlayerStatus(loadingLabel(it, '', holdPaused));
      resolvePlayerStream(it, function (url) {
        if (url) { startResolved(url); }
        else if (!state.streamError) { setPlayerStatus('Sin fuente de reproducción'); }
      });
      return;
    }
    var currentEp = episode || state.playerEpisode;
    var epKey = (currentEp && currentEp.id) || (it && it.id) || '';
    var epInfo = epKey ? mediaInfoCache[epKey] : null;
    var knownAudio = (epInfo && epInfo.audio) || (currentEp && currentEp.streamAudioInfo) || '';
    if (it._portal && !vodAudioChosen && !knownAudio) {
      var started = false;
      var startSeq = resolveSeq;
      var proceed = function () {
        if (started || startSeq !== resolveSeq) { return; }
        started = true;
        var epNum = episode ? (episode.number || episode.seriesNumber || '') : '';
        setPlayerStatus(loadingLabel(it, epNum, holdPaused));
        resolvePlayerStream(it, function (url) {
          if (url) { startResolved(url); }
          else if (!state.streamError) { setPlayerStatus('Sin fuente de reproducción'); }
        });
      };
      /* Never hold playback on the metadata call: after 2.5 s resolve anyway. */
      setTimeout(proceed, 2500);
      ensureMediaInfo(it, function (info) {
        proceed();
      });
      return;
    }
    if (it._portal) {
      var epNum = episode ? (episode.number || episode.seriesNumber || '') : '';
      setPlayerStatus(loadingLabel(it, epNum, holdPaused));
      resolvePlayerStream(it, function (url) {
        if (url) { startResolved(url); }
        else if (!state.streamError) { setPlayerStatus('Sin fuente de reproducción'); }
      });
      return;
    }
    if (!it.streamUrl) { return; }
    playFrom(it.streamUrl, startAt, holdPaused);
  }

  /* ---- "¿Seguir donde lo dejaste?" (Desktop) ----
     When a movie, or the same episode of a series, was left half-way, the
     player asks before starting: continue at the saved minute or from the
     beginning.  Not asked for a few seconds watched (< 30 s) nor for a title
     practically finished (last 5 %, at least the last 90 s). */
  var RESUME_MIN_SEC = 30;
  var resumePrompt = null;
  var resumeCarry = null;     // { key, at }: chosen point, kept across restarts

  function resumeKey(item, episode) {
    if (!item || !item.id) { return ''; }
    return String(item.id) + '|' + (isSeriesItem(item) && episode && episode.id ? String(episode.id) : '');
  }
  function resumeCarryFor(item, episode) {
    return resumeCarry && resumeCarry.key === resumeKey(item, episode) ? resumeCarry.at : 0;
  }
  function shortTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + pad2(m) : String(m)) + ':' + pad2(s);
  }
  function savedResumePoint(item, episode) {
    if (!window.XUPER_DESKTOP || !item || !item.id) { return null; }
    var list = localProfile.history || [];
    var record = null;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(item.id)) { record = list[i]; break; }
    }
    if (!record) { return null; }
    // A series keeps the last episode watched: only that same episode resumes.
    // (A movie may also carry a single "episode" from the portal: ignored.)
    if (isSeriesItem(item) && (record.episodeId || (episode && episode.id))) {
      if (!episode || String(episode.id) !== String(record.episodeId)) { return null; }
    }
    var pos = Math.floor(Number(record.position) || 0);
    var dur = Math.floor(Number(record.duration) || 0);
    if (pos < RESUME_MIN_SEC) { return null; }
    if (dur > 0 && dur - pos < Math.max(90, dur * 0.05)) { return null; }
    return { position: pos, duration: dur, episodeNumber: record.episodeNumber || '' };
  }
  function closeResumePrompt() {
    if (!resumePrompt) { return; }
    window.removeEventListener('keydown', resumePrompt.keys, true);
    if (resumePrompt.el.parentNode) { resumePrompt.el.parentNode.removeChild(resumePrompt.el); }
    resumePrompt = null;
  }
  /* done(seconds): 0 = from the beginning; -1 = the viewer went back. */
  function askResume(item, episode, done) {
    closeResumePrompt();
    var point = savedResumePoint(item, episode);
    if (!point) { return done(0); }
    var box = el('div', 'resume-prompt');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '¿Seguir donde lo dejaste?');
    var card = el('div', 'resume-card');
    card.appendChild(el('div', 'resume-kicker', 'Seguir viendo'));
    card.appendChild(el('div', 'resume-title', (item.title || item.name || 'Este título')));
    var epNum = (episode && (episode.number || episode.seriesNumber)) || point.episodeNumber;
    var where = 'Te quedaste en ' + shortTime(point.position) + (point.duration ? ' de ' + shortTime(point.duration) : '');
    card.appendChild(el('div', 'resume-text', (epNum ? 'Capítulo ' + epNum + ' · ' : '') + where));
    if (point.duration) {
      var bar = el('div', 'resume-bar');
      var fill = el('div', 'resume-fill');
      fill.style.width = Math.max(2, Math.min(100, Math.round(point.position * 100 / point.duration))) + '%';
      bar.appendChild(fill);
      card.appendChild(bar);
    }
    var actions = el('div', 'resume-actions');
    var cont = el('button', 'resume-btn is-primary', 'Continuar desde ' + shortTime(point.position));
    var restart = el('button', 'resume-btn', 'Ver desde el principio');
    var leave = el('button', 'resume-link', 'Volver');
    cont.type = restart.type = leave.type = 'button';
    actions.appendChild(cont); actions.appendChild(restart);
    card.appendChild(actions);
    card.appendChild(leave);
    box.appendChild(card);
    var buttons = [cont, restart, leave], index = 0;
    function mark(i) {
      index = (i + buttons.length) % buttons.length;
      for (var b = 0; b < buttons.length; b++) { buttons[b].classList.toggle('is-focused', b === index); }
      try { buttons[index].focus({ preventScroll: true }); } catch (eFocus) { /* ignore */ }
    }
    function choose(at) { closeResumePrompt(); done(at); }
    function on(button, at) {
      button.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); choose(at); });
      button.addEventListener('mouseenter', function () { mark(buttons.indexOf(button)); });
    }
    on(cont, point.position); on(restart, 0); on(leave, -1);
    // A click outside the card closes it (same as "Volver"); no click reaches
    // what is behind (play/pause, posters).
    box.addEventListener('click', function (event) {
      event.stopPropagation();
      if (event.target === box) { choose(-1); }
    });
    box.addEventListener('dblclick', function (event) { event.stopPropagation(); });
    function keys(event) {
      var k = event.key, code = event.keyCode;
      if (k === 'ArrowRight' || k === 'ArrowDown' || (k === 'Tab' && !event.shiftKey)) { mark(index + 1); }
      else if (k === 'ArrowLeft' || k === 'ArrowUp' || (k === 'Tab' && event.shiftKey)) { mark(index - 1); }
      else if (k === 'Enter' || k === ' ' || code === 13) { buttons[index].click(); }
      else if (k === 'Escape' || k === 'Backspace' || code === 461) { choose(-1); }
      else { return; }   // F11, Ctrl+… keep working
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    resumePrompt = { el: box, keys: keys, cancel: function () { choose(-1); } };
    window.addEventListener('keydown', keys, true);
    // Over the whole app (title page included), not inside the player.
    ($('app') || document.body).appendChild(box);
    mark(0);
  }
  /* The question is asked where the viewer pressed "Reproducir" (title page,
     history…), before anything goes full screen.  The preview behind it is
     paused meanwhile and continues if the viewer cancels.
     proceed(seconds) runs only when a start point was chosen. */
  function askBeforePlaying(item, episode, proceed) {
    var preview = playerVideo && !playerVideo.paused && state.playerItem === item ? playerVideo : null;
    if (preview) { try { preview.pause(); } catch (ePause) { /* ignore */ } }
    askResume(item, episode, function (at) {
      if (at < 0) {
        if (preview && preview === playerVideo && state.playerItem === item) { resumePlayerPlayback(); }
        return;
      }
      proceed(at);
    });
  }

  /* Start, or move the video already playing, at the chosen point.
     at: null = there was nothing to ask (play as usual). */
  function startWithResume(item, episode, keepCurrent, at) {
    var key = resumeKey(item, episode);
    if (resumeCarry && resumeCarry.key !== key) { resumeCarry = null; }
    if (at === null || at === undefined) {
      if (keepCurrent) { watchCounted = true; if (playerVideo && playerVideo.paused) { resumePlayerPlayback(); } return; }
      return startPlayerVideo(item, episode);
    }
    resumeCarry = at > 0 ? { key: key, at: at } : null;
    if (!keepCurrent) { return startPlayerVideo(item, episode, at); }
    watchCounted = true;
    var now = vodPlaybackPosition();
    /* The preview already started at that minute.  Directo jumps back to the
       exact second (cheap); Modo fluido keeps going if it is within a minute,
       because reopening restarts the whole conversion. */
    var close = at > 0 && now >= at - 2 && now - at < (relayBaseUrl ? 60 : 2);
    if (!close && (at > 0 || now > 3)) {
      if (relayBaseUrl) {
        playUrl(relayBaseUrl + '?start=' + Math.floor(at) + '&a=' + (vodCurrentAudioTrack || 0));
        return;
      }
      try { playerVideo.currentTime = at; } catch (eSeek) { /* the player seeks when it can */ }
    }
    /* Pressed before the preview had anything loaded: say so while the link
       arrives (it then starts by itself, see startPlayerVideo). */
    if (playerVideo && playerVideo.readyState === 0) {
      var waitEp = episode && (episode.number || episode.seriesNumber);
      setPlayerStatus(loadingLabel(item, waitEp || '', false));
    }
    resumePlayerPlayback();
  }

  function expandToFullscreen(item, episode, resumeAt) {
    if (resumeAt === undefined) {
      /* The title page already announced "Seguir viendo": Reproducir (or a
         click on the preview) continues; "Desde el principio" passes 0. */
      var askEp = episode || state.detailEpisode || state.playerEpisode;
      if (state.screen !== 'detail') {
        if (savedResumePoint(item, askEp)) {
          askBeforePlaying(item, askEp, function (at) { expandToFullscreen(item, episode || askEp, at); });
          return;
        }
        resumeAt = null;
      } else {
        // Still undecided on the title page: "Reproducir" / the video = continue.
        var point = pendingDetailResume(item, askEp);
        resumeAt = point ? point.position : null;
        if (point) {
          resumeDecidedKey = resumeKey(item, askEp);
          if (!episode) { episode = askEp; }
          refreshDetailResume(item);
        }
      }
    }
    if (!playerStage) { buildPlayer(); }
    /* The detail screen already owns a mini player.  Moving that exact stream
       to fullscreen must not resolve it again, otherwise direct and relay
       VOD both restart from zero. */
    var sameEpisode = !episode || !state.playerEpisode ||
      state.playerEpisode === episode || state.playerEpisode.id === episode.id;
    /* Same title even when the page holds another copy of its record (the
       first visit loads details into a new object): compared by id, or the
       preview restarted from 0 when "Continuar" was pressed. */
    var sameItem = state.playerItem === item ||
      !!(state.playerItem && item && state.playerItem.id && String(state.playerItem.id) === String(item.id));
    var keepCurrentVideo = state.screen === 'detail' && playerVideo &&
      !!playerVideo.src && sameItem && sameEpisode;
    state.playerMode = 'vod';
    applyModeAspect();
    if (item && !sameItem) { resetMediaSelection(); }
    if (item) { state.playerItem = item; }
    if (episode) { state.playerEpisode = episode; }
    if (item) { restoreSmoothMode(item); }
    state.playerReturn = { screen: 'detail', focus: state.focus };

    var scrPlayer = $('screen-player');
    var scrDetail = $('screen-detail');
    if (scrPlayer) {
      scrPlayer.classList.remove('is-mini');
      scrPlayer.classList.add('is-active');
    }
    if (scrDetail) {
      scrDetail.classList.remove('is-active');
    }
    state.screen = 'player';
    radioOnScreen('player');   /* la pelicula o el canal tienen prioridad sobre la radio */
    playerStage.classList.add('is-vod');
    updatePlayer();
    setFocus(playerStage);
    showVodInfobar();

    startWithResume(state.playerItem, state.playerEpisode, keepCurrentVideo, resumeAt);
  }

  function openPlayer(mode, item, episode, resumeAt) {
    if (mode === 'vod' && state.screen === 'detail') {
      expandToFullscreen(item, episode, resumeAt);
      return;
    }
    if (mode === 'vod' && resumeAt === undefined) {
      if (savedResumePoint(item, episode)) {
        askBeforePlaying(item, episode, function (at) { openPlayer(mode, item, episode, at); });
        return;
      }
      resumeAt = null;
    }
    if (!playerStage) { buildPlayer(); }
    /* Desktop: reuse the video that is already playing this channel. */
    var handedOver = false;
    if (mode === 'live' && liveHandoff && liveHandoff.type === 'player') {
      if (liveHandoff.key === liveChannelKey(CHANNELS[state.channel])) {
        returnPlayerToStage(true);
        handedOver = true;
      } else {
        returnPlayerToStage(false);
      }
    } else if (mode === 'live') {
      handedOver = borrowPreviewIntoPlayer();
    }
    if (mode === 'live' && !handedOver) { stopLivePreview(); }
    state.playerMode = mode;
    applyModeAspect();
    if (item && state.playerItem !== item) { resetMediaSelection(); }
    state.playerItem = item || null;
    state.playerEpisode = episode || null;
    if (mode === 'vod' && item) { restoreSmoothMode(item); }
    state.playerReturn = { screen: state.screen, focus: state.focus };
    state.channelsOpen = false;
    playerInfo.classList.remove('is-active');
    playerChannels.classList.remove('is-active');
    playerStage.classList.toggle('is-vod', mode === 'vod');
    updatePlayer();
    showScreen('player');
    setFocus(playerStage);
    updatePlayer();                 /* re-measure now that the screen is visible */
    if (mode === 'vod') {
      showVodInfobar();
      startWithResume(state.playerItem, state.playerEpisode, false, resumeAt);
    } else {
      showInfobar();
      if (handedOver) { setPlayerStatus(''); }
      else { startLiveChannel(CHANNELS[state.channel]); }
    }
  }

  var liveChannelSeq = 0;
  var liveChannelDebounceTimer = null;
  function startLiveChannel(ch, immediate) {
    /* A new channel (or Reintentar) plays in the player's own element. */
    if (liveHandoff && liveHandoff.type === 'preview') { stopLivePreview(); }
    if (liveChannelDebounceTimer) {
      clearTimeout(liveChannelDebounceTimer);
      liveChannelDebounceTimer = null;
    }
    if (!ch) { ch = CHANNELS[state.channel]; }
    if (!ch) { return; }
    if (!ch.channelCode && !ch.streamUrl) { return; }

    var doStart = function () {
      var mySeq = ++liveChannelSeq;
      setPlayerStatus('Cargando señal ' + (ch.name || '') + '…');
      /* Mis listas: la dirección y las cabeceras vienen de la lista del usuario. */
      var resolveMethod = ch.m3u ? 'myListsPlay' : 'resolveLive';
      var resolveParams = ch.m3u ? { u: ch.m3u.u, n: ch.name || '', ua: ch.m3u.ua || '', ref: ch.m3u.ref || '' } :
        (ch.streamUrl ? { streamUrl: ch.streamUrl } : { channelCode: ch.channelCode });
      if (ch.m3u) { ml.playingKey = ch.m3u.k; }
      portalServiceCall(resolveMethod, resolveParams, function (err, payload) {
        if (mySeq !== liveChannelSeq) { return; }
        /* The player was closed while this answer was on its way: do not
           start the channel hidden behind Home (it played with sound). */
        if (window.XUPER_DESKTOP && (state.playerMode !== 'live' ||
            (state.screen !== 'player' && !keepFloatingVideo()))) { return; }
        if (playbackSuperseded(err)) { return; }
        if (err || !payload || payload.returnValue === false) {
          state.streamError = ch.m3u ? (netOnline() ? mlErrText(err || (payload && payload.errorText), 'No se pudo abrir este canal de tu lista.')
              : 'Sin conexión a internet. Revisa tu wifi o el cable.') :
            window.XUPER_DESKTOP ? netExplain(err, 'la señal de ' + (ch.name || 'este canal'))
            : 'No se pudo conectar con la señal' + (err ? ': ' + err : '');
          setPlayerStatus(state.streamError);
          return;
        }
        rememberCdnProbe('live', payload);
        var streamUrl = payload.proxyPath || payload.url;
        if (!streamUrl) {
          state.streamError = window.XUPER_DESKTOP ? 'Este canal no tiene señal en este momento. Prueba otro canal o vuelve más tarde.' : 'Señal no disponible';
          setPlayerStatus(state.streamError);
          return;
        }
        setPlayerStatus('');
        showInfobar();
        playUrl(streamUrl);
      });
    };

    if (immediate) {
      doStart();
    } else {
      liveChannelDebounceTimer = setTimeout(doStart, 180);
    }
  }

  function updatePlayerChannel() {
    if (!playerStage) { return; }
    updatePlayer();
  }

  function updatePlayer() {
    var live = state.playerMode === 'live';
    var ch = CHANNELS[state.channel] || {};
    var idx = playerInfo.querySelector('.pi-index');
    var name = playerInfo.querySelector('.pi-name');
    var date = playerInfo.querySelector('.pi-date');
    var range = playerInfo.querySelector('.pi-range');
    var now = playerInfo.querySelector('.pi-now');
    var next = playerInfo.querySelector('.pi-next');
    var uhd = playerInfo.querySelector('.pi-uhd');
    var logo = playerInfo.querySelector('.pi-logo');

    if (live) {
      var actionButtons = playerInfo.querySelectorAll('.pi-act');
      for (var ab = 0; ab < actionButtons.length; ab++) {
        if (actionButtons[ab]._kind === 'Favorito') {
          actionButtons[ab].classList.toggle('is-selected', !!ch.fav);
          setActLabel(actionButtons[ab], ch.fav ? 'En favoritos' : 'Favorito');
        }
      }
      if (playerVodInfo) { playerVodInfo.classList.remove('is-active'); }
      if (playerInfo) { playerInfo.style.display = ''; }
      idx.style.display = 'block';
      idx.textContent = pad2(ch.index || (state.channel + 1));
      name.textContent = ch.name || '';
      nameRowPosition();
      date.textContent = 'Hoy';
      range.textContent = ch.time || '';
      now.style.display = 'block';
      now.textContent = ch.now || 'En vivo';
      next.style.display = ch.next ? 'block' : 'none';
      if (ch.next) { next.textContent = 'Siguiente: ' + ch.next; }
      uhd.style.display = ch.uhd ? 'block' : 'none';
      logo.style.display = 'block';
      if (logo) {
        if (ch.logo) {
          logo.style.backgroundImage = 'url(' + ch.logo + ')';
        } else {
          logo.style.backgroundImage = '';
        }
      }
    } else {
      if (playerInfo) { playerInfo.classList.remove('is-active'); playerInfo.style.display = 'none'; }
      var item = state.playerItem || VOD[0];
      if (vodInfobarTitle) {
        if (isSeriesItem(item) && state.playerEpisode) {
          var epTitle = state.playerEpisode.title || state.playerEpisode.name;
          var epNum = state.playerEpisode.number || state.playerEpisode.seriesNumber;
          var epLabel = epTitle || (epNum ? ('Capítulo ' + epNum) : '');
          vodInfobarTitle.textContent = epLabel ? (item.title + ' - ' + epLabel) : item.title;
        } else {
          vodInfobarTitle.textContent = item.title;
        }
      }
      if (vodInfobarPoster) {
        vodInfobarPoster.src = item.poster || item.cover || 'assets/original/common/bg_placehoder_vertical.png';
      }
      updateVodProgress(playerVideo ? playerVideo.currentTime : 0, playerVideo ? playerVideo.duration : 0);
    }
    for (var rowIndex in playerChannelRows) {
      if (playerChannelRows.hasOwnProperty(rowIndex)) {
        playerChannelRows[rowIndex].classList.toggle('is-current', playerChannelRows[rowIndex]._channel === state.channel);
      }
    }
    layoutInfoTexts();
  }

  function nameRowPosition() {
    var row = playerInfo.querySelector('.pi-namerow');
    if (!row) { return; }
    var idx = playerInfo.querySelector('.pi-index');
    var nm = row.querySelector('.pi-name');
    var uhd = row.querySelector('.pi-uhd');
    /* Keep a fixed lane for the channel number.  Measuring an auto-width
       number while Starfish is animating the infobar returns inconsistent
       values and can place the name on top of it. */
    var base = 165;

    row.style.position = 'absolute';
    row.style.left = (367.5 + base) + 'px';
    row.style.top = '13.5px';
    row.style.width = '480px';
    row.style.height = '58px';
    row.style.display = 'block';

    nm.style.position = 'absolute';
    nm.style.left = '0px';
    nm.style.top = '8px';                       /* alignBottom with mTextChannelIndex */
    nm.style.width = '480px';
    nm.style.height = '50px';
    nm.style.lineHeight = '50px';

    if (uhd) {
      uhd.style.left = (nm.offsetWidth + 30) + 'px';   /* 20dp */
      uhd.style.top = '18.5px';                        /* alignTop name + 7dp */
    }
  }

  function layoutInfoTexts() {
    var q = playerInfo.querySelector('.pi-quality');
    var s = playerInfo.querySelector('.pi-scale');
    var f = playerInfo.querySelector('.pi-func');
    if (!q || !s || !f) { return; }
    q.style.left = '517.5px';                   /* 345dp */
    s.style.left = (q.offsetLeft + q.offsetWidth + 30) + 'px';   /* 20dp */
    f.style.left = (s.offsetLeft + s.offsetWidth + 30) + 'px';   /* 20dp */
  }

  function openChannelPanel() {
    if (state.playerMode !== 'live') { return; }
    state.channelsOpen = true;
    playerChannels.classList.add('is-active');
    renderPlayerCategories();
    renderPlayerChannels(state.channel);
    /* Bring the active column into view: with 38 portal categories the rail
       is 5000px wide and the selected pill is usually off-screen. */
    scrollSelectedCategoryPill();
    var row = playerChannelRows[state.channel];
    if (row) {
      setFocus(row);
      var list = row.parentNode;
      var top = state.channel * 111;
      if (top < list.scrollTop || top + 109.5 > list.scrollTop + list.clientHeight) {
        list.scrollTop = Math.max(0, top - 120);
      }
    }
  }

  function closeChannelPanel() {
    state.channelsOpen = false;
    playerChannels.classList.remove('is-active');
    if (state.screen === 'player') { setFocus(playerStage); }
  }

  function restorePlayerReturn() {
    hideInfobar();
    hideVodInfobar();
    var ret = state.playerReturn;
    if (ret && ret.screen === 'detail') {
      var scrPlayer = $('screen-player');
      var scrDetail = $('screen-detail');
      if (scrPlayer) {
        scrPlayer.classList.add('is-mini');
        scrPlayer.classList.add('is-active');
      }
      if (scrDetail) {
        scrDetail.classList.add('is-active');
      }
      state.screen = 'detail';
      var rebuiltDetail = false;
      if (state.detailNeedsRebuild && state.detail) {
        /* The episode browser switched season: rebuild the detail list so the
           season dropdown and the episode grid match what is playing. */
        state.detailNeedsRebuild = false;
        buildDetail(state.detail);
        rebuiltDetail = true;
        var sBtn = detailBottom ? detailBottom.querySelector('.detail-season') : null;
        if (sBtn) { setFocus(sBtn); }
      } else if (state.detail) {
        syncDetailEpisodeHighlight(state.detail);
      }
      // Back from watching: the page shows the new "Continuar · …" minute.
      if (state.detail) { refreshDetailResume(state.detail); }
      if (!rebuiltDetail) {
        if (ret.focus && isVisible(ret.focus)) {
          setFocus(ret.focus);
        } else {
          var firstBtn = detailButtons ? detailButtons.querySelector('.focusable') : null;
          if (firstBtn) { setFocus(firstBtn); }
        }
      }
    } else {
      /* Desktop: a TV channel goes on playing in the home preview.  A channel
         of Mis listas does not (that preview belongs to the TV tab). */
      var toHome = !(ret && ret.screen === 'search');
      var handed = window.XUPER_DESKTOP && toHome && !ml.session && borrowPlayerIntoHome();
      if (!handed && !keepFloatingVideo()) { stopPlayerVideo(); }  /* PiP keeps playing while browsing */
      mlEndSession();
      setTimeout(vtAfterPlayer, 0);   /* "Continuar viendo" de la Videoteca al día */
      var scrP = $('screen-player');
      if (scrP) {
        scrP.classList.remove('is-mini');
        scrP.classList.remove('is-active');
      }
      if (ret && ret.screen === 'search') {
        showScreen('search');
        setFocus(ret.focus);
      } else {
        showScreen('home');
        selectTab(state.tab, false);
        if (ret && ret.focus && isVisible(ret.focus)) { setFocus(ret.focus); }
        else if (tabEls[state.tab]) { setFocus(tabEls[state.tab]); }
      }
    }
  }

  /* ---------------------------------------------------------------- display */
  /* The reference UI is authored at 1920×1080. Older sets expose that exact
     logical viewport, whereas some UHD webOS 22/25 sets expose 3840×2160.
     Without this fit pass only the left half of the fixed canvas is painted
     and the right half of the TV remains black. */
  function viewportSize() {
    /* Most webOS builds report the CSS viewport here. Some 2K/4K firmware
       reports a legacy 1280×720 inner viewport while compositing to its full
       physical 1920/3840 panel; using that value alone paints the left part
       of the TV and leaves the right side black. */
    var vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
    var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
    if (!vw || !vh) { vw = 1920; vh = 1080; }
    var panelW = Math.floor((screen && screen.width) || 0);
    var panelH = Math.floor((screen && screen.height) || 0);
    var cssRatio = vw / vh;
    var panelRatio = panelW && panelH ? panelW / panelH : 0;
    /* Only trust screen.* when it is a true UHD/4K panel (>= 2560).
       Never override an HD/720p viewport (1280×720) with a virtual 1920 panel,
       which would force scale=1.0 and crop 640px on the right and 360px on the bottom. */
    if (panelW >= 2560 && panelW >= vw * 1.25 && panelH >= vh * 1.25 &&
        Math.abs(cssRatio - panelRatio) < 0.03) {
      vw = panelW;
      vh = panelH;
    }
    var panel = (panelW > 0 && panelH > 0) ? { w: panelW, h: panelH } : null;
    return { w: vw, h: vh, panel: panel };
  }

  function fitDesignViewport() {
    var app = $('app');
    if (!app) { return; }
    var size = viewportSize();
    var vw = size.w;
    var vh = size.h;
    var scale = Math.min(vw / 1920, vh / 1080);
    if (!isFinite(scale) || scale <= 0) { scale = 1; }
    scale = Math.round(scale * 10000) / 10000;
    /* Keep a non-16:9 display letterboxed instead of stretching the design. */
    var left = Math.max(0, Math.round((vw - (1920 * scale)) / 2));
    var top = Math.max(0, Math.round((vh - (1080 * scale)) / 2));
    app.style.left = left + 'px';
    app.style.top = top + 'px';
    app.style.webkitTransform = 'scale(' + scale + ')';
    app.style.transform = 'scale(' + scale + ')';
    /* Read by the network diagnostics panel: a photo of that screen tells
       which viewport the TV really gave the app (720p / 2K / 4K sets differ). */
    window.__xuperViewport = {
      w: vw, h: vh, scale: scale,
      panelW: size.panel ? size.panel.w : 0,
      panelH: size.panel ? size.panel.h : 0
    };
  }


  function openDesktopDiagnostic() {
    if (dialogAddonsOpen) closeAddonsDialog();
    if (state.episodeBrowserOpen) closeEpisodeBrowser();
    if (state.categoryPickerOpen) closeCategoryPicker();
    if (dialogPlaySettingsOpen) closePlaySettingsDialog();
    if (playSettingViewOpen) closePlaySettingView();
    openSettings();
    for (var i = 0; i < SETTINGS_ITEMS.length; i++) {
      if (SETTINGS_ITEMS[i].id === 'netdiag') { showSettingsPanel(i, true); break; }
    }
  }

  function desktopBack() {
    if (historyDrawerOpen) { closeHistoryDrawer(); return; }
    if (dialogAddonsOpen) { closeAddonsDialog(); return; }
    if (dialogPlaySettingsOpen) { closePlaySettingsDialog(); return; }
    if (state.categoryPickerOpen) { closeCategoryPicker(); return; }
    if (state.episodeBrowserOpen) { closeEpisodeBrowser(); return; }
    if (playSettingViewOpen) { closePlaySettingView(); return; }
    if (state.screen === 'player') {
      leaveVodScrub(false);
      closeChannelPanel();
      restorePlayerReturn();
      return;
    }
    lastBackTime = 0;
    back();
  }

  /* Picture-in-Picture: the video floats in a small window on top of other
     apps. It keeps playing while the viewer browses or minimizes Xuper.
     Subtitles are drawn by the page, so they are not shown in that window. */
  var pipMediaSessionReady = false;
  function setupPipMediaSession() {
    if (pipMediaSessionReady || !navigator.mediaSession) { return; }
    pipMediaSessionReady = true;
    var handlers = {
      play: function () { if (playerVideo) { playerVideo.play().catch(function () {}); } },
      pause: function () { if (playerVideo) { playerVideo.pause(); } },
      seekbackward: function () { playerSeek(-10); },
      seekforward: function () { playerSeek(10); },
      nexttrack: function () {
        if (state.playerMode === 'vod' && isSeriesItem(state.playerItem)) { advanceToNextEpisode(); }
      }
    };
    for (var name in handlers) {
      if (handlers.hasOwnProperty(name)) {
        try { navigator.mediaSession.setActionHandler(name, handlers[name]); } catch (eAction) { /* unsupported */ }
      }
    }
  }

  /* While another title floats in the PiP window, opening a detail page must
     not replace it with an automatic preview. Explicit play still does. */
  function keepFloatingVideo() {
    return !!(playerVideo && document.pictureInPictureElement === playerVideo);
  }

  function autoPreviewAllowed(item) {
    if (!document.pictureInPictureElement || !playerVideo) { return true; }
    return !state.playerItem || state.playerItem === item;
  }

  /* Leaving PiP. Chromium pauses the video when the window is closed with
     its X, and keeps it playing for "back to tab". Closed: stop it if no
     player is on screen. Back: show the same video full size, no restart. */
  var pipLeaveBound = false;
  function bindPipLeave() {
    if (pipLeaveBound || !playerVideo) { return; }
    pipLeaveBound = true;
    playerVideo.addEventListener('leavepictureinpicture', function () {
      setTimeout(function () {
        var visible = state.screen === 'player' || state.screen === 'detail';
        if (playerVideo.paused) {
          if (!visible) { stopPlayerVideo(); }
          return;
        }
        if (state.screen === 'player') { return; }
        showFloatingVideoFullSize();
      }, 0);
    });
  }

  function showFloatingVideoFullSize() {
    var item = state.playerItem;
    if (!item || !playerStage) { return; }
    stopLivePreview();
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) { screens[i].classList.remove('is-active'); }
    if (state.detail !== item) { state.detail = item; state.detailNeedsRebuild = true; }
    state.playerMode = 'vod';
    applyModeAspect();
    state.playerReturn = { screen: 'detail', focus: null };
    var scrPlayer = $('screen-player');
    if (scrPlayer) { scrPlayer.classList.remove('is-mini'); scrPlayer.classList.add('is-active'); }
    state.screen = 'player';
    radioOnScreen('player');   /* la pelicula o el canal tienen prioridad sobre la radio */
    playerStage.classList.add('is-vod');
    updatePlayer();
    setFocus(playerStage);
    showVodInfobar();
  }

  /* ---- Ventanita propia (Xuper Rust) ------------------------------------
     The native PiP window of WebView2 shows the page origin in its title bar
     and that cannot be changed. When the shell offers `miniMode`, the main
     window itself shrinks, stays on top and shows the video title; the same
     <video> keeps playing, so there is no reconnection. Controls are drawn
     outside the scaled 1920×1080 canvas, in real pixels, so they stay big. */
  var miniOn = false, miniBusy = false, miniUi = null, miniTimer = null, miniHideTimer = null, miniLastTitle = '';
  function miniSupported() {
    return !!(window.XUPER_DESKTOP && window.desktop && window.desktop.miniMode);
  }
  function miniTitleText() {
    var item = state.playerItem;
    if (state.playerMode !== 'vod') {
      var live = CHANNELS[state.channel] || null;
      return (live && (live.name || live.title)) ? String(live.name || live.title) : 'TV en vivo';
    }
    if (!item) { return 'Xuper'; }
    var t = String(item._seriesTitle || item.title || 'Xuper');
    var ep = state.playerEpisode;
    if (ep && isSeriesItem(item)) {
      var n = ep.number || ep.episode || '';
      if (n) { t += ' · Episodio ' + n; }
    }
    return t;
  }
  function miniIcon(name) { return PLAYER_ICONS[name] || ''; }
  function buildMiniUi() {
    if (miniUi) { return miniUi; }
    var root = el('div', 'mini-ui');
    root.innerHTML =
      '<div class="mini-top">' +
        '<div class="mini-title"></div>' +
        '<button type="button" class="mini-btn" data-act="restore" title="Volver a ventana completa (Esc)" aria-label="Volver a ventana completa">' + miniIcon('unfull') + '</button>' +
        '<button type="button" class="mini-btn mini-close" data-act="close" title="Cerrar el vídeo" aria-label="Cerrar el vídeo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' +
      '</div>' +
      '<div class="mini-center">' +
        '<button type="button" class="mini-btn mini-vod" data-act="back10" title="Retroceder 10 s (←)" aria-label="Retroceder 10 segundos">' + miniIcon('back10') + '</button>' +
        '<button type="button" class="mini-btn mini-ch" data-act="chprev" title="Canal anterior (←)" aria-label="Canal anterior">' + miniIcon('prev') + '</button>' +
        '<button type="button" class="mini-btn mini-play" data-act="play" aria-label="Reproducir o pausar"></button>' +
        '<button type="button" class="mini-btn mini-ch" data-act="chnext" title="Canal siguiente (→)" aria-label="Canal siguiente">' + miniIcon('next') + '</button>' +
        '<button type="button" class="mini-btn mini-vod" data-act="fwd10" title="Adelantar 10 s (→)" aria-label="Adelantar 10 segundos">' + miniIcon('fwd10') + '</button>' +
        '<button type="button" class="mini-btn mini-next" data-act="next" title="Siguiente episodio" aria-label="Siguiente episodio">' + miniIcon('next') + '</button>' +
      '</div>' +
      '<div class="mini-bottom">' +
        '<div class="mini-seek mini-vod"><div class="mini-seek-fill"></div><div class="mini-seek-knob"></div></div>' +
        '<div class="mini-row">' +
          '<div class="mini-time"></div>' +
          '<div class="mini-live">EN VIVO</div>' +
          '<div class="mini-vol-host"></div>' +
        '</div>' +
      '</div>';
    root.querySelector('.mini-vol-host').appendChild(buildVolumeControl('is-mini-vol'));
    /* Electron keeps the Windows title bar (it already shows the title). */
    if (window.desktop.miniNativeFrame) { root.classList.add('is-native-frame'); }
    document.body.appendChild(root);

    var clickTimer = null, down = null;
    root.addEventListener('click', function (event) {
      event.stopPropagation();
      miniWake();
      var btn = closest(event.target, '[data-act]');
      if (closest(event.target, '.vc-mute')) { togglePlayerMute(); return; }
      if (closest(event.target, '.vc-volume')) { return; }
      if (btn) { miniAction(btn.getAttribute('data-act')); return; }
      if (closest(event.target, '.mini-seek')) { return; }
      if (down && down.dragged) { return; }
      /* Empty area: one click pauses/plays, double click = full window. */
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; miniAction('restore'); return; }
      clickTimer = setTimeout(function () { clickTimer = null; miniAction('play'); }, 260);
    });
    root.addEventListener('dblclick', function (event) { event.stopPropagation(); event.preventDefault(); });
    /* Drag the window from anywhere that is not a control. */
    root.addEventListener('pointerdown', function (event) {
      miniWake();
      if (event.button !== 0 || closest(event.target, 'button, .mini-seek, .vc-volume')) { down = null; return; }
      down = { x: event.screenX, y: event.screenY, dragged: false };
    });
    root.addEventListener('pointermove', function (event) {
      miniWake();
      if (!down || down.dragged || !(event.buttons & 1)) { return; }
      if (Math.abs(event.screenX - down.x) + Math.abs(event.screenY - down.y) > 5) {
        down.dragged = true;
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        try { window.desktop.miniDrag(); } catch (eDrag) { /* older shell */ }
      }
    });
    root.addEventListener('pointerup', function () { setTimeout(function () { down = null; }, 0); });
    root.addEventListener('wheel', function (event) {
      event.preventDefault(); event.stopPropagation();
      miniWake();
      setPlayerVolume((liveAudio.muted ? 0 : liveAudio.volume) + (event.deltaY < 0 ? 0.05 : -0.05), false);
    }, { passive: false });
    var seek = root.querySelector('.mini-seek');
    seek.addEventListener('click', function (event) {
      event.stopPropagation();
      var duration = vodPlaybackDuration();
      if (!duration) { return; }
      var r = seek.getBoundingClientRect();
      var pct = Math.max(0, Math.min(1, (event.clientX - r.left) / r.width));
      playerSeek(pct * duration - vodPlaybackPosition());
      miniWake();
    });
    miniUi = root;
    return root;
  }
  function miniAction(act) {
    if (act === 'play') { togglePlayerPlayPause(); }
    else if (act === 'back10') { playerSeek(-10); }
    else if (act === 'fwd10') { playerSeek(10); }
    else if (act === 'next') { if (nextEpisodeTarget()) { advanceToNextEpisode(); } }
    else if (act === 'chprev' && state.playerMode === 'live') { setChannel(state.channel - 1); }
    else if (act === 'chnext' && state.playerMode === 'live') { setChannel(state.channel + 1); }
    else if (act === 'restore') { setMiniWindow(false); }
    /* Close the player itself (back() would first just hide the bar). */
    else if (act === 'close') { setMiniWindow(false, function () { if (state.screen === 'player') { restorePlayerReturn(); } }); }
    miniRefresh();
  }
  /* Controls show on any movement and hide after 3 s of calm (not paused). */
  function miniWake() {
    if (!miniUi) { return; }
    miniUi.classList.add('is-awake');
    if (miniHideTimer) { clearTimeout(miniHideTimer); }
    miniHideTimer = setTimeout(function () {
      miniHideTimer = null;
      var v = shownPlayerVideo();
      if (miniUi && v && !v.paused) { miniUi.classList.remove('is-awake'); }
    }, 3000);
  }
  function miniRefresh() {
    if (!miniOn || !miniUi) { return; }
    /* The player was closed some other way: leave the small window too. */
    if (state.screen !== 'player' || !playerVideo) { setMiniWindow(false); return; }
    var vod = state.playerMode === 'vod';
    miniUi.classList.toggle('is-live', !vod);
    var paused = shownPlayerVideo().paused;
    var play = miniUi.querySelector('.mini-play');
    var icon = paused ? 'play' : 'pause';
    if (play._icon !== icon) { play._icon = icon; play.innerHTML = miniIcon(icon); play.title = paused ? 'Reproducir (Espacio)' : 'Pausa (Espacio)'; }
    if (paused) { miniUi.classList.add('is-awake'); }
    var title = miniTitleText();
    if (title !== miniLastTitle) {
      miniLastTitle = title;
      miniUi.querySelector('.mini-title').textContent = title;
      try { window.desktop.miniTitle(title); } catch (eTitle) { /* ignore */ }
    }
    miniUi.querySelector('.mini-next').hidden = !(vod && nextEpisodeTarget());
    if (vod) {
      var pos = vodPlaybackPosition(), dur = vodPlaybackDuration();
      var pct = dur ? Math.max(0, Math.min(100, pos / dur * 100)) : 0;
      miniUi.querySelector('.mini-seek-fill').style.width = pct + '%';
      miniUi.querySelector('.mini-seek-knob').style.left = pct + '%';
      miniUi.querySelector('.mini-time').textContent = formatTime(pos) + (dur ? ' / ' + formatTime(dur) : '');
    }
  }
  function miniKeys(event) {
    if (!miniOn) { return; }
    var k = event.key;
    var handled = true;
    if (k === 'Escape' || (k === 'p' && event.ctrlKey)) { setMiniWindow(false); }
    else if (k === ' ' || k === 'k' || k === 'K') { miniAction('play'); }
    else if (k === 'ArrowLeft' && state.playerMode === 'vod') { miniAction('back10'); }
    else if (k === 'ArrowRight' && state.playerMode === 'vod') { miniAction('fwd10'); }
    else if (k === 'ArrowLeft' && state.playerMode === 'live') { miniAction('chprev'); }
    else if (k === 'ArrowRight' && state.playerMode === 'live') { miniAction('chnext'); }
    else if (k === 'ArrowUp') { setPlayerVolume((liveAudio.muted ? 0 : liveAudio.volume) + 0.05, false); }
    else if (k === 'ArrowDown') { setPlayerVolume((liveAudio.muted ? 0 : liveAudio.volume) - 0.05, false); }
    else if (k === 'm' || k === 'M') { togglePlayerMute(); }
    else if (k === 'n' || k === 'N') { miniAction('next'); }
    /* Everything else is swallowed: the full interface is hidden. */
    event.preventDefault();
    event.stopPropagation();
    if (handled) { miniWake(); }
  }
  function setMiniWindow(on, done) {
    if (!miniSupported() || miniBusy || on === miniOn) { if (done) { done(); } return; }
    miniBusy = true;
    if (on) {
      if (playSettingViewOpen) { closePlaySettingView(); }
      buildMiniUi();
      miniLastTitle = '';
      document.documentElement.classList.add('is-mini-window');
      miniOn = true;
      window.addEventListener('keydown', miniKeys, true);
      miniRefresh();
      miniWake();
      miniTimer = setInterval(miniRefresh, 500);
    } else {
      miniOn = false;
      if (miniTimer) { clearInterval(miniTimer); miniTimer = null; }
      window.removeEventListener('keydown', miniKeys, true);
      document.documentElement.classList.remove('is-mini-window');
    }
    Promise.resolve(window.desktop.miniMode(on, on ? miniTitleText() : null)).catch(function () {}).then(function () {
      miniBusy = false;
      setTimeout(function () {
        fitDesignViewport();
        if (!on && state.screen === 'player') { setFocus(playerStage); showInfobar(); }
        if (done) { done(); }
      }, 120);
    });
  }
  function toggleMiniWindow() {
    if (miniOn) { setMiniWindow(false); return; }
    var shown = shownPlayerVideo();
    if (!shown || !(shown.currentSrc || shown.getAttribute('src'))) {
      setPlayerStatus('Reproduce un vídeo para abrir la ventana flotante');
      return;
    }
    /* Started from the detail preview: show that video as the player first. */
    if (state.screen !== 'player') {
      if (!state.playerItem) { return; }
      showFloatingVideoFullSize();
    }
    setMiniWindow(true);
  }

  function togglePictureInPicture() {
    /* En YouMusic (o ya en su ventanita): ventanita de YouMusic. */
    if (musicMiniOn || (musicMiniSupported() && music.open && state.screen === 'home' && !miniOn && !radioMiniOn)) { setMusicMini(!musicMiniOn); return; }
    /* Sin vídeo en pantalla y con la radio puesta: mini radio. */
    /* En la pestaña TV: ventanita del canal que se está viendo. */
    if (miniSupported() && !miniOn && !radioMiniOn && state.screen === 'home' && onTvTab() && CHANNELS.length) { openLiveMini(); return; }
    if (miniSupported() && (radioMiniOn || (state.screen !== 'player' && radio.current && !miniOn))) { setRadioMini(!radioMiniOn); return; }
    if (miniSupported()) { toggleMiniWindow(); return; }
    if (!playerVideo || !document.pictureInPictureEnabled) { return; }
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(function () {});
      return;
    }
    if (!(playerVideo.currentSrc || playerVideo.getAttribute('src'))) {
      setPlayerStatus('Reproduce un vídeo para abrir la ventana flotante');
      return;
    }
    setupPipMediaSession();
    bindPipLeave();
    if (navigator.mediaSession && window.MediaMetadata && state.playerItem) {
      try {
        var ep = state.playerEpisode;
        navigator.mediaSession.metadata = new MediaMetadata({
          title: state.playerItem.title || 'Xuper',
          artist: ep && ep.number ? ('Episodio ' + ep.number) : ''
        });
      } catch (eMeta) { /* optional */ }
    }
    playerVideo.requestPictureInPicture().catch(function (err) {
      setPlayerStatus('No se pudo abrir la ventana flotante' + (err && err.message ? ': ' + err.message : ''));
    });
  }

  function installDesktopNavigation() {
    /* Detail preview: hide the title artwork while video frames are shown. */
    var markPreview = function (on) {
      var box = $('detail-player');
      if (box) { box.classList.toggle('is-playing', on); }
    };
    document.addEventListener('playing', function (e) {
      if (e.target && e.target.id === 'player-video') { markPreview(true); }
    }, true);
    ['emptied', 'error', 'ended'].forEach(function (name) {
      document.addEventListener(name, function (e) {
        if (e.target && e.target.id === 'player-video') { markPreview(false); }
      }, true);
    });
    var button = el('button', 'desktop-native-control', '← Volver');
    button.id = 'desktop-back';
    button.type = 'button';
    button.setAttribute('aria-label', 'Volver a la pantalla anterior');
    button.addEventListener('click', desktopBack);
    /* Inside the scaled canvas: same size as the rest of the UI and a fixed,
       reserved place in each screen's header instead of floating over it. */
    var navHost = $('app') || document.body;
    navHost.appendChild(button);

    var historyBtn = el('button', 'desktop-native-control');
    historyBtn.id = 'desktop-history';
    historyBtn.type = 'button';
    historyBtn.title = 'Historial (Ctrl+J)';
    historyBtn.setAttribute('aria-label', 'Historial de lo que has visto');
    historyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg><span>Historial</span>';
    historyBtn.addEventListener('click', openHistoryView);
    navHost.appendChild(historyBtn);

    setInterval(function () {
      button.hidden = state.screen === 'welcome';
      syncBackAutohide();
      button.disabled = state.screen === 'home' && state.tab === TAB_HOME && !dialogAddonsOpen;
      historyBtn.hidden = state.screen === 'welcome' || state.screen === 'player';
      var onHistory = historyDrawerOpen;
      historyBtn.classList.toggle('is-active', onHistory);
    }, 150);
  }

  /* ------------------------------------------------------------------
     Mouse gestures on the video (desktop):
       - one click: the usual action (pause/play), after a short wait so a
         double click does not pause and resume the video;
       - double click anywhere: Windows full screen on/off;
       - press and hold on the left/right third (VOD only): fast rewind /
         forward. A counter grows while held and ONE seek is made on release
         (each seek restarts the stream in Modo fluido).
     ------------------------------------------------------------------ */
  var DOUBLE_CLICK_MS = 260;
  var HOLD_START_MS = 400;

  function isRelayUrl(url) {
    return url.indexOf(location.origin + '/reproducir/relay/s/') === 0 || /^http:\/\/127\.0\.0\.1:\d+\/s\//.test(url);
  }
  function isWindowFullscreen() {
    return Math.abs(window.outerWidth - screen.width) < 3 && Math.abs(window.outerHeight - screen.height) < 3;
  }
  function setWindowFullscreen(on) {
    if (!window.desktop || !window.desktop.fullscreen) { return; }
    if (isWindowFullscreen() !== on) { window.desktop.fullscreen(); }
  }

  function formatSeekAmount(sec) {
    sec = Math.round(Math.abs(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m ? (m + ':' + (s < 10 ? '0' : '') + s) : (s + ' s');
  }

  /* Click / double click on an element, with the single action delayed. */
  function bindClickGestures(node, single, double) {
    var timer = null;
    node.addEventListener('click', function (event) {
      if (node._suppressClick) { node._suppressClick = false; event.stopPropagation(); return; }
      event.stopPropagation();
      if (closePlayerPanels()) { return; }
      if (state.focus !== node && isVisible(node)) { setFocus(node, true); }
      if (timer) {
        clearTimeout(timer);
        timer = null;
        double(event);
        return;
      }
      timer = setTimeout(function () { timer = null; single(event); }, DOUBLE_CLICK_MS);
    }, true);
  }

  /* Closes the episodes or settings panel if one is open. A click outside
     a panel only closes it: it never pauses or opens anything else. */
  function closePlayerPanels() {
    if (state.episodeBrowserOpen) { closeEpisodeBrowser(); return true; }
    if (playSettingViewOpen) { closePlaySettingView(); return true; }
    return false;
  }

  function panelCloseButton(title) {
    var b = el('div', 'panel-close focusable');
    b.title = title;
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    b._activate = closePlayerPanels;
    return b;
  }

  function installPanelDismiss() {
    var view = $('player-playsetting-view');
    var scroll = $('psv-scroll');
    if (view && !view._dismiss) {
      view._dismiss = true;
      /* The settings layer covers the whole video; only its lower sheet is
         content. A click on the rest closes it. */
      view.addEventListener('click', function (event) {
        if (scroll && scroll.contains(event.target)) { return; }
        event.stopPropagation();
        closePlaySettingView();
      });
      if (scroll) { scroll.appendChild(panelCloseButton('Cerrar ajustes (Esc)')); }
    }
    var eps = $('player-episodes');
    if (eps && !eps._dismiss) {
      eps._dismiss = true;
      eps.appendChild(panelCloseButton('Cerrar episodios (Esc)'));
    }
  }

  function installVideoGestures() {
    installPanelDismiss();
    if (!playerStage || playerStage._gestures) { return; }
    playerStage._gestures = true;

    var indicator = el('div', 'hold-seek');
    indicator.hidden = true;
    playerStage.appendChild(indicator);

    function onVideoArea(target) {
      return target === playerStage || target === playerVideo ||
        (target && target.classList && (target.classList.contains('player-frame') ||
          target.classList.contains('player-status') || target.classList.contains('player-osd-icon')));
    }

    bindClickGestures(playerStage, function () {
      if (playerStage._activate) { playerStage._activate(); }
    }, function () {
      if (state.screen === 'detail') {
        /* From the detail preview: open the player straight in full screen. */
        if (playerStage._activate) { playerStage._activate(); }
        setWindowFullscreen(true);
        return;
      }
      setWindowFullscreen(!isWindowFullscreen());
    });

    var hold = null;
    function canHoldSeek() {
      return state.screen === 'player' && state.playerMode === 'vod' && playerVideo &&
        !state.episodeBrowserOpen && !playSettingViewOpen &&
        !!(playerVideo.currentSrc || playerVideo.getAttribute('src'));
    }
    /* +10 s per tick for the first 3 s, then faster: about 1:40 after 3 s,
       5 min after 6 s, then +1 min per tick. */
    function holdStep(elapsed) {
      if (elapsed < 3000) { return 10; }
      if (elapsed < 6000) { return 20; }
      return 60;
    }
    function renderHold() {
      var duration = vodPlaybackDuration();
      var arrow = hold.dir > 0 ? '»' : '«';
      var text = arrow + ' ' + (hold.dir > 0 ? '+' : '−') + formatSeekAmount(hold.total);
      if (duration) {
        var target = Math.max(0, Math.min(duration - 1, hold.base + hold.dir * hold.total));
        text += '\n' + formatTime(target) + ' / ' + formatTime(duration);
        if (vodScrubbing) { vodScrubTime = target; updateVodProgress(target, duration); }
      }
      indicator.textContent = text;
      indicator.className = 'hold-seek ' + (hold.dir > 0 ? 'is-right' : 'is-left');
      indicator.hidden = false;
    }
    function startHold() {
      hold.active = true;
      hold.base = vodPlaybackPosition();
      hold.total = 10;
      hold.startedAt = Date.now();
      if (vodPlaybackDuration()) { enterVodScrub(); }
      renderHold();
      hold.ticker = setInterval(function () {
        hold.total += holdStep(Date.now() - hold.startedAt);
        var duration = vodPlaybackDuration();
        if (duration) {
          var room = hold.dir > 0 ? (duration - 1 - hold.base) : hold.base;
          hold.total = Math.max(0, Math.min(hold.total, room));
        }
        renderHold();
      }, 300);
    }
    function endHold(apply) {
      if (!hold) { return; }
      var h = hold;
      hold = null;
      clearTimeout(h.timer);
      if (!h.active) { return; }
      clearInterval(h.ticker);
      /* The click that follows this release must not pause the video. It is
         cleared by the click handler, or after a moment if no click comes. */
      playerStage._suppressClick = true;
      setTimeout(function () { playerStage._suppressClick = false; }, 500);
      setTimeout(function () { indicator.hidden = true; }, 500);
      if (vodScrubbing) {
        /* vodScrubTime already holds the target shown by the counter. */
        leaveVodScrub(apply);
      } else if (apply && h.total) {
        playerSeek(h.dir * h.total);
      }
    }

    playerStage.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || !onVideoArea(event.target) || !canHoldSeek()) { return; }
      var rect = playerStage.getBoundingClientRect();
      var x = (event.clientX - rect.left) / rect.width;
      if (x > 1 / 3 && x < 2 / 3) { return; }
      endHold(false);
      hold = { dir: x <= 1 / 3 ? -1 : 1, active: false };
      hold.timer = setTimeout(startHold, HOLD_START_MS);
    });
    playerStage.addEventListener('pointerup', function () { endHold(true); });
    playerStage.addEventListener('pointerleave', function () { endHold(true); });
    playerStage.addEventListener('pointercancel', function () { endHold(false); });
    window.addEventListener('blur', function () { endHold(true); });
  }

  /* Home TV preview: click opens the TV player, double click opens it in
     Windows full screen. */
  function installLivePreviewGestures(node) {
    if (!node || node._gestures) { return; }
    node._gestures = true;
    bindClickGestures(node, function () { openPlayer('live'); }, function () {
      openPlayer('live');
      setWindowFullscreen(true);
    });
  }

  /* ---- Desktop control bar (replaces the row of text buttons). ----
       ⏪ ⏯ ⏩  🔊━━━  00:52 / 1:28:59 · termina 19:42        CC ⚙ ☰ ⏭ ⧉ ⛶   */
  function buildDesktopControlBar() {
    var content = document.querySelector('.vod-infobar-content');
    var tips = document.querySelector('.vod-infobar-tips');
    if (!content || !tips || content._modern) { return; }
    content._modern = true;
    content.classList.add('is-modern');
    var title = $('vod-infobar-title');
    var seekRow = content.querySelector('.vod-seekbar-row');
    if (title && seekRow) { content.insertBefore(title, seekRow); }
    clear(tips);
    var left = el('div', 'vc-group vc-left');
    var right = el('div', 'vc-group vc-right');
    tips.appendChild(left);
    tips.appendChild(right);
    function btn(host, id, icon, label, run, extra) {
      var b = el('button', 'vod-tip vc-btn focusable' + (extra ? ' ' + extra : ''));
      b.type = 'button'; b.id = id;
      b.innerHTML = PLAYER_ICONS[icon];
      b.title = label;
      b.setAttribute('aria-label', label);
      b._activate = run;
      host.appendChild(b);
      return b;
    }
    btn(left, 'vod-rewind', 'back10', 'Retroceder 10 s (←)', function () { playerSeek(-10); });
    btn(left, 'vod-toggle', 'pause', 'Pausa (Espacio)', togglePlayerPlayPause, 'vc-play');
    btn(left, 'vod-forward', 'fwd10', 'Adelantar 10 s (→)', function () { playerSeek(10); });
    left.appendChild(buildVolumeControl());
    var time = el('div', 'vc-time');
    var cur = $('vod-time-current'), tot = $('vod-time-total');
    if (cur) { time.appendChild(cur); }
    time.appendChild(el('span', 'vc-sep', '/'));
    if (tot) { time.appendChild(tot); }
    var end = el('span', 'vc-end'); end.id = 'vc-end';
    time.appendChild(end);
    var speed = el('span', 'vc-speed'); speed.id = 'vc-speed'; speed.hidden = true;
    time.appendChild(speed);
    left.appendChild(time);
    btn(right, 'vod-cc', 'cc', 'Idioma y subtítulos (C)', function () { openPlaySettingsDialog(); });
    btn(right, 'vod-settings', 'gear', 'Ajustes (S)', openPlaySettingView);
    btn(right, 'vod-episodes', 'list', 'Episodios', openEpisodeBrowser);
    btn(right, 'vod-next', 'next', 'Siguiente episodio (N)', function () { hideNextEpCard(); advanceToNextEpisode(); });
    if (document.pictureInPictureEnabled) {
      btn(right, 'vod-pip', 'pip', 'Ventana flotante (Ctrl+P)', togglePictureInPicture);
    }
    btn(right, 'vod-fullscreen', 'full', 'Pantalla completa (F)', function () { setWindowFullscreen(!isWindowFullscreen()); });
    installSeekHover();
    buildNextEpCard();
  }

  /* Time under the pointer above the seek bar. */
  function installSeekHover() {
    if (!vodSeekbar || vodSeekbar._hover) { return; }
    vodSeekbar._hover = true;
    var tip = el('div', 'vod-seek-hover');
    tip.hidden = true;
    vodSeekbar.appendChild(tip);
    vodSeekbar.addEventListener('pointermove', function (event) {
      var duration = vodPlaybackDuration();
      if (!duration) { tip.hidden = true; return; }
      var r = vodSeekbar.getBoundingClientRect();
      var f = Math.max(0, Math.min(1, (event.clientX - r.left) / r.width));
      tip.textContent = formatTime(f * duration);
      tip.style.left = (f * 100).toFixed(2) + '%';
      tip.hidden = false;
    });
    vodSeekbar.addEventListener('pointerleave', function () { if (!vodScrubbing) { tip.hidden = true; } });
  }

  /* "· termina 19:42" next to the total time. */
  function updateVodEndTime(current, duration) {
    var end = $('vc-end');
    if (!end) { return; }
    if (!duration || !playerVideo) { end.textContent = ''; return; }
    var rate = playerVideo.playbackRate || 1;
    var at = new Date(Date.now() + Math.max(0, duration - current) / rate * 1000);
    var label;
    try { label = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch (eTime) { label = pad2(at.getHours()) + ':' + pad2(at.getMinutes()); }
    end.textContent = '· termina ' + label;
  }

  /* ---- Next episode card: shown in the last 20 s of a series episode. ---- */
  var nextEpCard = null, nextEpCancelled = null;
  var NEXT_EP_LEAD_S = 20;
  function nextEpisodeTarget() {
    var item = state.playerItem;
    if (!item || !isSeriesItem(item)) { return null; }
    var episodes = episodeListForCurrentSeason(item);
    var current = state.playerEpisode;
    for (var i = 0; i < episodes.length; i++) {
      if (current && (episodes[i].id === current.id || episodes[i].number === current.number)) {
        if (i + 1 < episodes.length) { return { ep: episodes[i + 1] }; }
        var seasons = seriesSeasons(item);
        return seasons[(state.playerSeasonIndex || 0) + 1] ? { season: seasons[(state.playerSeasonIndex || 0) + 1] } : null;
      }
    }
    return null;
  }
  function nextEpisodeLabel(target) {
    if (!target) { return ''; }
    if (target.season) { return (target.season.name || 'Temporada siguiente') + ' · Episodio 1'; }
    var ep = target.ep;
    var n = ep.number || ep.episode || '';
    var name = String(ep.title || ep.name || '');
    /* The portal often names episodes "Serie T10_2": that adds nothing. */
    var series = String((state.playerItem && (state.playerItem._seriesTitle || state.playerItem.title)) || '');
    if (/_\d+$/.test(name) || (series && name.indexOf(series) === 0) || name === String(n)) { name = ''; }
    return (n ? 'Episodio ' + n : 'Episodio') + (name ? ' · ' + name : '');
  }
  function buildNextEpCard() {
    var scr = $('screen-player');
    if (!scr || nextEpCard) { return; }
    nextEpCard = el('div', 'next-ep-card');
    nextEpCard.hidden = true;
    nextEpCard.appendChild(el('div', 'ne-kicker', 'Siguiente episodio'));
    nextEpCard.appendChild(el('div', 'ne-name'));
    nextEpCard.appendChild(el('div', 'ne-count'));
    var row = el('div', 'ne-actions');
    var now = el('button', 'ne-btn is-primary focusable');
    now.type = 'button';
    now.innerHTML = PLAYER_ICONS.play + '<span>Ver ahora</span>';
    now._activate = function () { hideNextEpCard(); advanceToNextEpisode(); };
    var cancel = el('button', 'ne-btn focusable', 'Cancelar');
    cancel.type = 'button';
    cancel._activate = function () {
      nextEpCancelled = state.playerEpisode;
      hideNextEpCard();
      setFocus(playerStage, true);
    };
    row.appendChild(now);
    row.appendChild(cancel);
    nextEpCard.appendChild(row);
    scr.appendChild(nextEpCard);
  }
  function hideNextEpCard() { if (nextEpCard) { nextEpCard.hidden = true; } }
  function updateNextEpCard() {
    if (!nextEpCard) { return; }
    var duration = vodPlaybackDuration();
    var remaining = duration ? duration - vodPlaybackPosition() : 0;
    var show = state.screen === 'player' && state.playerMode === 'vod' && duration > 60 &&
      remaining > 0 && remaining <= NEXT_EP_LEAD_S && nextEpCancelled !== state.playerEpisode &&
      !$('screen-player').classList.contains('is-mini');
    var target = show ? nextEpisodeTarget() : null;
    if (!target) { hideNextEpCard(); return; }
    nextEpCard.querySelector('.ne-name').textContent = nextEpisodeLabel(target);
    nextEpCard.querySelector('.ne-count').textContent = 'Empieza en ' + Math.ceil(remaining) + ' s';
    nextEpCard.hidden = false;
  }

  /* ---- Playback speed (Ajustes → Velocidad). ---- */
  var playbackSpeed = 1;
  function applyPlaybackSpeed() {
    if (!playerVideo) { return; }
    var rate = state.playerMode === 'vod' ? playbackSpeed : 1;
    playerVideo.defaultPlaybackRate = rate;
    if (playerVideo.playbackRate !== rate) { playerVideo.playbackRate = rate; }
    var chip = $('vc-speed');
    if (chip) { chip.hidden = rate === 1; chip.textContent = String(rate).replace('.', ',') + '×'; }
  }
  function installSpeedSetting() {
    var row = $('psv-speed-row');
    var sec = $('psv-sec-speed');
    if (!row || !sec || row._bound) { return; }
    row._bound = true;
    sec.classList.remove('is-hidden');
    var btns = row.querySelectorAll('.psv-btn');
    function mark() {
      for (var i = 0; i < btns.length; i++) {
        var on = Number(btns[i].getAttribute('data-speed')) === playbackSpeed;
        btns[i].classList.toggle('is-selected', on);
        var chk = btns[i].querySelector('.psv-check');
        if (chk) { chk.style.display = on ? 'block' : 'none'; }
      }
    }
    for (var i = 0; i < btns.length; i++) {
      btns[i]._activate = function () {
        playbackSpeed = Number(this.getAttribute('data-speed')) || 1;
        applyPlaybackSpeed();
        mark();
        if (state.playerMode === 'vod') { updateVodEndTime(vodPlaybackPosition(), vodPlaybackDuration()); }
      };
    }
    mark();
  }

  function bindDesktopPlayback() {
    installVideoGestures();
    if (!vodSeekbar || vodSeekbar._desktopBound) return;
    vodSeekbar._desktopBound = true;
    vodSeekbar.setAttribute('role', 'slider');
    vodSeekbar.setAttribute('aria-label', 'Posición de reproducción');
    vodSeekbar.setAttribute('aria-valuemin', '0');
    vodSeekbar.setAttribute('tabindex', '0');
    var durationNote = el('div', 'vod-duration-note');
    durationNote.id = 'vod-duration-note'; durationNote.hidden = true;
    document.querySelector('.vod-infobar-content').appendChild(durationNote);
    var pointer = null;
    function preview(event) {
      var rect = vodSeekbar.getBoundingClientRect();
      var duration = vodPlaybackDuration();
      var fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      vodScrubTime = Math.max(0, Math.min(duration - 1, fraction * duration));
      updateVodProgress(vodScrubTime, duration);
    }
    vodSeekbar.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || state.screen !== 'player' || state.playerMode !== 'vod' || !isVisible(vodSeekbar)) return;
      event.preventDefault(); event.stopPropagation();
      if (!vodPlaybackDuration()) {
        updateVodProgress(vodPlaybackPosition(), 0);
        return;
      }
      pointer = event.pointerId;
      enterVodScrub();
      vodSeekbar.setPointerCapture(pointer);
      preview(event);
    });
    vodSeekbar.addEventListener('pointermove', function (event) {
      if (event.pointerId === pointer) { event.preventDefault(); preview(event); }
    });
    vodSeekbar.addEventListener('pointerup', function (event) {
      if (event.pointerId !== pointer) return;
      event.preventDefault(); event.stopPropagation();
      preview(event);
      var id = pointer; pointer = null;
      if (vodSeekbar.hasPointerCapture(id)) vodSeekbar.releasePointerCapture(id);
      leaveVodScrub(true);
    });
    function cancel() { if (pointer !== null) { pointer = null; leaveVodScrub(false); } }
    vodSeekbar._cancelDesktopScrub = cancel;
    vodSeekbar.addEventListener('pointercancel', cancel);
    vodSeekbar.addEventListener('lostpointercapture', cancel);
    vodSeekbar.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); });
    vodSeekbar.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); event.stopPropagation();
        if (!vodScrubbing) enterVodScrub();
        vodScrubTime = Math.max(0, Math.min(vodPlaybackDuration() - 1, vodScrubTime + (event.key === 'ArrowRight' ? 10 : -10)));
        updateVodProgress(vodScrubTime, vodPlaybackDuration());
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); event.stopPropagation();
        if (!vodScrubbing) enterVodScrub();
        vodScrubTime = event.key === 'Home' ? 0 : Math.max(0, vodPlaybackDuration() - 2);
        updateVodProgress(vodScrubTime, vodPlaybackDuration());
      }
    });
    buildDesktopControlBar();
    function updateButtons() {
      var paused = playerVideo.paused;
      var toggle = $('vod-toggle');
      toggle.innerHTML = paused ? PLAYER_ICONS.play : PLAYER_ICONS.pause;
      toggle.title = (paused ? 'Reproducir' : 'Pausa') + ' (Espacio)';
      toggle.setAttribute('aria-label', toggle.title);
      var series = isSeriesItem(state.playerItem);
      $('vod-episodes').hidden = !series;
      $('vod-next').hidden = !series || !nextEpisodeTarget();
      var canSkip = state.playerMode === 'vod' && !!(playerVideo.currentSrc || playerVideo.getAttribute('src'));
      $('vod-forward').disabled = !canSkip;
      $('vod-rewind').disabled = !canSkip;
      var full = isWindowFullscreen();
      var fs = $('vod-fullscreen');
      fs.innerHTML = full ? PLAYER_ICONS.unfull : PLAYER_ICONS.full;
      fs.title = (full ? 'Salir de pantalla completa' : 'Pantalla completa') + ' (F)';
      fs.setAttribute('aria-label', fs.title);
      if ($('vod-pip')) {
        var inPip = document.pictureInPictureElement === playerVideo;
        $('vod-pip').title = (inPip ? 'Cerrar ventana flotante' : 'Ventana flotante') + ' (Ctrl+P)';
        $('vod-pip').classList.toggle('is-on', inPip);
        $('vod-pip').disabled = !canSkip && !inPip;
      }
      syncVolumeUis();
    }
    window.addEventListener('resize', updateButtons);
    playerVideo.addEventListener('volumechange', syncVolumeUis);
    /* The player follows the saved volume/mute when a video starts. */
    playerVideo.addEventListener('play', function () { if (state.screen === 'player') { syncPlayerAudio(); } });
    playerVideo.addEventListener('loadedmetadata', function () { applyPlaybackSpeed(); });
    playerVideo.addEventListener('play', applyPlaybackSpeed);
    playerVideo.addEventListener('timeupdate', updateNextEpCard);
    installVolumeWheel();
    installSpeedSetting();
    playerVideo.addEventListener('enterpictureinpicture', updateButtons);
    playerVideo.addEventListener('leavepictureinpicture', updateButtons);
    playerVideo.addEventListener('play', updateButtons);
    playerVideo.addEventListener('pause', updateButtons);
    playerVideo.addEventListener('loadedmetadata', updateButtons);
    playerVideo.addEventListener('durationchange', updateButtons);
    document.addEventListener('xuper:duration', updateButtons);
    document.addEventListener('xuper:timeline', function () {
      updateButtons();
      if (state.playerMode === 'vod') updateVodProgress(vodPlaybackPosition(), vodPlaybackDuration());
    });
    var screen = $('screen-player');
    screen.addEventListener('pointermove', function () {
      if (state.screen === 'player' && !playSettingViewOpen && !dialogPlaySettingsOpen &&
          !state.episodeBrowserOpen && !state.categoryPickerOpen && !state.channelsOpen && !vodScrubbing) showInfobar();
    });
  }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    fitDesignViewport();
    window.addEventListener('resize', fitDesignViewport, false);
    window.addEventListener('orientationchange', fitDesignViewport, false);
    document.addEventListener('visibilitychange', fitDesignViewport, false);
    /* Some webOS builds only report the final window size after the splash
       animation, and 720p / 2K sets take longer than 1080p ones. */
    setTimeout(fitDesignViewport, 250);
    setTimeout(fitDesignViewport, 1200);
    setTimeout(fitDesignViewport, 3000);
    document.addEventListener('keydown', handleKey, false);
    document.addEventListener('keyup', function (e) {
      var code = e.keyCode || e.which;
      if (code === 461 || e.key === 'Back' || e.key === 'GoBack') {
        handleKey(e);
      }
    }, false);
    window.addEventListener('popstate', function () {
      back();
    }, false);
    document.addEventListener('click', function (e) {
      var f = closest(e.target, '.focusable');
      if (!f) { return; }
      if (!isVisible(f)) { return; }
      setFocus(f, true);
      if (f._activate) { f._activate(); }
    });
    if (window.XUPER_DESKTOP) document.addEventListener('focusin', function (e) {
      var f = closest(e.target, '.focusable');
      if (f && isVisible(f)) setFocus(f, true);
    });
    buildSearch();
    startServiceKeepAlive();
    portalServiceCall('prewarm', {}, function () {});
    startWelcome();
    loadVodCatalog();
    loadLiveChannels();

    window.__xuper = {
      version: '4.34.4',
      state: state,
      vod: VOD,
      channels: CHANNELS,
      api: vodApiState,
      portal: portalState,
      service: portalServiceCall,
      refreshPortal: refreshPortalCatalog,
      reloadVod: loadVodCatalog,
      skipWelcome: finishWelcome,
      show: function (name) {
        if (name === 'home') { finishWelcome(); }
        else if (name === 'detail') { openDetail(VOD[0]); }
        else if (name === 'search') { openSearch(); }
        else if (name === 'settings') { openSettings(); }
        else if (name === 'history') { openHistoryView(); }
        else if (name === 'pip') { togglePictureInPicture(); }
        /* Electron: the window X / maximize buttons of the small window. */
        else if (name === 'mini-close') { if (miniOn) { miniAction('close'); } else if (radioMiniOn) { setRadioMini(false); } else if (musicMiniOn) { setMusicMini(false); } }
        else if (name === 'mini-restore') { if (miniOn) { setMiniWindow(false); } else if (radioMiniOn) { setRadioMini(false); } else if (musicMiniOn) { setMusicMini(false); } }
        else if (name === 'player') { openPlayer('live'); }
        else { showScreen(name); }
      },
      selectTab: function (i) { finishWelcome(); selectTab(i, true); },
      openDetail: function (i) { openDetail(VOD[i] || VOD[0]); },
      catalogTools: {
        normalize: normalizeVod, text: norm, isSeries: isSeriesItem, open: openDetail,
        topMovies: topMovieItems, topSeries: topSeriesItems, newest: newestItems,
        section: function (label) {
          if (label === 'Películas') return rootVodItems('movies','pelicula');
          if (label === 'Series') return rootVodItems('series','serie');
          if (label === 'Anime') return allVodFor('anime');
          if (label === 'Infantil') return rootVodItems('kids','infantil');
          return VOD;
        },
        tune: function (channel) {
          var index = CHANNELS.indexOf(channel);
          if (index >= 0) { setChannel(index, false); openPlayer('live'); }
        }
      },
      openSearch: openSearch,
      openSettings: openSettings,
      openPlayer: function (mode, i) { openPlayer(mode || 'live', VOD[i] || null); },
      focus: function (sel) {
        var n = typeof sel === 'string' ? document.querySelector(sel) : sel;
        if (n) { setFocus(n); }
      },
      key: function (code) { handleKey({ keyCode: code, preventDefault: function () {} }); },
      search: function (q) { openSearch(); setSearchQuery(q); },
      settingsPanel: function (i) { openSettings(); showSettingsPanel(i, true); }
    };

    if (window.XUPER_DESKTOP) installDesktopNavigation();

    applyQuery();
  }

  /* Deep-link support for the visual comparison harness, e.g.
     index.html?screen=home&tab=2   index.html?screen=detail&vod=3
     index.html?screen=search&q=demo index.html?screen=settings&panel=1
     index.html?screen=player&ch=2&channels=1                            */
  function applyQuery() {
    var raw = String(location.search || '').replace(/^\?/, '');
    if (!raw) { return; }
    var map = {};
    var parts = raw.split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) { continue; }
      var kv = parts[i].split('=');
      map[decodeURIComponent(kv[0])] = decodeURIComponent(kv.slice(1).join('=') || '');
    }
    if (map.ch !== undefined) {
      var ch = parseInt(map.ch, 10) || 0;
      state.channel = Math.max(0, Math.min(CHANNELS.length - 1, ch));
    }
    var screen = map.screen || 'home';
    if (screen === 'welcome') { return; }

    finishWelcome();
    if (map.tab !== undefined) {
      selectTab(parseInt(map.tab, 10) || 0, true);
    } else {
      selectTab(TAB_HOME, false);
      if (tabEls[TAB_HOME]) { setFocus(tabEls[TAB_HOME]); }
    }

    if (screen === 'detail') {
      openDetail(VOD[parseInt(map.vod, 10) || 0]);
    } else if (screen === 'search') {
      openSearch();
      if (map.q) { setSearchQuery(map.q); }
    } else if (screen === 'settings') {
      openSettings();
      if (map.panel !== undefined) { showSettingsPanel(parseInt(map.panel, 10) || 0, true); }
    } else if (screen === 'player') {
      openPlayer(map.mode === 'vod' ? 'vod' : 'live', VOD[parseInt(map.vod, 10) || 0]);
      if (map.channels === '1') { openChannelPanel(); }
    }

    if (map.focus) {
      var n = document.querySelector(map.focus);
      if (n) { setFocus(n); }
    }
  }

  function purgeMemoryCache() {
    stopPlayerVideo();
    clearSearchState();
  }

  window.addEventListener('beforeunload', purgeMemoryCache);
  window.addEventListener('unload', purgeMemoryCache);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && !window.XUPER_DESKTOP) {
      purgeMemoryCache();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
