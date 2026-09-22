/**
 * Browser entry point.
 *
 * Imports the same `core/`, `speech/` and `viewer/` modules the desktop app
 * uses, unmodified — the only differences are where a document comes from (a
 * file input instead of the main process), where preferences live
 * (localStorage instead of a JSON file on disk) and a touch-shaped shell.
 */

import * as pdfjs from './vendor/pdf.min.mjs';
import { loadDocument } from './viewer/pdf-document.js';
import { PageView } from './viewer/page-view.js';
import { Reader } from './speech/reader.js';
import { WebSpeechEngine } from './speech/web-speech-engine.js';
import { wordRangeAt } from './core/text-model.js';
import { hitTest } from './core/geometry.js';
import { PDF_WORKER_BASE64 } from './worker-data.js';

// This build (published as an Artifact) can't serve pdf.worker.min.mjs as a
// plain file — the minified bundle embeds raw binary payload inside its .mjs
// text, which the artifact host's file check rejects as non-text. It ships
// instead as a base64 string (worker-data.js) and is turned back into a real
// script here, at the one point that actually needs the bytes.
function base64ToBlobUrl(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type }));
}

pdfjs.GlobalWorkerOptions.workerSrc = base64ToBlobUrl(PDF_WORKER_BASE64, 'text/javascript');
const STANDARD_FONT_DATA_URL = new URL('./vendor/standard_fonts/', import.meta.url).href;
// Not published in this build (see README): CJK character maps (.bcmap) and
// the base-14 Type1 substitutes (.pfb) and ICC profiles (.icc) aren't text,
// and the artifact host only serves a fixed list of text/binary types that
// excludes them. Ordinary PDFs with embedded or common Latin fonts are
// unaffected; see the full website build for full-fidelity support.

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const MIN_RATE = 0.5;
const MAX_RATE = 3;
const STORAGE_KEY = 'speechify.settings';

const el = (id) => document.getElementById(id);
const ui = Object.fromEntries(
  [
    'viewer', 'empty-state', 'file', 'file2', 'sample', 'doc-title', 'settings', 'settings-toggle',
    'play', 'play-icon', 'play-label', 'next', 'previous', 'voice', 'rate', 'rate-value',
    'zoom-in', 'zoom-out', 'zoom-fit', 'status', 'support',
  ].map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), el(id)])
);

const engine = new WebSpeechEngine();
const reader = new Reader(engine);

const state = {
  doc: null,
  voices: [],
  zoomMode: 'width',
  sentenceRects: [],
  settings: { rate: 1, voiceURI: null, zoom: 'width' },
};

const view = new PageView(ui.viewer, { onPageClick: startReadingAt, onVisiblePageChange: noop });

function noop() {}

function setStatus(message, kind = 'info') {
  ui.status.textContent = message;
  ui.status.classList.toggle('is-error', kind === 'error');
  ui.status.classList.toggle('is-warning', kind === 'warning');
}

// -- preferences -------------------------------------------------------------

/**
 * localStorage is unavailable in some private-browsing modes and throws rather
 * than returning null, so neither reading nor writing it may be load-bearing.
 */
function loadSettings() {
  try {
    return { ...state.settings, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') };
  } catch {
    return { ...state.settings };
  }
}

function persist(patch) {
  state.settings = { ...state.settings, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    /* preferences just will not survive a reload */
  }
}

// -- loading -----------------------------------------------------------------

async function openFile(file) {
  if (!file) return;
  setStatus(`Opening ${file.name}…`);
  ui.emptyState.hidden = true;

  try {
    state.doc?.destroy();
    state.doc = null;

    const doc = await loadDocument(
      pdfjs,
      new Uint8Array(await file.arrayBuffer()),
      ({ stage, loaded, total }) => {
        if (stage === 'text' && total > 1) setStatus(`Reading text… page ${loaded} of ${total}`);
      },
      {
        standardFontDataUrl: STANDARD_FONT_DATA_URL,
        wasmUrl: new URL('./vendor/wasm/', import.meta.url).href,
      }
    );

    state.doc = doc;
    ui.docTitle.textContent = file.name;
    document.title = `${file.name} — Speechify`;

    view.setDocument(doc, 1);
    view.setScale(resolveScale());
    reader.setUnits(doc.units);

    if (doc.units.length === 0) {
      setStatus('No selectable text in this PDF — a scan needs OCR before it can be read.', 'warning');
    } else {
      setStatus(`${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}, ${doc.units.length} sentences`);
      highlightUnit(0);
    }
    updateControls();
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
  setStatus(`Sentence ${index + 1} of ${state.doc.units.length}`);
}

function highlightWord(unit, charIndex, charLength) {
  const pageText = state.doc.pageText(unit.pageIndex);
  const absolute = unit.start + charIndex;
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

function startReadingAt({ pageIndex, x, y }) {
  if (!state.doc) return;
  let best = null;
  for (const unit of state.doc.unitsByPage.get(pageIndex) ?? []) {
    const rects = state.doc.rectsForUnit(unit);
    // A fingertip is less precise than a cursor, so the hit box is padded more.
    if (hitTest(rects, x, y, 6)) {
      best = unit;
      break;
    }
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
reader.on('error', ({ error }) =>
  setStatus(`Speech error (${error?.error ?? 'unknown'}) — skipping that sentence.`, 'warning')
);

// -- controls ----------------------------------------------------------------

function updateControls() {
  const ready = Boolean(state.doc) && state.doc.units.length > 0;
  ui.play.disabled = !(ready && state.voices.length > 0);
  ui.next.disabled = !ready;
  ui.previous.disabled = !ready;
}

function resolveScale() {
  return typeof state.zoomMode === 'number' ? state.zoomMode : view.fitScale(state.zoomMode);
}

function applyZoom(mode) {
  state.zoomMode = mode;
  view.setScale(resolveScale());
  if (state.doc) highlightUnit(reader.index, { reveal: false });
  persist({ zoom: mode });
}

function stepZoom(direction) {
  const current = view.scale;
  const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  const next = steps.find((s) => (direction > 0 ? s > current + 0.01 : s < current - 0.01));
  applyZoom(next ?? current);
}

const clampRate = (rate) => Math.min(Math.max(rate, MIN_RATE), MAX_RATE);

function previewRate(rate) {
  const clamped = clampRate(rate);
  ui.rate.value = String(clamped);
  ui.rateValue.textContent = `${clamped.toFixed(2).replace(/0$/, '')}×`;
  return clamped;
}

function setRate(rate) {
  const clamped = previewRate(rate);
  reader.updateSettings({ rate: clamped });
  persist({ rate: clamped });
}

// -- voices ------------------------------------------------------------------

async function loadVoices() {
  if (!WebSpeechEngine.isAvailable()) {
    setStatus('This browser has no speech synthesiser.', 'error');
    return;
  }

  state.voices = await engine.listVoices({ timeoutMs: 3000 });
  ui.voice.replaceChildren();

  if (state.voices.length === 0) {
    ui.voice.disabled = true;
    setStatus('No voices available in this browser.', 'error');
    return;
  }

  const byLanguage = new Map();
  state.voices.forEach((voice, index) => {
    const key = voice.lang || 'other';
    if (!byLanguage.has(key)) byLanguage.set(key, []);
    byLanguage.get(key).push({ voice, index });
  });

  const languages = [...byLanguage.keys()].sort(
    (a, b) => score(b) - score(a) || a.localeCompare(b)
  );

  for (const language of languages) {
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
  const saved = state.voices.findIndex((v) => v.voiceURI === state.settings.voiceURI);
  const fallback = state.voices.findIndex((v) => v.default);
  selectVoice(saved !== -1 ? saved : Math.max(fallback, 0));
}

function score(language) {
  const norm = (value) => value.replace('_', '-').toLowerCase();
  const a = norm(language || '');
  const b = norm(navigator.language || '');
  if (!a || !b) return 0;
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

/**
 * Tell the user what to expect here before they wonder why something is
 * missing. Word-level highlighting rides on the engine's `boundary` event,
 * which iOS Safari does not emit.
 */
function describeSupport() {
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  ui.support.textContent = isIOS
    ? 'On iOS, sentence highlighting works but the word marker does not — Safari does not report word boundaries while speaking.'
    : 'Sentence and word highlighting both need the browser to report speech progress; if the word marker never appears, this browser does not report it.';
}

// -- input -------------------------------------------------------------------

for (const input of [ui.file, ui.file2]) {
  input.addEventListener('change', (event) => {
    openFile(event.target.files?.[0]);
    event.target.value = ''; // so picking the same file twice still fires
  });
}

/** Fetch the bundled demo PDF and open it exactly as a picked file would be. */
async function loadSample() {
  try {
    const response = await fetch('./sample.pdf');
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const blob = await response.blob();
    await openFile(new File([blob], 'sample.pdf', { type: 'application/pdf' }));
  } catch (error) {
    console.error(error);
    setStatus('Could not load the sample PDF.', 'error');
  }
}
ui.sample.addEventListener('click', loadSample);

ui.play.addEventListener('click', () => reader.toggle());
ui.next.addEventListener('click', () => reader.next());
ui.previous.addEventListener('click', () => reader.previous());
ui.voice.addEventListener('change', (event) => selectVoice(Number(event.target.value)));
ui.rate.addEventListener('input', (event) => previewRate(Number(event.target.value)));
ui.rate.addEventListener('change', (event) => setRate(Number(event.target.value)));
ui.zoomIn.addEventListener('click', () => stepZoom(1));
ui.zoomOut.addEventListener('click', () => stepZoom(-1));
ui.zoomFit.addEventListener('click', () => applyZoom(state.zoomMode === 'width' ? 'page' : 'width'));
ui.settingsToggle.addEventListener('click', () => {
  ui.settings.hidden = !ui.settings.hidden;
});

document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const commands = {
    ' ': () => reader.toggle(),
    ArrowRight: () => reader.next(),
    ArrowLeft: () => reader.previous(),
    Escape: () => reader.stop(),
  };
  const command = commands[event.key];
  if (!command) return;
  event.preventDefault();
  command();
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (typeof state.zoomMode === 'number' || !state.doc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => applyZoom(state.zoomMode), 150);
});

// Speech stops when a tab is backgrounded on most mobile browsers; pausing
// deliberately at least leaves the UI telling the truth about it.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && reader.state === 'playing') reader.pause();
});

// -- start -------------------------------------------------------------------

async function start() {
  state.settings = loadSettings();
  state.zoomMode = state.settings.zoom ?? 'width';

  const rate = clampRate(Number(state.settings.rate ?? 1));
  previewRate(rate);
  reader.updateSettings({ rate });

  describeSupport();
  await loadVoices();
  updateControls();

  if (state.voices.length > 0) setStatus('Pick a PDF to start reading.');
}

start();
