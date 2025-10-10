// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Try to require WebChimera components safely (optional)
let wcRendererMod = null;
let wcPrebuilt = null;
try {
  // Prefer the simple init interface from jaruba/wcjs-renderer fork if present
  wcRendererMod = require('wcjs-renderer');
} catch (_) {}
try {
  wcPrebuilt = require('wcjs-prebuilt');
} catch (_) {}

contextBridge.exposeInMainWorld('electronAPI', {
  openInMPV: (data) => ipcRenderer.invoke('open-in-mpv', data),
  onStreamClosed: (callback) => ipcRenderer.on('stream-closed', callback),
  clearWebtorrentTemp: () => ipcRenderer.invoke('clear-webtorrent-temp'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  // WebChimera exposure (optional, may be null if not installed)
  wcjs: {
    available: Boolean(wcRendererMod),
    init(canvasSelector, vlcArgs = []) {
      if (!wcRendererMod) return null;
      try {
        const canvas = document.querySelector(canvasSelector);
        if (!canvas) return null;
        // Prefer "bind" API with our own player from wcjs-prebuilt if available
        if (typeof wcRendererMod.bind === 'function' && wcPrebuilt) {
          const player = (wcPrebuilt.createPlayer ? wcPrebuilt.createPlayer(vlcArgs) : new wcPrebuilt.VlcPlayer(vlcArgs));
          wcRendererMod.bind(canvas, player, {});
          return { player };
        }
        // Fallback to renderer's own init(canvas, args, fallback)
        if (typeof wcRendererMod.init === 'function') {
          const player = wcRendererMod.init(canvas, vlcArgs, false);
          return { player };
        }
        return null;
      } catch (e) {
        return null;
      }
    }
  }
});
