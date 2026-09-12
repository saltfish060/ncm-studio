const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ncmStudio', {
  chooseFiles: () => ipcRenderer.invoke('files:choose'),
  chooseFolder: (initial) => ipcRenderer.invoke('folder:choose', initial),
  filePathsFromDrop: (files) => files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  fileDetails: (paths) => ipcRenderer.invoke('files:details', paths),
  revealFile: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  setTheme: (theme) => ipcRenderer.send('window:theme', theme),
  scan: (folder) => ipcRenderer.invoke('scan:start', folder),
  convert: (files, settings) => ipcRenderer.invoke('convert:start', { files, settings }),
  cancel: () => ipcRenderer.invoke('convert:cancel'),
  openFolder: (folder) => ipcRenderer.invoke('folder:open', folder),
  openLicenses: () => ipcRenderer.invoke('app:open-licenses'),
  onScanProgress: (callback) => { const listener = (_, data) => callback(data); ipcRenderer.on('scan:progress', listener); return () => ipcRenderer.removeListener('scan:progress', listener); },
  onConvertProgress: (callback) => { const listener = (_, data) => callback(data); ipcRenderer.on('convert:progress', listener); return () => ipcRenderer.removeListener('convert:progress', listener); }
});
