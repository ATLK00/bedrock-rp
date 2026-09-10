'use strict';

// Minimal secure bridge. The renderer never touches the network or the
// filesystem: it asks the main process to do the login/round-trips and only
// receives a small result object. contextIsolation + sandbox stay on.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bedrockControl', {
  getSettings: () => ipcRenderer.invoke('control:settings'),
  setServer: (url) => ipcRenderer.invoke('control:set-server', url),
  login: (username, password) => ipcRenderer.invoke('control:login', { username, password }),
  logout: () => ipcRenderer.invoke('control:logout'),
});