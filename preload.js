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
  // Updater bridge (events only + install trigger)
  onUpdateChecking: (cb) => ipcRenderer.on('update-checking', (_e, info) => cb && cb(info)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, info) => cb && cb(info)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', (_e, info) => cb && cb(info)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-download-progress', (_e, p) => cb && cb(p)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_e, info) => cb && cb(info)),
  installUpdateNow: () => ipcRenderer.invoke('updater-install'),
  // My List API
  myListRead: () => ipcRenderer.invoke('my-list-read'),
  myListWrite: (data) => ipcRenderer.invoke('my-list-write', data),
  // Done Watching API
  doneWatchingRead: () => ipcRenderer.invoke('done-watching-read'),
  doneWatchingWrite: (data) => ipcRenderer.invoke('done-watching-write', data),
  // Fullscreen API
  setFullscreen: (isFullscreen) => ipcRenderer.invoke('set-fullscreen', isFullscreen),
  getFullscreen: () => ipcRenderer.invoke('get-fullscreen'),
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
