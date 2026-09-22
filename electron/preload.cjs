/**
 * The only bridge between the sandboxed renderer and the main process.
 *
 * Everything exposed here is a named operation with a fixed shape — no generic
 * `invoke`, no filesystem handle — so the renderer's authority stays a short,
 * readable list.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('speechify', {
  platform: process.platform,

  /** Ask the main process to show an open dialog. */
  openDialog: () => ipcRenderer.invoke('dialog:open'),

  /** Open a path, e.g. a file the user dropped onto the window. */
  openPath: (filePath) => ipcRenderer.invoke('document:openPath', filePath),

  /**
   * The on-disk path behind a dropped `File`, when there is one. Routing a
   * drop back through the main process is what lets it join the recent
   * documents list; the renderer can always fall back to reading the bytes
   * itself, so this returning null is not a failure.
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  /** Fires when the main process has read a PDF for us. */
  onDocument: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('document:open', listener);
    return () => ipcRenderer.off('document:open', listener);
  },

  /** Menu and accelerator commands ('toggle', 'next', 'zoomIn', …). */
  onCommand: (handler) => {
    const listener = (_event, command) => handler(command);
    ipcRenderer.on('command', listener);
    return () => ipcRenderer.off('command', listener);
  },
});
