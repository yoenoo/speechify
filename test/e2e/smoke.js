/**
 * End-to-end smoke check: boots the real renderer, opens the fixture PDF
 * through the real IPC path and drives playback, asserting that pages render
 * and the right things get highlighted.
 *
 * Only the speech synthesiser is stubbed — headless machines have no system
 * voices. Everything upstream of it (pdf.js, segmentation, geometry, the
 * reader state machine, the DOM) is the production code.
 *
 * Run with: npm run test:e2e
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ORIGIN, registerScheme, serveBundle } from '../../electron/bundle-protocol.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'sample.pdf');

registerScheme();

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

/**
 * Stand in for a platform speech synthesiser: one English voice, announced
 * asynchronously the way real ones are, and utterances that start strictly one
 * at a time so the queue behaves like the real thing.
 */
const SPEECH_STUB = `(() => {
  const harness = (window.__harness = {
    queue: [], current: null, started: [], paused: false, cancels: 0,
  });
  const voice = { name: 'Test Voice', lang: 'en-US', voiceURI: 'test://voice', default: true, localService: true };

  const pump = () => {
    if (harness.current || harness.queue.length === 0) return;
    harness.current = harness.queue.shift();
    harness.started.push(harness.current.text);
    harness.current.onstart?.();
  };

  harness.finish = () => {
    const done = harness.current;
    harness.current = null;
    done?.onend?.();
    pump();
    return done?.text;
  };
  harness.boundary = (charIndex, charLength) =>
    harness.current?.onboundary?.({ name: 'word', charIndex, charLength });

  window.speechSynthesis.getVoices = () => [voice];
  window.speechSynthesis.speak = (u) => { harness.queue.push(u); pump(); };
  window.speechSynthesis.cancel = () => {
    harness.cancels++; harness.queue.length = 0; harness.current = null;
  };
  window.speechSynthesis.pause = () => { harness.paused = true; };
  window.speechSynthesis.resume = () => { harness.paused = false; };
  Object.defineProperty(window.speechSynthesis, 'speaking', {
    get: () => harness.current !== null, configurable: true,
  });
  Object.defineProperty(window.speechSynthesis, 'paused', {
    get: () => harness.paused, configurable: true,
  });

  window.speechSynthesis.dispatchEvent(new Event('voiceschanged'));
  return true;
})()`;

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(win) {
  const contents = win.webContents;
  const consoleErrors = [];
  contents.on('console-message', (event) => {
    const level = event.level ?? event;
    if (level === 'error' || level === 3) consoleErrors.push(event.message ?? '');
  });

  await new Promise((resolve) => contents.once('dom-ready', resolve));
  await contents.executeJavaScript(SPEECH_STUB);
  await settle(600);

  const boot = await contents.executeJavaScript(`({
    bridge: typeof window.speechify === 'object',
    bridgeApi: Object.keys(window.speechify ?? {}).sort().join(','),
    empty: !document.getElementById('empty-state').hidden,
    voices: document.getElementById('voice').options.length,
    playDisabled: document.getElementById('play').disabled,
    status: document.getElementById('status').textContent,
  })`);

  check('the preload bridge is exposed', boot.bridge);
  check('the bridge exposes exactly the intended surface',
    boot.bridgeApi === 'getSettings,onCommand,onDocument,openDialog,openPath,pathForFile,platform,saveSettings',
    boot.bridgeApi);
  check('the empty state shows before a document is open', boot.empty);
  check('system voices populate the picker', boot.voices === 1, `${boot.voices} options`);
  check('play stays disabled with no document', boot.playDisabled);

  // Open the PDF exactly as the main process does for a File > Open.
  const file = await readFile(FIXTURE);
  contents.send('document:open', {
    path: FIXTURE,
    name: 'sample.pdf',
    data: file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
  });
  await settle(2500);

  const opened = await contents.executeJavaScript(`(() => {
    const canvas = document.querySelector('.page canvas');
    return {
      pages: document.querySelectorAll('.page').length,
      rendered: document.querySelectorAll('.page.is-rendered').length,
      canvasPixels: canvas ? canvas.width * canvas.height : 0,
      status: document.getElementById('status').textContent,
      title: document.getElementById('doc-title').textContent,
      highlights: document.querySelectorAll('.highlight-sentence').length,
      playDisabled: document.getElementById('play').disabled,
      pageIndicator: document.getElementById('page-indicator').textContent,
    };
  })()`);

  check('both fixture pages are laid out', opened.pages === 2, `got ${opened.pages}`);
  check('the first page is rasterised', opened.rendered >= 1, `rendered ${opened.rendered}`);
  check('the canvas has real pixels', opened.canvasPixels > 100000, `${opened.canvasPixels} px`);
  check('the file name reaches the toolbar', opened.title === 'sample.pdf', opened.title);
  check('the status line reports the document', /2 pages/.test(opened.status), opened.status);
  check('the page indicator is filled in', /Page 1 \/ 2/.test(opened.pageIndicator), opened.pageIndicator);
  check('the first sentence is highlighted on load', opened.highlights >= 1, `${opened.highlights} boxes`);
  check('play is enabled once a document is open', !opened.playDisabled);

  const geometry = await contents.executeJavaScript(`(() => {
    const b = document.querySelector('.highlight-sentence').getBoundingClientRect();
    const p = document.querySelector('.page').getBoundingClientRect();
    return {
      insideX: b.left >= p.left - 2 && b.right <= p.right + 2,
      insideY: b.top >= p.top - 2 && b.bottom <= p.bottom + 2,
      width: b.width, height: b.height,
      relTop: (b.top - p.top) / p.height,
      relLeft: (b.left - p.left) / p.width,
    };
  })()`);

  check('the highlight sits inside the page horizontally', geometry.insideX);
  check('the highlight sits inside the page vertically', geometry.insideY);
  check('the highlight is a plausible size',
    geometry.width > 30 && geometry.height > 8 && geometry.height < 80,
    `${Math.round(geometry.width)}x${Math.round(geometry.height)}`);
  check('the first sentence is near the top of the page', geometry.relTop < 0.15,
    `relTop=${geometry.relTop.toFixed(3)}`);
  check('the highlight starts at the left margin', geometry.relLeft > 0.08 && geometry.relLeft < 0.18,
    `relLeft=${geometry.relLeft.toFixed(3)}`);

  const playback = await contents.executeJavaScript(`(async () => {
    const harness = window.__harness;
    harness.started.length = 0;
    document.getElementById('play').click();
    await new Promise((r) => setTimeout(r, 300));

    const beforeWord = document.querySelectorAll('.highlight-word').length;
    harness.boundary(8, 8);
    await new Promise((r) => setTimeout(r, 80));
    const afterWord = document.querySelectorAll('.highlight-word').length;
    const wordBox = document.querySelector('.highlight-word')?.getBoundingClientRect();
    const sentenceBox = document.querySelector('.highlight-sentence')?.getBoundingClientRect();

    harness.finish();
    await new Promise((r) => setTimeout(r, 300));

    return {
      firstSpoken: harness.started[0],
      spokenCount: harness.started.length,
      beforeWord, afterWord,
      wordInsideSentence: Boolean(wordBox && sentenceBox &&
        wordBox.left >= sentenceBox.left - 3 && wordBox.right <= sentenceBox.right + 3 &&
        wordBox.width < sentenceBox.width),
      progress: document.getElementById('progress').textContent,
      playLabel: document.getElementById('play-label').textContent,
    };
  })()`);

  check('play speaks the first unit', /Reading Machines/.test(playback.firstSpoken || ''), playback.firstSpoken);
  check('an utterance is queued ahead', playback.spokenCount >= 2, `${playback.spokenCount} queued`);
  check('no word is highlighted before a boundary event', playback.beforeWord === 0);
  check('a boundary event paints the spoken word', playback.afterWord >= 1);
  check('the word box sits within its sentence box', playback.wordInsideSentence);
  check('the button reads Pause while playing', playback.playLabel === 'Pause', playback.playLabel);
  check('finishing a sentence advances the reader', /Sentence [2-9]/.test(playback.progress), playback.progress);

  const paused = await contents.executeJavaScript(`(async () => {
    document.getElementById('play').click();
    await new Promise((r) => setTimeout(r, 120));
    const label = document.getElementById('play-label').textContent;
    const wasPaused = window.__harness.paused;
    document.getElementById('play').click();
    await new Promise((r) => setTimeout(r, 120));
    return { label, wasPaused, resumed: !window.__harness.paused,
             resumedLabel: document.getElementById('play-label').textContent };
  })()`);

  check('clicking play again pauses the engine', paused.wasPaused && paused.label === 'Resume', paused.label);
  check('clicking once more resumes it', paused.resumed && paused.resumedLabel === 'Pause', paused.resumedLabel);

  const clicked = await contents.executeJavaScript(`(async () => {
    const harness = window.__harness;
    harness.started.length = 0;
    const page = document.querySelector('.page');
    const p = page.getBoundingClientRect();
    page.dispatchEvent(new MouseEvent('click', {
      clientX: p.left + p.width * 0.3,
      clientY: p.top + p.height * 0.115,
      bubbles: true,
    }));
    await new Promise((r) => setTimeout(r, 300));
    return { spoke: harness.started[0], progress: document.getElementById('progress').textContent };
  })()`);

  check('clicking a sentence starts reading it', Boolean(clicked.spoke), clicked.progress);
  check('the clicked sentence is not the heading',
    Boolean(clicked.spoke) && !/^Reading Machines/.test(clicked.spoke), clicked.spoke);

  const navigated = await contents.executeJavaScript(`(async () => {
    const harness = window.__harness;
    const before = document.getElementById('progress').textContent;
    harness.started.length = 0;
    document.getElementById('next').click();
    await new Promise((r) => setTimeout(r, 250));
    const afterNext = document.getElementById('progress').textContent;
    document.getElementById('previous').click();
    await new Promise((r) => setTimeout(r, 250));
    return { before, afterNext, afterPrevious: document.getElementById('progress').textContent };
  })()`);

  const num = (text) => Number(/Sentence (\d+)/.exec(text)?.[1] ?? 0);
  check('next moves forward one sentence', num(navigated.afterNext) === num(navigated.before) + 1,
    `${navigated.before} -> ${navigated.afterNext}`);
  check('previous moves back one sentence', num(navigated.afterPrevious) === num(navigated.afterNext) - 1,
    `${navigated.afterNext} -> ${navigated.afterPrevious}`);

  const zoomed = await contents.executeJavaScript(`(async () => {
    const before = document.querySelector('.highlight-sentence').getBoundingClientRect();
    const pageBefore = document.querySelector('.page').getBoundingClientRect();
    document.getElementById('zoom-in').click();
    await new Promise((r) => setTimeout(r, 800));
    const after = document.querySelector('.highlight-sentence').getBoundingClientRect();
    const pageAfter = document.querySelector('.page').getBoundingClientRect();
    return {
      pageGrew: pageAfter.width > pageBefore.width + 1,
      ratio: after.width / before.width,
      pageRatio: pageAfter.width / pageBefore.width,
      stillRendered: document.querySelectorAll('.page.is-rendered').length,
    };
  })()`);

  check('zooming in enlarges the page', zoomed.pageGrew);
  check('the highlight scales with the page', Math.abs(zoomed.ratio - zoomed.pageRatio) < 0.05,
    `highlight x${zoomed.ratio.toFixed(3)} vs page x${zoomed.pageRatio.toFixed(3)}`);
  check('pages re-rasterise after a zoom', zoomed.stillRendered >= 1, `${zoomed.stillRendered} rendered`);

  const keyboard = await contents.executeJavaScript(`(async () => {
    const before = document.getElementById('play-label').textContent;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    return { before, after: document.getElementById('play-label').textContent };
  })()`);

  check('Escape stops playback', keyboard.after === 'Play', `${keyboard.before} -> ${keyboard.after}`);
  check('the renderer logged no errors', consoleErrors.length === 0, consoleErrors.join(' | '));
}

app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  serveBundle(ROOT);

  // Stand in for the parts of main.js the renderer talks to on startup.
  ipcMain.handle('settings:get', () => ({ rate: 1, voiceURI: null, zoom: 'width', recent: [] }));
  ipcMain.handle('settings:set', (_event, patch) => patch);
  ipcMain.handle('dialog:open', () => null);
  ipcMain.handle('document:openPath', () => null);

  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    win.loadURL(`${ORIGIN}/src/index.html`);
    await run(win);
  } catch (error) {
    check('the harness ran to completion', false, error.stack ?? String(error));
  }

  let failed = false;
  for (const { name, ok, detail } of checks) {
    if (!ok) failed = true;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  }
  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
  app.exit(failed ? 1 : 0);
});
