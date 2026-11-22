'use strict';

const path = require('node:path');
const Module = require('node:module');

// Keep the portal's registered methods and normal/smooth resolution flows.
// Only replace the webOS message bus with a private, in-process dispatcher.
function createService() {
  const handlers = new Map();
  class DesktopBus {
    register(name, callback) { handlers.set(name, callback); }
  }
  const originalLoad = Module._load;
  const originalExit = process.exit;
  const previousExceptions = new Set(process.listeners('uncaughtException'));
  try {
    Module._load = function (id, parent, isMain) {
      if (id === 'webos-service') return DesktopBus;
      return originalLoad.call(this, id, parent, isMain);
    };
    require('../service/index.js');
  } finally {
    Module._load = originalLoad;
    process.exit = originalExit;
    for (const listener of process.listeners('uncaughtException')) {
      if (!previousExceptions.has(listener)) process.removeListener('uncaughtException', listener);
    }
  }
  const magis = require('../service/magis.js');
  const m3u = require('../service/m3u.js');
  return {
    // Main process only: a file the user picked in the Windows dialog.
    myListsAddFile: (file, name) => new Promise((resolve) => {
      m3u.addFile(file, name, (err, data) => resolve(err
        ? { returnValue: false, errorText: err.message || 'error' }
        : Object.assign({ returnValue: true }, data)));
    }),
    // Main process only: the sync folder holds a full path of the user's PC.
    myLists: {
      syncFolder: () => m3u.syncFolder(),
      setSyncFolder: (dir) => m3u.setSyncFolder(dir),
      syncFromFolder: (dir) => new Promise((resolve) => {
        m3u.syncFromFolder(dir, (err, data) => resolve(err
          ? { returnValue: false, errorText: err.message || 'error' }
          : Object.assign({ returnValue: true }, data)));
      }),
      isYoutube: (url) => m3u.isYoutube(url)
    },
    // Main process only: a folder of videos the user picked in the dialog.
    videotecaAddFolder: (dir) => new Promise((resolve) => {
      require('../service/videoteca.js').addFolder(dir, (err, data) => resolve(err
        ? { returnValue: false, errorText: err.message || 'error' }
        : Object.assign({ returnValue: true }, data)));
    }),
    methods: Array.from(handlers.keys()),
    // Main process only: the renderer never sees the account session.
    account: {
      snapshot: () => magis.accountSnapshot(),
      restore: (saved) => magis.restoreAccount(saved),
      onChange: (listener) => magis.setAccountListener(listener),
      setRemembered: (on) => magis.setAccountRemembered(on)
    },
    call(name, payload = {}, timeoutMs = 30000) {
      return new Promise((resolve) => {
        const handler = handlers.get(name);
        if (!handler) return resolve({ returnValue: false, errorText: 'Operación no disponible' });
        let finished = false;
        const timer = setTimeout(() => finish({ returnValue: false, errorText: 'El servicio no respondió. Revisa la conexión o vuelve a intentarlo.' }), timeoutMs);
        function finish(value) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve(value || { returnValue: false, errorText: 'Respuesta vacía' });
        }
        try { handler({ payload, isSubscription: false, respond: finish }); }
        catch (err) { finish({ returnValue: false, errorText: err.message }); }
      });
    },
    close() {
      require('../service/media-duration.js').close();
      require('../service/ffmpeg-relay.js').close();
      require('../service/proxy.js').close();
    }
  };
}

module.exports = { createService };
