// Preload script: the only bridge between Electron and the web page.
// It exposes read-only version info and nothing else (no file system, no IPC).
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('appInfo', {
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: process.platform,
  arch: process.arch,
});
