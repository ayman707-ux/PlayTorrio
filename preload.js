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
  openMPVDirect: (url) => ipcRenderer.invoke('open-mpv-direct', url),
  castToChromecast: (data) => ipcRenderer.invoke('cast-to-chromecast', data),
  discoverChromecastDevices: () => ipcRenderer.invoke('discover-chromecast-devices'),
  onStreamClosed: (callback) => ipcRenderer.on('stream-closed', callback),
  clearWebtorrentTemp: () => ipcRenderer.invoke('clear-webtorrent-temp'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  selectCacheFolder: () => ipcRenderer.invoke('select-cache-folder'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  // Books server URL helpers
  booksGetUrl: () => ipcRenderer.invoke('books-get-url'),
  onBooksUrl: (cb) => ipcRenderer.on('books-url', (_e, payload) => cb && cb(payload)),
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
  // Discord Rich Presence API
  updateDiscordPresence: (presenceData) => ipcRenderer.invoke('update-discord-presence', presenceData),
  clearDiscordPresence: () => ipcRenderer.invoke('clear-discord-presence'),
  // EPUB Library API
  getEpubFolder: () => ipcRenderer.invoke('get-epub-folder'),
  // Accept both call styles:
  // 1) downloadEpub(url, bookData)
  // 2) downloadEpub({ url, bookData })
  downloadEpub: (arg1, arg2) => {
    let payload;
    if (arg1 && typeof arg1 === 'object' && 'url' in arg1) {
      payload = arg1;
    } else {
      payload = { url: arg1, bookData: arg2 };
    }
    return ipcRenderer.invoke('download-epub', payload);
  },
  getEpubLibrary: () => ipcRenderer.invoke('get-epub-library'),
  readEpubFile: (filePath) => ipcRenderer.invoke('read-epub-file', filePath),
  // Music offline download & library
  musicDownloadTrack: (track) => ipcRenderer.invoke('music-download-track', track),
  musicGetOfflineLibrary: () => ipcRenderer.invoke('music-offline-library'),
  musicDeleteOfflineTrack: (entryId) => ipcRenderer.invoke('music-offline-delete', entryId),
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
  ,
  // Window controls
  windowControls: {
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window-maximize-toggle'),
    close: () => ipcRenderer.invoke('window-close'),
    onMaximizeChanged: (cb) => ipcRenderer.on('window-maximize-changed', (_e, payload) => cb && cb(payload))
  }
});
