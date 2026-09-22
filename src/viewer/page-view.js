/**
 * Renders the document as a continuously scrolling stack of pages and owns the
 * highlight overlay.
 *
 * Pages are laid out at their final size immediately so the scrollbar is
 * honest from the start, but only pages near the viewport are rasterised;
 * the rest stay blank placeholders. That keeps a 500-page PDF responsive.
 */

import { boundingRect } from '../core/geometry.js';

const RENDER_MARGIN_PX = 600; // how far outside the viewport to keep pages rendered
const MAX_CANVAS_PIXELS = 16_777_216; // guards against absurd zoom on large pages

export class PageView {
  #container;
  #doc = null;
  #pages = [];
  #scale = 1;
  #observer = null;
  #onPageClick;
  #onVisiblePageChange;
  #visiblePage = 0;
  #pixelRatio = globalThis.devicePixelRatio || 1;

  constructor(container, { onPageClick, onVisiblePageChange } = {}) {
    this.#container = container;
    this.#onPageClick = onPageClick;
    this.#onVisiblePageChange = onVisiblePageChange;
    this.#container.addEventListener('scroll', () => this.#updateVisiblePage(), { passive: true });
  }

  get scale() {
    return this.#scale;
  }

  get visiblePage() {
    return this.#visiblePage;
  }

  /** Lay out a freshly loaded document. */
  setDocument(doc, scale = this.#scale) {
    this.clear();
    this.#doc = doc;
    this.#scale = scale;

    for (let i = 0; i < doc.pageCount; i++) {
      const model = doc.pageModels[i];
      const element = document.createElement('div');
      element.className = 'page';
      element.dataset.pageIndex = String(i);

      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';

      const highlights = document.createElement('div');
      highlights.className = 'highlight-layer';

      const label = document.createElement('div');
      label.className = 'page-label';
      label.textContent = String(i + 1);

      element.append(canvas, highlights, label);
      element.addEventListener('click', (event) => this.#handleClick(i, element, event));
      this.#container.append(element);

      this.#pages.push({
        index: i,
        element,
        canvas,
        highlights,
        width: model.width,
        height: model.height,
        renderTask: null,
        rendered: false,
      });
    }

    this.#applyLayout();
    this.#observePages();
  }

  clear() {
    this.#observer?.disconnect();
    this.#observer = null;
    for (const page of this.#pages) page.renderTask?.cancel();
    this.#pages = [];
    this.#container.replaceChildren();
    this.#doc = null;
  }

  /** Resize every page and re-rasterise the ones on screen. */
  setScale(scale) {
    if (!this.#doc) {
      this.#scale = scale;
      return;
    }

    const anchor = this.#scrollAnchor();
    this.#scale = scale;

    for (const page of this.#pages) {
      page.rendered = false;
      page.renderTask?.cancel();
      page.renderTask = null;
    }

    this.#applyLayout();
    this.#restoreScrollAnchor(anchor);
    this.#renderVisible();
  }

  /** Scale so a page's width fills the viewport, or so a whole page fits. */
  fitScale(mode = 'width') {
    if (!this.#doc || this.#pages.length === 0) return this.#scale;
    const page = this.#pages[Math.min(this.#visiblePage, this.#pages.length - 1)];
    const styles = getComputedStyle(this.#container);
    const padding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const available = this.#container.clientWidth - padding - 2;

    if (mode === 'width') return available / page.width;
    const availableHeight = this.#container.clientHeight - 32;
    return Math.min(available / page.width, availableHeight / page.height);
  }

  #applyLayout() {
    for (const page of this.#pages) {
      const width = Math.floor(page.width * this.#scale);
      const height = Math.floor(page.height * this.#scale);
      page.element.style.width = `${width}px`;
      page.element.style.height = `${height}px`;
      page.canvas.style.width = `${width}px`;
      page.canvas.style.height = `${height}px`;
    }
  }

  #observePages() {
    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = this.#pages[Number(entry.target.dataset.pageIndex)];
          if (!page) continue;
          if (entry.isIntersecting) this.#renderPage(page);
          else this.#releasePage(page);
        }
      },
      { root: this.#container, rootMargin: `${RENDER_MARGIN_PX}px 0px` }
    );

    for (const page of this.#pages) this.#observer.observe(page.element);
  }

  #renderVisible() {
    for (const page of this.#pages) {
      const box = page.element.getBoundingClientRect();
      const root = this.#container.getBoundingClientRect();
      const near =
        box.bottom > root.top - RENDER_MARGIN_PX && box.top < root.bottom + RENDER_MARGIN_PX;
      if (near) this.#renderPage(page);
    }
  }

  async #renderPage(page) {
    if (!this.#doc || page.rendered || page.renderTask) return;

    const pdfPage = await this.#doc.pdf.getPage(page.index + 1);
    // A zoom change between the await above and here invalidates this render.
    const scale = this.#scale;
    const viewport = pdfPage.getViewport({ scale });

    let ratio = this.#pixelRatio;
    while (viewport.width * ratio * viewport.height * ratio > MAX_CANVAS_PIXELS && ratio > 0.5) {
      ratio /= 2;
    }

    page.canvas.width = Math.floor(viewport.width * ratio);
    page.canvas.height = Math.floor(viewport.height * ratio);

    const task = pdfPage.render({
      canvas: page.canvas,
      viewport,
      // The canvas is oversampled for the display's pixel ratio and scaled back
      // down by CSS, so text stays sharp on a HiDPI screen.
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      background: '#ffffff',
    });
    page.renderTask = task;

    try {
      await task.promise;
      page.rendered = scale === this.#scale;
      page.element.classList.add('is-rendered');
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') throw error;
    } finally {
      page.renderTask = null;
    }
  }

  /** Drop a far-away page's bitmap; the placeholder keeps its size. */
  #releasePage(page) {
    page.renderTask?.cancel();
    page.renderTask = null;
    if (!page.rendered) return;
    page.canvas.width = 0;
    page.canvas.height = 0;
    page.rendered = false;
    page.element.classList.remove('is-rendered');
  }

  // -- highlighting --------------------------------------------------------

  /**
   * Paint the sentence currently being spoken, plus the word inside it.
   * Rects arrive in unscaled page space and are scaled here, so a zoom change
   * needs no recomputation upstream.
   */
  highlight({ pageIndex, sentenceRects = [], wordRects = [] }) {
    this.clearHighlights();
    const page = this.#pages[pageIndex];
    if (!page) return;

    const fragment = document.createDocumentFragment();
    for (const rect of sentenceRects) fragment.append(this.#highlightBox(rect, 'sentence'));
    for (const rect of wordRects) fragment.append(this.#highlightBox(rect, 'word'));
    page.highlights.append(fragment);
  }

  clearHighlights() {
    for (const page of this.#pages) {
      if (page.highlights.childElementCount > 0) page.highlights.replaceChildren();
    }
  }

  #highlightBox(rect, kind) {
    const box = document.createElement('div');
    box.className = `highlight highlight-${kind}`;
    const padding = kind === 'sentence' ? 1.5 : 0.5;
    box.style.left = `${(rect.x - padding) * this.#scale}px`;
    box.style.top = `${(rect.y - padding) * this.#scale}px`;
    box.style.width = `${(rect.width + padding * 2) * this.#scale}px`;
    box.style.height = `${(rect.height + padding * 2) * this.#scale}px`;
    return box;
  }

  // -- scrolling -----------------------------------------------------------

  /**
   * Keep the spoken sentence comfortably in view.
   *
   * Scrolling on every sentence would make the page twitch, so this only moves
   * when the sentence is outside a central band, and then places it there.
   */
  revealRects(pageIndex, rects, { behavior = 'smooth' } = {}) {
    const page = this.#pages[pageIndex];
    const bounds = boundingRect(rects);
    if (!page || !bounds) return;

    const top = page.element.offsetTop + bounds.y * this.#scale;
    const bottom = top + bounds.height * this.#scale;
    const viewTop = this.#container.scrollTop;
    const viewHeight = this.#container.clientHeight;
    const viewBottom = viewTop + viewHeight;

    const comfortTop = viewTop + viewHeight * 0.15;
    const comfortBottom = viewTop + viewHeight * 0.75;
    if (top >= comfortTop && bottom <= comfortBottom) return;

    this.#container.scrollTo({
      top: Math.max(0, top - viewHeight * 0.35),
      behavior,
    });
  }

  #scrollAnchor() {
    const page = this.#pages[this.#visiblePage];
    if (!page) return null;
    const offset = this.#container.scrollTop - page.element.offsetTop;
    return { pageIndex: this.#visiblePage, fraction: offset / (page.height * this.#scale) };
  }

  #restoreScrollAnchor(anchor) {
    if (!anchor) return;
    const page = this.#pages[anchor.pageIndex];
    if (!page) return;
    this.#container.scrollTop = page.element.offsetTop + anchor.fraction * page.height * this.#scale;
  }

  #updateVisiblePage() {
    const middle = this.#container.scrollTop + this.#container.clientHeight / 3;
    let found = 0;
    for (const page of this.#pages) {
      if (page.element.offsetTop <= middle) found = page.index;
      else break;
    }
    if (found !== this.#visiblePage) {
      this.#visiblePage = found;
      this.#onVisiblePageChange?.(found);
    }
  }

  #handleClick(pageIndex, element, event) {
    if (!this.#onPageClick) return;
    const box = element.getBoundingClientRect();
    this.#onPageClick({
      pageIndex,
      x: (event.clientX - box.left) / this.#scale,
      y: (event.clientY - box.top) / this.#scale,
    });
  }
}
