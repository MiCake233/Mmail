'use strict';

/**
 * Mmail · renderer bridge
 * ---------------------------------------------------------------------------
 * Whitelisted methods only; the renderer never sees Node or ipcRenderer itself.
 * Only a whitelisted API is exposed — the renderer never sees Node or ipcRenderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mmail', {
  isDesktop: true,
  platform: process.platform,

  /** Full state: settings, accounts (without secrets), last check result */
  getState: () => ipcRenderer.invoke('app:get-state'),

  /** Update a setting: autoStart | startMinimized | mailEnabled | intervalMinutes */
  setSetting: (key, value) => ipcRenderer.invoke('app:set-setting', key, value),

  addAccount: (payload) => ipcRenderer.invoke('mail:add-account', payload),
  removeAccount: (id) => ipcRenderer.invoke('mail:remove-account', id),
  testAccount: (payload) => ipcRenderer.invoke('mail:test-account', payload),
  checkNow: () => ipcRenderer.invoke('mail:check-now'),

  /** Mirror UI language changes to the main process (notifications, tray menu) */
  setLang: (lang) => ipcRenderer.send('ui:set-lang', lang),

  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  /** Update check, diagnostics and per-account notification state. */
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  copyDiagnostics: () => ipcRenderer.invoke('diag:copy'),
  setAccountNotify: (id, notify) => ipcRenderer.invoke('mail:set-account-notify', id, notify),
  clearBrowserData: () => ipcRenderer.invoke('browser:clear'),

  /** Embedded browser: separate sandboxed webContents hosted by the window. */
  browser: {
    open: (url, bounds) => ipcRenderer.invoke('browser:open', url, bounds),
    close: () => ipcRenderer.invoke('browser:close'),
    setBounds: (bounds) => ipcRenderer.invoke('browser:set-bounds', bounds),
    action: (name) => ipcRenderer.invoke('browser:action', name),
    onState: (callback) => {
      const handler = (event, state) => callback(state);
      ipcRenderer.on('browser:state', handler);
      return () => ipcRenderer.removeListener('browser:state', handler);
    },
  },

  /** Subscribe to pushed state; returns an unsubscribe function */
  onState: (callback) => {
    const handler = (event, state) => callback(state);
    ipcRenderer.on('app:state', handler);
    return () => ipcRenderer.removeListener('app:state', handler);
  },
});
