/**
 * Electron main process: the window, the application menu, file access and
 * persisted preferences.
 *
 * The renderer is fully isolated — no Node integration, sandboxed, and served
 * over a custom `app://` scheme rather than `file://`. Reading a PDF from disk
 * happens here and the bytes are handed across; the renderer never touches the
 * filesystem itself.
 */

import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ORIGIN, registerScheme, serveBundle } from './bundle-protocol.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_RECENT = 10;

registerScheme();

let mainWindow = null;
let pendingOpenPath = null;
let settings = defaultSettings();

function defaultSettings() {
  return { rate: 1, voiceURI: null, zoom: 'width', theme: 'system', recent: [] };
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

async function loadSettings() {
  try {
    const raw = await readFile(settingsPath(), 'utf8');
    settings = { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    settings = defaultSettings(); // first run, or a file we can't parse
  }
}

async function saveSettings() {
  try {
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    await writeFile(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (error) {
    console.warn('could not persist preferences:', error.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#14161a',
    title: 'Speechify',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`${ORIGIN}/src/index.html`);

  // Keep navigation inside the app; send real links to the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN)) event.preventDefault();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOpenPath) {
      openPath(pendingOpenPath);
      pendingOpenPath = null;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function readPdf(filePath) {
  const data = await readFile(filePath);
  rememberRecent(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    // A plain ArrayBuffer crosses the context bridge as a transferable.
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  };
}

function rememberRecent(filePath) {
  settings.recent = [filePath, ...settings.recent.filter((p) => p !== filePath)].slice(0, MAX_RECENT);
  app.addRecentDocument(filePath);
  saveSettings();
  rebuildMenu();
}

async function openPath(filePath) {
  if (!mainWindow) return;
  try {
    const payload = await readPdf(filePath);
    mainWindow.webContents.send('document:open', payload);
  } catch (error) {
    dialog.showErrorBox('Could not open file', `${filePath}\n\n${error.message}`);
  }
}

async function promptForFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return openPath(result.filePaths[0]);
}

function send(channel, payload) {
  mainWindow?.webContents.send(channel, payload);
}

function rebuildMenu() {
  const isMac = process.platform === 'darwin';
  const recentItems = settings.recent.map((filePath) => ({
    label: path.basename(filePath),
    sublabel: path.dirname(filePath),
    click: () => openPath(filePath),
  }));

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'Open PDF…', accelerator: 'CmdOrCtrl+O', click: promptForFile },
        {
          label: 'Open Recent',
          submenu: recentItems.length
            ? [
                ...recentItems,
                { type: 'separator' },
                {
                  label: 'Clear Menu',
                  click: () => {
                    settings.recent = [];
                    app.clearRecentDocuments();
                    saveSettings();
                    rebuildMenu();
                  },
                },
              ]
            : [{ label: 'No recent documents', enabled: false }],
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '&Playback',
      submenu: [
        {
          label: 'Play / Pause',
          accelerator: 'Space',
          registerAccelerator: false, // the renderer owns Space; this is a hint
          click: () => send('command', 'toggle'),
        },
        { label: 'Next Sentence', accelerator: 'CmdOrCtrl+Right', click: () => send('command', 'next') },
        { label: 'Previous Sentence', accelerator: 'CmdOrCtrl+Left', click: () => send('command', 'previous') },
        { type: 'separator' },
        { label: 'Speed Up', accelerator: 'CmdOrCtrl+]', click: () => send('command', 'faster') },
        { label: 'Slow Down', accelerator: 'CmdOrCtrl+[', click: () => send('command', 'slower') },
        { label: 'Stop', accelerator: 'Esc', registerAccelerator: false, click: () => send('command', 'stop') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => send('command', 'zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('command', 'zoomOut') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+0', click: () => send('command', 'fitWidth') },
        { label: 'Fit Page', accelerator: 'CmdOrCtrl+9', click: () => send('command', 'fitPage') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -- IPC ---------------------------------------------------------------------

ipcMain.handle('dialog:open', () => promptForFile());
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_event, patch) => {
  settings = { ...settings, ...patch };
  saveSettings();
  return settings;
});
ipcMain.handle('document:openPath', (_event, filePath) => openPath(filePath));

// -- lifecycle ---------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const file = argv.find((arg) => arg.toLowerCase().endsWith('.pdf'));
    if (file) openPath(path.resolve(file));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // macOS delivers "open with" before the app is ready.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (mainWindow) openPath(filePath);
    else pendingOpenPath = filePath;
  });

  app.whenReady().then(async () => {
    await loadSettings();
    serveBundle(ROOT);
    rebuildMenu();

    const fromArgv = process.argv.slice(1).find((arg) => arg.toLowerCase().endsWith('.pdf'));
    if (fromArgv) pendingOpenPath = path.resolve(fromArgv);

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
