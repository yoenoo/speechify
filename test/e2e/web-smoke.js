/**
 * End-to-end check for the browser build: serves web/dist over HTTP, loads it
 * in a plain browser context — no preload, no Node integration, nothing the
 * page could not get from a real web server — and drives it through a file
 * pick, playback and highlighting.
 *
 * Run with: npm run test:web
 */

import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DIST = path.join(ROOT, 'web', 'dist');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'complex.pdf');

const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.pfb': 'application/octet-stream',
};

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

function serve() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const resolved = path.resolve(DIST, relative);
    if (!resolved.startsWith(DIST)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(resolved);
      response.writeHead(200, {
        'Content-Type': TYPES[path.extname(resolved)] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const SPEECH_STUB = `(() => {
  const harness = (window.__harness = { queue: [], current: null, started: [], paused: false });
  const voice = { name: 'Test Voice', lang: 'en-US', voiceURI: 'test://voice', default: true };
  const pump = () => {
    if (harness.current || harness.queue.length === 0) return;
    harness.current = harness.queue.shift();
    harness.started.push(harness.current.text);
    harness.current.onstart?.();
  };
  harness.finish = () => { const d = harness.current; harness.current = null; d?.onend?.(); pump(); };
  harness.boundary = (i, l) => harness.current?.onboundary?.({ name: 'word', charIndex: i, charLength: l });

  window.speechSynthesis.getVoices = () => [voice];
  window.speechSynthesis.speak = (u) => { harness.queue.push(u); pump(); };
  window.speechSynthesis.cancel = () => { harness.queue.length = 0; harness.current = null; };
  window.speechSynthesis.pause = () => { harness.paused = true; };
  window.speechSynthesis.resume = () => { harness.paused = false; };
  Object.defineProperty(window.speechSynthesis, 'speaking', { get: () => harness.current !== null, configurable: true });
  Object.defineProperty(window.speechSynthesis, 'paused', { get: () => harness.paused, configurable: true });
  window.speechSynthesis.dispatchEvent(new Event('voiceschanged'));
  return true;
})()`;

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(win) {
  const contents = win.webContents;
  const errors = [];
  contents.on('console-message', (event) => {
    const level = event.level ?? event;
    if (level === 'error' || level === 3) errors.push(event.message ?? '');
  });

  await new Promise((resolve) => contents.once('dom-ready', resolve));
  await contents.executeJavaScript(SPEECH_STUB);
  await settle(700);

  const boot = await contents.executeJavaScript(`({
    noBridge: typeof window.speechify === 'undefined',
    noNode: typeof window.require === 'undefined' && typeof window.process === 'undefined',
    voices: document.getElementById('voice').options.length,
    support: document.getElementById('support').textContent.length > 20,
    status: document.getElementById('status').textContent,
    viewportMeta: document.querySelector('meta[name=viewport]')?.content ?? '',
  })`);

  check('runs with no Electron bridge', boot.noBridge);
  check('runs with no Node integration', boot.noNode);
  check('voices populate from the browser', boot.voices === 1, `${boot.voices}`);
  check('the page explains what to expect on this browser', boot.support);
  check('a viewport meta tag is present', /width=device-width/.test(boot.viewportMeta), boot.viewportMeta);
  check('the status bar invites a file', /Pick a PDF/.test(boot.status), boot.status);

  // Hand the file input a real File, the way a picker would.
  const bytes = await readFile(FIXTURE);
  const opened = await contents.executeJavaScript(`(async () => {
    const bytes = new Uint8Array(${JSON.stringify([...bytes])});
    const file = new File([bytes], 'complex.pdf', { type: 'application/pdf' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('file');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 2500));

    const canvas = document.querySelector('.page canvas');
    return {
      pages: document.querySelectorAll('.page').length,
      rendered: document.querySelectorAll('.page.is-rendered').length,
      canvasPixels: canvas ? canvas.width * canvas.height : 0,
      title: document.getElementById('doc-title').textContent,
      status: document.getElementById('status').textContent,
      highlights: document.querySelectorAll('.highlight-sentence').length,
      playDisabled: document.getElementById('play').disabled,
    };
  })()`);

  check('the picked PDF is laid out', opened.pages === 1, `${opened.pages} pages`);
  check('the page rasterises in the browser', opened.rendered >= 1 && opened.canvasPixels > 100000,
    `${opened.rendered} rendered, ${opened.canvasPixels} px`);
  check('the file name reaches the toolbar', opened.title === 'complex.pdf', opened.title);
  check('the first sentence is highlighted on load', opened.highlights >= 1);
  check('play becomes available', !opened.playDisabled);

  const playback = await contents.executeJavaScript(`(async () => {
    const harness = window.__harness;
    harness.started.length = 0;
    document.getElementById('play').click();
    await new Promise((r) => setTimeout(r, 300));
    const spoken = harness.started[0];

    harness.boundary(3, 8);
    await new Promise((r) => setTimeout(r, 100));
    const word = document.querySelector('.highlight-word')?.getBoundingClientRect();
    const sentence = document.querySelector('.highlight-sentence')?.getBoundingClientRect();

    harness.finish();
    await new Promise((r) => setTimeout(r, 300));
    return {
      spoken,
      queued: harness.started.length,
      hasWord: Boolean(word),
      wordInside: Boolean(word && sentence && word.left >= sentence.left - 3 && word.width < sentence.width),
      status: document.getElementById('status').textContent,
      label: document.getElementById('play-label').textContent,
    };
  })()`);

  check('play speaks the first sentence', /On the Segmentation/.test(playback.spoken || ''), playback.spoken);
  check('an utterance is queued ahead', playback.queued >= 2, `${playback.queued}`);
  check('a boundary paints the spoken word', playback.hasWord);
  check('the word box sits inside its sentence', playback.wordInside);
  check('the reader advances a sentence', /Sentence 2 of/.test(playback.status), playback.status);
  check('the button reads Pause while playing', playback.label === 'Pause', playback.label);

  // Tapping a sentence must start reading it directly — not resume playback
  // from wherever it last stopped and work forward. That was a real bug: a
  // jump to a distant sentence used to re-speak everything between the old
  // position and the target before ever reaching it, so this pins down the
  // exact sentence a tap near the bottom of the page must produce, not just
  // "not the first one".
  const tapped = await contents.executeJavaScript(`(async () => {
    const harness = window.__harness;
    harness.started.length = 0;
    const page = document.querySelector('.page');
    const box = page.getBoundingClientRect();
    page.dispatchEvent(new MouseEvent('click', {
      clientX: box.left + box.width * 0.4,
      clientY: box.top + box.height * 0.72,
      bubbles: true,
    }));
    await new Promise((r) => setTimeout(r, 300));
    return {
      spoke: harness.started[0],
      queueSize: harness.started.length,
      status: document.getElementById('status').textContent,
    };
  })()`);

  check('tapping a sentence jumps straight to it, not through every sentence in between',
    tapped.spoke === 'Section 3 gives the method, and Sec. 4 the evaluation.', tapped.spoke);
  check('only the tapped sentence (plus its lookahead) gets queued, not everything since the last position',
    tapped.queueSize === 1, `${tapped.queueSize} utterances started`);
  check('the status line reflects the tapped sentence, the last one on the page',
    /Sentence 15 of 15/.test(tapped.status), tapped.status);

  // Preferences must survive a reload via localStorage.
  const persisted = await contents.executeJavaScript(`(async () => {
    document.getElementById('settings-toggle').click();
    const slider = document.getElementById('rate');
    slider.value = '1.5';
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return { stored: localStorage.getItem('speechify.settings'),
             settingsVisible: !document.getElementById('settings').hidden };
  })()`);

  check('the settings panel toggles open', persisted.settingsVisible);
  check('preferences are written to localStorage', /"rate":1.5/.test(persisted.stored || ''), persisted.stored);

  check('the page logged no errors', errors.length === 0, errors.join(' | '));
}

app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const server = await serve();
  const { port } = server.address();

  // A deliberately plain browser window: no preload, no Node, sandboxed.
  const win = new BrowserWindow({
    width: 420,
    height: 860, // roughly a phone, to exercise the mobile layout
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  try {
    // Not awaited: `run` attaches its dom-ready listener while the load is in
    // flight, so awaiting here would mean waiting for an event already past.
    win.loadURL(`http://127.0.0.1:${port}/index.html`);
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
  server.close();
  app.exit(failed ? 1 : 0);
});
