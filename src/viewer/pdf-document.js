/**
 * Loads a PDF and prepares everything the reader needs from it: per-page text
 * models (text plus the character-to-rectangle mapping) and one flat, ordered
 * list of speech units across the whole document.
 *
 * Text extraction happens up front for every page. It is far cheaper than
 * rasterising — a few hundred pages take well under a second — and doing it
 * eagerly means playback never stalls at a page boundary waiting for text,
 * while rendering stays lazy.
 */

import { buildPageModel, segmentUnits, rectsForRange } from '../core/text-model.js';

export class ReadableDocument {
  constructor(pdf, loadingTask, pageModels, units) {
    this.pdf = pdf;
    this.loadingTask = loadingTask;
    this.pageModels = pageModels;
    this.units = units;

    this.unitsByPage = new Map();
    units.forEach((unit, index) => {
      if (!this.unitsByPage.has(unit.pageIndex)) this.unitsByPage.set(unit.pageIndex, []);
      this.unitsByPage.get(unit.pageIndex).push({ ...unit, index });
    });
  }

  get pageCount() {
    return this.pdf.numPages;
  }

  /** Rects for a whole unit, in unscaled page space. */
  rectsForUnit(unit) {
    const model = this.pageModels[unit.pageIndex];
    return model ? rectsForRange(model, unit.start, unit.end) : [];
  }

  /** Rects for a character range inside a unit, used for the spoken word. */
  rectsForRange(pageIndex, start, end) {
    const model = this.pageModels[pageIndex];
    return model ? rectsForRange(model, start, end) : [];
  }

  pageText(pageIndex) {
    return this.pageModels[pageIndex]?.text ?? '';
  }

  /** Releases the worker and every page it holds. */
  destroy() {
    return this.loadingTask.destroy();
  }
}

/**
 * @param {*} pdfjs - the pdf.js module namespace
 * @param {ArrayBuffer|Uint8Array} data
 * @param {(progress: {loaded: number, total: number, stage: string}) => void} [onProgress]
 */
export async function loadDocument(pdfjs, data, onProgress, options = {}) {
  const loadingTask = pdfjs.getDocument({
    data,
    // Nothing in a user's PDF should be able to run as script.
    isEvalSupported: false,
    // Needed so PDFs that rely on the base-14 fonts or on CJK encodings
    // measure and render correctly rather than falling back to defaults.
    standardFontDataUrl: options.standardFontDataUrl,
    cMapUrl: options.cMapUrl,
    cMapPacked: true,
    // JBIG2 and JPEG 2000 images — the norm in scanned documents — are decoded
    // in WebAssembly, and colour-managed PDFs need the bundled ICC profiles.
    wasmUrl: options.wasmUrl,
    iccUrl: options.iccUrl,
  });

  loadingTask.onProgress = ({ loaded, total }) =>
    onProgress?.({ stage: 'download', loaded, total });

  const pdf = await loadingTask.promise;

  const pageModels = [];
  const units = [];

  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const model = buildPageModel(textContent, viewport.transform, i);

    model.width = viewport.width;
    model.height = viewport.height;
    model.rotation = viewport.rotation;

    pageModels.push(model);
    units.push(...segmentUnits(model));

    onProgress?.({ stage: 'text', loaded: i + 1, total: pdf.numPages });
    page.cleanup();
  }

  return new ReadableDocument(pdf, loadingTask, pageModels, units);
}
