/**
 * Geometry helpers for turning PDF text-item transforms into rectangles that
 * can be painted over a rendered page.
 *
 * Everything here is deliberately dependency-free (no pdf.js, no DOM) so it can
 * run under `node --test` as well as in the renderer.
 *
 * Coordinate convention: all rects are in *unscaled device space*, i.e. the
 * space of `page.getViewport({ scale: 1 })` — y grows downwards, the origin is
 * the top-left of the page. Multiply by the current zoom to get CSS pixels.
 */

/** Multiply two 2D affine matrices in pdf.js's [a, b, c, d, e, f] order. */
export function transform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const DEFAULT_ASCENT = 0.75;
const DEFAULT_DESCENT = -0.22;

/**
 * Derive the drawable box of a whole text item.
 *
 * `item` is a pdf.js text-content item; `viewportTransform` is
 * `viewport.transform` for the scale-1 viewport; `style` is the matching entry
 * from `textContent.styles` (may be undefined).
 */
export function itemBox(item, viewportTransform, style) {
  const m = transform(viewportTransform, item.transform);
  const angle = Math.atan2(m[1], m[0]);
  const fontHeight = Math.hypot(m[2], m[3]) || item.height || 1;
  const ascent = style?.ascent ?? DEFAULT_ASCENT;
  const descent = style?.descent ?? DEFAULT_DESCENT;

  return {
    // Baseline origin.
    x: m[4],
    // Cached so repeated word highlights in one item do not re-measure it.
    fractions: advanceFractions(item.str),
    y: m[5],
    angle,
    // `item.width` is already in unscaled user-space units, which is exactly
    // the space the scale-1 viewport maps to.
    width: item.width,
    fontHeight,
    top: ascent * fontHeight,
    bottom: -descent * fontHeight,
  };
}

// Relative glyph advances, in Helvetica's units-per-1000. pdf.js reports the
// width of a whole text item but not of individual glyphs, so a sub-range has
// to be estimated. Assuming every character is equally wide puts a word
// highlight visibly off-centre in proportional text; these advances are close
// enough to most body fonts to land within a glyph or two, and they are
// self-normalising — the weights are scaled so the item's total always matches
// the width pdf.js actually reported.
const ADVANCES = new Map(
  Object.entries({
    ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
    '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
    ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
    A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
    K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
    U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
    '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
    a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
    k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
    u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
    '{': 334, '|': 260, '}': 334, '~': 584,
  })
);
const DIGIT_ADVANCE = 556;
const DEFAULT_ADVANCE = 556;

function advanceOf(char) {
  if (char >= '0' && char <= '9') return DIGIT_ADVANCE;
  return ADVANCES.get(char) ?? DEFAULT_ADVANCE;
}

/**
 * Cumulative glyph advances for a string, as fractions of its total width.
 *
 * Returns an array of length `text.length + 1` running from 0 to 1, so
 * `fractions[i]` is how far into the run the i-th character starts.
 */
export function advanceFractions(text) {
  const fractions = new Array(text.length + 1);
  fractions[0] = 0;
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    total += advanceOf(text[i]);
    fractions[i + 1] = total;
  }
  if (total === 0) {
    // An empty or zero-width run: fall back to an even split.
    for (let i = 0; i <= text.length; i++) fractions[i] = i / Math.max(text.length, 1);
    return fractions;
  }
  for (let i = 0; i <= text.length; i++) fractions[i] /= total;
  return fractions;
}

/**
 * Slice a sub-range of a text item's glyphs into a rect.
 *
 * `text` is the item's full string; `from` and `to` are character offsets into
 * it. Rotated text is handled by projecting along the baseline and taking the
 * axis-aligned bounding box of the result.
 */
export function sliceRect(box, text, from, to) {
  const length = text.length;
  if (length === 0) return null;

  const fractions = box.fractions ?? advanceFractions(text);
  const startFrac = fractions[clamp(from, 0, length)];
  const endFrac = fractions[clamp(to, 0, length)];
  if (endFrac <= startFrac) return null;

  const advance = box.width;
  const dx = Math.cos(box.angle);
  const dy = Math.sin(box.angle);

  // Baseline points at the start and end of the slice.
  const x0 = box.x + dx * advance * startFrac;
  const y0 = box.y + dy * advance * startFrac;
  const x1 = box.x + dx * advance * endFrac;
  const y1 = box.y + dy * advance * endFrac;

  // Perpendicular offsets to the ascender and descender lines.
  const px = -dy;
  const py = dx;
  const corners = [
    [x0 - px * box.top, y0 - py * box.top],
    [x1 - px * box.top, y1 - py * box.top],
    [x0 + px * box.bottom, y0 + py * box.bottom],
    [x1 + px * box.bottom, y1 + py * box.bottom],
  ];

  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/**
 * Collapse rects that sit on the same text line into one rect per line.
 *
 * A sentence usually spans several items and several lines; painting one box
 * per line reads as a highlighter stroke, while painting one box per item shows
 * seams wherever pdf.js happened to split the run.
 */
export function mergeRectsByLine(rects, { tolerance = 0.5 } = {}) {
  if (rects.length === 0) return [];

  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];

  for (const rect of sorted) {
    const line = lines.find((candidate) => verticallyOverlaps(candidate, rect, tolerance));
    if (line) {
      const right = Math.max(line.x + line.width, rect.x + rect.width);
      const bottom = Math.max(line.y + line.height, rect.y + rect.height);
      line.x = Math.min(line.x, rect.x);
      line.y = Math.min(line.y, rect.y);
      line.width = right - line.x;
      line.height = bottom - line.y;
    } else {
      lines.push({ ...rect });
    }
  }

  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

function verticallyOverlaps(a, b, tolerance) {
  const aMid = a.y + a.height / 2;
  const bMid = b.y + b.height / 2;
  const slack = Math.min(a.height, b.height) / 2 + tolerance;
  return Math.abs(aMid - bMid) <= slack;
}

/** Union of a list of rects, or null when the list is empty. */
export function boundingRect(rects) {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** True when (px, py) falls inside any of the rects, with optional padding. */
export function hitTest(rects, px, py, padding = 2) {
  return rects.some(
    (r) =>
      px >= r.x - padding &&
      px <= r.x + r.width + padding &&
      py >= r.y - padding &&
      py <= r.y + r.height + padding
  );
}

function clamp(value, min, max) {
  return Math.min(Math.max(Math.round(value), min), max);
}
