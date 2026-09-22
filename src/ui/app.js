/**
 * Renderer entry point: wires the document, the page view and the reader
 * together, and owns the toolbar.
 *
 * The interesting flow is small. The reader says "I am speaking unit N" and
 * "I am at character C of it"; this module turns those into rectangles via the
 * page model and hands them to the view. Nothing else needs to know how speech
 * or PDF geometry works.
 */

import * as pdfjs from '../../node_modules/pdfjs-dist/build/pdf.mjs';
import { loadDocument } from '../viewer/pdf-document.js';
import { PageView } from '../viewer/page-view.js';
import { Reader } from '../speech/reader.js';
import { WebSpeechEngine } from '../speech/web-speech-engine.js';
import { wordRangeAt } from '../core/text-model.js';
import { hitTest } from '../core/geometry.js';

const PDFJS_BASE = '../../node_modules/pdfjs-dist/';
pdfjs.GlobalWorkerOptions.workerSrc = new URL(`${PDFJS_BASE}build/pdf.worker.mjs`, import.meta.url).href;
const STANDARD_FONT_DATA_URL = new URL(`${PDFJS_BASE}standard_fonts/`, import.meta.url).href;
const CMAP_URL = new URL(`${PDFJS_BASE}cmaps/`, import.meta.url).href;
const WASM_URL = new URL(`${PDFJS_BASE}wasm/`, import.meta.url).href;
const ICC_URL = new URL(`${PDFJS_BASE}iccs/`, import.meta.url).href;

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const MIN_RATE = 0.5;
const MAX_RATE = 3;

const bridge = globalThis.speechify ?? null;
const el = (id) => document.getElementById(id);

const ui = {
  viewer: el('viewer'),
  emptyState: el('empty-state'),
  open: el('open'),
  openEmpty: el('open-empty'),
  docTitle: el('doc-title'),
  play: el('play'),
  playIcon: el('play-icon'),
  playLabel: el('play-label'),
  next: el('next'),
  previous: el('previous'),
  voice: el('voice'),
  rate: el('rate'),
  rateValue: el('rate-value'),
  zoomIn: el('zoom-in'),
  zoomOut: el('zoom-out'),
  zoomFit: el('zoom-fit'),
  status: el('status'),
  progress: el('progress'),
  pageIndicator: el('page-indicator'),
  dropOverlay: el('drop-overlay'),
};

const engine = new WebSpeechEngine();
const reader = new Reader(engine);

const state = {
  doc: null,
  voices: [],
  zoomMode: 'width', // 'width' | 'page' | a number
  sentenceRects: [],
  settings: { rate: 1, voiceURI: null, zoom: 'width' },
};

const view = new PageView(ui.viewer, {
  onPageClick: startReadingAt,
  onVisiblePageChange: updatePageIndicator,
});

// -- status ------------------------------------------------------------------

function setStatus(message, kind = 'info') {
  ui.status.textContent = message;
  ui.status.classList.toggle('is-error', kind === 'error');
  ui.status.classList.toggle('is-warning', kind === 'warning');
}

// -- loading -----------------------------------------------------------------

async function openArrayBuffer(data, name) {
  setStatus(`Opening ${name}…`);
  ui.emptyState.hidden = true;

  try {
    state.doc?.destroy();
    state.doc = null;

    const doc = await loadDocument(
      pdfjs,
      new Uint8Array(data),
      ({ stage, loaded, total }) => {
        if (stage === 'text' && total > 1) setStatus(`Reading text… page ${loaded} of ${total}`);
      },
      {
        standardFontDataUrl: STANDARD_FONT_DATA_URL,
        cMapUrl: CMAP_URL,
        wasmUrl: WASM_URL,
        iccUrl: ICC_URL,
      }
    );

    state.doc = doc;
    ui.docTitle.textContent = name;
    document.title = `${name} — Speechify`;

    // Lay the pages out first: a fit-to-width scale can only be worked out once
    // the view knows the page dimensions.
    view.setDocument(doc, 1);
    view.setScale(resolveScale());
    reader.setUnits(doc.units);

    if (doc.units.length === 0) {
      setStatus(
        'No selectable text in this PDF — it is probably a scan, which needs OCR before it can be read aloud.',
        'warning'
      );
    } else {
      setStatus(`${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}, ${doc.units.length} sentences`);
      highlightUnit(0);
    }

    updateControls();
    updatePageIndicator(0);
  } catch (error) {
    console.error(error);
    ui.emptyState.hidden = state.doc !== null;
    setStatus(describeLoadError(error), 'error');
  }
}

function describeLoadError(error) {
  if (error?.name === 'PasswordException') return 'That PDF is password protected.';
  if (error?.name === 'InvalidPDFException') return 'That file is not a readable PDF.';
  return `Could not open the document: ${error?.message ?? error}`;
}

// -- highlighting ------------------------------------------------------------

function highlightUnit(index, { reveal = true } = {}) {
  const unit = state.doc?.units[index];
  if (!unit) return;

  state.sentenceRects = state.doc.rectsForUnit(unit);
  view.highlight({ pageIndex: unit.pageIndex, sentenceRects: state.sentenceRects });
  if (reveal) view.revealRects(unit.pageIndex, state.sentenceRects);

  ui.progress.textContent = `Sentence ${index + 1} of ${state.doc.units.length}`;
}

function highlightWord(unit, charIndex, charLength) {
  const pageText = state.doc.pageText(unit.pageIndex);
  const absolute = unit.start + charIndex;

  // Engines disagree on whether a length comes with the boundary event, and
  // some report the offset mid-word, so the word is resolved from the text.
  const range =
    charLength > 0
      ? { start: absolute, end: Math.min(absolute + charLength, unit.end) }
      : wordRangeAt(pageText, absolute, unit.start, unit.end);
  if (!range) return;

  view.highlight({
    pageIndex: unit.pageIndex,
    sentenceRects: state.sentenceRects,
    wordRects: state.doc.rectsForRange(unit.pageIndex, range.start, range.end),
  });
}

/** Clicking anywhere in a sentence starts reading from that sentence. */
function startReadingAt({ pageIndex, x, y }) {
  if (!state.doc) return;
  const candidates = state.doc.unitsByPage.get(pageIndex) ?? [];

  let best = null;
  for (const unit of candidates) {
    const rects = state.doc.rectsForUnit(unit);
    if (hitTest(rects, x, y, 3)) {
      best = unit;
      break;
    }
    // Fall back to the last sentence that starts above the click, so clicking
    // in a margin or between lines still does something sensible.
    if (rects.length > 0 && rects[0].y <= y) best = unit;
  }

  if (best) reader.play(best.index);
}

// -- reader events -----------------------------------------------------------

reader.on('unit', ({ index }) => highlightUnit(index));
reader.on('word', ({ unit, charIndex, charLength }) => highlightWord(unit, charIndex, charLength));

reader.on('state', ({ state: playbackState }) => {
  const playing = playbackState === 'playing';
  ui.playIcon.innerHTML = playing ? '&#10073;&#10073;' : '&#9654;';
  ui.playLabel.textContent = playing ? 'Pause' : playbackState === 'paused' ? 'Resume' : 'Play';
});

reader.on('end', () => setStatus('Finished reading.'));

reader.on('error', ({ error }) => {
  setStatus(`Speech engine error (${error?.error ?? 'unknown'}) — skipping that sentence.`, 'warning');
});

reader.on('stall', () => setStatus('Speech stalled; picking it up again…', 'warning'));

// -- controls ----------------------------------------------------------------

function updateControls() {
  const ready = Boolean(state.doc) && state.doc.units.length > 0;
  const canSpeak = ready && state.voices.length > 0;
  ui.play.disabled = !canSpeak;
  ui.next.disabled = !ready;
  ui.previous.disabled = !ready;
}

function updatePageIndicator(pageIndex) {
  if (!state.doc) {
    ui.pageIndicator.textContent = '';
    return;
  }
  ui.pageIndicator.textContent = `Page ${pageIndex + 1} / ${state.doc.pageCount}`;
}

function resolveScale() {
  if (typeof state.zoomMode === 'number') return state.zoomMode;
  return view.fitScale(state.zoomMode);
}

function applyZoom(mode) {
  state.zoomMode = mode;
  view.setScale(resolveScale());
  redrawHighlight();
  persist({ zoom: mode });
}

function stepZoom(direction) {
  const current = view.scale;
  const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  const next = steps.find((step) => (direction > 0 ? step > current + 0.01 : step < current - 0.01));
  applyZoom(next ?? current);
}

function redrawHighlight() {
  if (state.doc) highlightUnit(reader.index, { reveal: false });
}

function clampRate(rate) {
  return Math.min(Math.max(rate, MIN_RATE), MAX_RATE);
}

/** Show a rate without acting on it — used while the slider is being dragged. */
function previewRate(rate) {
  const clamped = clampRate(rate);
  ui.rate.value = String(clamped);
  ui.rateValue.textContent = `${clamped.toFixed(2).replace(/0$/, '')}×`;
  return clamped;
}

/**
 * Apply a new rate. A rate is baked into an utterance when it is created, so
 * this respeaks the current sentence — which is why it is deliberately not
 * wired to every `input` event the slider fires while being dragged.
 */
function setRate(rate) {
  const clamped = previewRate(rate);
  reader.updateSettings({ rate: clamped });
  persist({ rate: clamped });
}

async function persist(patch) {
  state.settings = { ...state.settings, ...patch };
  await bridge?.saveSettings(patch);
}

// -- voices ------------------------------------------------------------------

async function loadVoices() {
  if (!WebSpeechEngine.isAvailable()) {
    setStatus('This build has no speech synthesiser available.', 'error');
    return;
  }

  state.voices = await engine.listVoices();
  ui.voice.replaceChildren();

  if (state.voices.length === 0) {
    ui.voice.disabled = true;
    setStatus(noVoicesMessage(), 'error');
    updateControls();
    return;
  }

  // Group by language so a long system voice list stays navigable.
  const byLanguage = new Map();
  state.voices.forEach((voice, index) => {
    const key = voice.lang || 'other';
    if (!byLanguage.has(key)) byLanguage.set(key, []);
    byLanguage.get(key).push({ voice, index });
  });

  const preferred = [...byLanguage.keys()].sort((a, b) => {
    const target = navigator.language;
    return scoreLanguage(b, target) - scoreLanguage(a, target) || a.localeCompare(b);
  });

  for (const language of preferred) {
    const group = document.createElement('optgroup');
    group.label = language;
    for (const { voice, index } of byLanguage.get(language)) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = voice.name + (voice.default ? ' (default)' : '');
      group.append(option);
    }
    ui.voice.append(group);
  }

  ui.voice.disabled = false;
  const saved = state.voices.findIndex((voice) => voice.voiceURI === state.settings.voiceURI);
  const chosen = saved !== -1 ? saved : state.voices.findIndex((voice) => voice.default);
  selectVoice(chosen === -1 ? 0 : chosen);
  updateControls();
}

function scoreLanguage(language, target) {
  if (!language || !target) return 0;
  const normalise = (value) => value.replace('_', '-').toLowerCase();
  const a = normalise(language);
  const b = normalise(target);
  if (a === b) return 2;
  return a.split('-')[0] === b.split('-')[0] ? 1 : 0;
}

function selectVoice(index) {
  const voice = state.voices[index];
  if (!voice) return;
  ui.voice.value = String(index);
  reader.updateSettings({ voice });
  persist({ voiceURI: voice.voiceURI });
}

function noVoicesMessage() {
  if (bridge?.platform === 'linux') {
    return 'No system voices found. On Linux, install speech-dispatcher and a voice (e.g. "sudo apt install speech-dispatcher espeak-ng"), then restart.';
  }
  return 'No system voices found. Add a voice in your operating system’s speech settings, then restart.';
}

// -- input -------------------------------------------------------------------

ui.open.addEventListener('click', () => bridge?.openDialog());
ui.openEmpty.addEventListener('click', () => bridge?.openDialog());
ui.play.addEventListener('click', () => reader.toggle());
ui.next.addEventListener('click', () => reader.next());
ui.previous.addEventListener('click', () => reader.previous());
ui.voice.addEventListener('change', (event) => selectVoice(Number(event.target.value)));
ui.rate.addEventListener('input', (event) => previewRate(Number(event.target.value)));
ui.rate.addEventListener('change', (event) => setRate(Number(event.target.value)));
ui.zoomIn.addEventListener('click', () => stepZoom(1));
ui.zoomOut.addEventListener('click', () => stepZoom(-1));
ui.zoomFit.addEventListener('click', () => applyZoom(state.zoomMode === 'width' ? 'page' : 'width'));

const COMMANDS = {
  toggle: () => reader.toggle(),
  next: () => reader.next(),
  previous: () => reader.previous(),
  stop: () => reader.stop(),
  faster: () => setRate(Number(ui.rate.value) + 0.1),
  slower: () => setRate(Number(ui.rate.value) - 0.1),
  zoomIn: () => stepZoom(1),
  zoomOut: () => stepZoom(-1),
  fitWidth: () => applyZoom('width'),
  fitPage: () => applyZoom('page'),
};

bridge?.onCommand((command) => COMMANDS[command]?.());
bridge?.onDocument(({ data, name }) => openArrayBuffer(data, name));

document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const shortcuts = {
    ' ': 'toggle',
    ArrowRight: 'next',
    ArrowLeft: 'previous',
    Escape: 'stop',
  };
  const command = shortcuts[event.key];
  if (!command) return;

  event.preventDefault();
  COMMANDS[command]();
});

// Drag and drop. The renderer reads the dropped file itself — it already has
// the bytes, so there is no reason to round-trip through the main process.
let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth++;
  ui.dropOverlay.hidden = false;
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', (event) => {
  event.preventDefault();
  if (--dragDepth <= 0) ui.dropOverlay.hidden = true;
});
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  ui.dropOverlay.hidden = true;

  const file = [...(event.dataTransfer?.files ?? [])].find((candidate) =>
    candidate.name.toLowerCase().endsWith('.pdf')
  );
  if (!file) {
    setStatus('That file is not a PDF.', 'warning');
    return;
  }

  // Going through the main process keeps dropped files in the recent list.
  // Where that path is not available — no bridge, or a file with no real path
  // behind it — read the bytes here instead.
  const filePath = bridge?.pathForFile?.(file) ?? null;
  if (filePath) await bridge.openPath(filePath);
  else await openArrayBuffer(await file.arrayBuffer(), file.name);
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (typeof state.zoomMode === 'number') return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => applyZoom(state.zoomMode), 120);
});

// -- start -------------------------------------------------------------------

async function start() {
  const saved = (await bridge?.getSettings()) ?? {};
  state.settings = { ...state.settings, ...saved };
  state.zoomMode = saved.zoom ?? 'width';

  const rate = clampRate(Number(saved.rate ?? 1));
  previewRate(rate);
  reader.updateSettings({ rate });
  await loadVoices();
  updateControls();

  if (state.voices.length > 0) setStatus('Open a PDF to start reading.');
}

start();
