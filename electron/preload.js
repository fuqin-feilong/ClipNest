'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('clipnest', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  copyItem: (id, options = {}) =>
    ipcRenderer.invoke('history:copy', {
      id,
      plain: Boolean(options.plain),
      paste: Boolean(options.paste),
    }),
  pinItem: (id) => ipcRenderer.invoke('history:pin', id),
  deleteItem: (id) => ipcRenderer.invoke('history:delete', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  togglePause: () => ipcRenderer.invoke('capture:toggle-pause'),
  setPaused: (value) => ipcRenderer.invoke('capture:set-pause', value),
  suspendHotkey: () => ipcRenderer.invoke('hotkey:suspend'),
  resumeHotkey: () => ipcRenderer.invoke('hotkey:resume'),
  setHotkey: (accelerator) => ipcRenderer.invoke('hotkey:set', accelerator),
  openDataFolder: () => ipcRenderer.invoke('app:open-data'),
  hidePanel: () => ipcRenderer.invoke('app:hide-panel'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onHistoryChanged: (callback) => subscribe('history:changed', callback),
  onSettingsChanged: (callback) => subscribe('settings:changed', callback),
  onMetaChanged: (callback) => subscribe('app:meta', callback),
  onPausedChanged: (callback) => subscribe('capture:paused', callback),
  onPanelShown: (callback) => subscribe('panel:shown', callback),
  onOpenSettings: (callback) => subscribe('panel:open-settings', callback),
  platform: process.platform,
});
