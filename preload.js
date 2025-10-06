// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openInMPV: (data) => ipcRenderer.invoke('open-in-mpv', data),
  onStreamClosed: (callback) => ipcRenderer.on('stream-closed', callback),
  clearWebtorrentTemp: () => ipcRenderer.invoke('clear-webtorrent-temp'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  installMPV: () => ipcRenderer.invoke('install-mpv'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text)
});
