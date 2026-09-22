/**
 * Turns a pdf.js page into (a) one continuous string that is pleasant to read
 * aloud and (b) a mapping from any character range in that string back to
 * rectangles on the page.
 *
 * That mapping is the whole trick behind "highlight what is being spoken":
 * the speech engine reports progress as character offsets, and we need to turn
 * those offsets back into boxes.
 *
 * Pure module — no pdf.js import, no DOM. `buildPageModel` takes the already
 * fetched `textContent` and the scale-1 viewport transform.
 */

import { itemBox, sliceRect, mergeRectsByLine } from './geometry.js';

/**
 * @param {{items: Array, styles: Object}} textContent - from `page.getTextContent()`
 * @param {number[]} viewportTransform - `page.getViewport({scale: 1}).transform`
 * @param {number} pageIndex - zero-based
 */
export function buildPageModel(textContent, viewportTransform, pageIndex) {
  const items = textContent.items.filter((item) => typeof item.str === 'string');
  const boxes = items.map((item) =>
    itemBox(item, viewportTransform, textContent.styles?.[item.fontName])
  );
  const lines = groupIntoLines(items, boxes);
  const widestLine = Math.max(1, ...lines.map((line) => line.right - line.left));

  const pieces = [];
  let text = '';

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];

    if (l > 0) {
      text = appendSeparator(text, lineSeparator(lines[l - 1], line, widestLine));
    }

    for (let k = 0; k < line.indices.length; k++) {
      const i = line.indices[k];
      const item = items[i];
      if (item.str.length === 0) continue;

      if (k > 0) {
        const prev = line.indices[k - 1];
        text = appendSeparator(text, intraLineSeparator(boxes[prev], boxes[i]));
      }

      // De-hyphenate words broken across lines: "specta-\ntor" reads as
      // "spectator", not "specta tor".
      const isLastOnLine = k === line.indices.length - 1;
      const nextLineStart = lines[l + 1]?.text ?? '';
      const hyphenated =
        isLastOnLine && /[\p{L}]-$/u.test(item.str) && startsLowercase(nextLineStart);
      const consumed = hyphenated ? item.str.length - 1 : item.str.length;

      const start = text.length;
      text += item.str.slice(0, consumed);
      pieces.push({
        start,
        end: text.length,
        itemIndex: i,
        itemCharStart: 0,
        itemCharEnd: consumed,
      });
      if (hyphenated) line.joinsNext = true;
    }
  }

  return { pageIndex, text, pieces, boxes, items, lines };
}

/**
 * Group text items into visual lines.
 *
 * pdf.js emits items in content-stream order and splits them wherever the PDF
 * happened to split them — mid-word for kerning, mid-line for a font change —
 * so line structure has to be recovered from the geometry.
 */
function groupIntoLines(items, boxes) {
  const lines = [];
  let current = null;

  for (let i = 0; i < items.length; i++) {
    const box = boxes[i];
    const sameLine =
      current !== null &&
      !items[current.indices[current.indices.length - 1]].hasEOL &&
      Math.abs(box.y - current.baseline) <= Math.max(current.fontHeight, box.fontHeight) * 0.4;

    if (!sameLine) {
      if (current && current.text.length > 0) lines.push(current);
      current = {
        indices: [],
        baseline: box.y,
        fontHeight: box.fontHeight,
        left: box.x,
        right: box.x + box.width,
        text: '',
      };
    }

    current.indices.push(i);
    current.left = Math.min(current.left, box.x);
    current.right = Math.max(current.right, box.x + box.width);
    current.fontHeight = Math.max(current.fontHeight, box.fontHeight);
    current.text += items[i].str;
  }

  if (current && current.text.length > 0) lines.push(current);
  return lines;
}

/** Space between two items on the same line, if the gap suggests a word break. */
function intraLineSeparator(prevBox, box) {
  const gap = box.x - (prevBox.x + prevBox.width);
  return gap > prevBox.fontHeight * 0.18 ? ' ' : '';
}

const HEADING_LINE_RATIO = 0.75;
const PARAGRAPH_GAP_RATIO = 1.6;
const FONT_CHANGE_RATIO = 0.15;
const BULLET = /^\s*([\u2022\u2023\u25E6\u2043\u2219*\-\u2013\u2014]|\(?\d{1,3}[.)]|[a-z][.)])\s/u;

/**
 * Decide what separates two consecutive lines.
 *
 * `'\n'` marks a hard break — a heading, a list item or a new paragraph — which
 * `segmentUnits` always treats as a unit boundary. `' '` marks a soft wrap
 * inside one paragraph, and `''` rejoins a hyphenated word.
 *
 * Getting this wrong is audible: a missed break runs a heading into the
 * following sentence, and a spurious one chops a sentence in half.
 */
function lineSeparator(prev, line, widestLine) {
  if (prev.joinsNext) return '';

  const gap = Math.abs(line.baseline - prev.baseline);
  if (gap > prev.fontHeight * PARAGRAPH_GAP_RATIO) return '\n';

  const fontDelta = Math.abs(line.fontHeight - prev.fontHeight) / Math.max(prev.fontHeight, 1);
  if (fontDelta > FONT_CHANGE_RATIO) return '\n';

  if (BULLET.test(line.text)) return '\n';

  // A line that stops well short of the widest line on the page has ended
  // something. If it also lacks closing punctuation it is a heading or a table
  // cell rather than a wrapped sentence.
  const endsSentence = /[.!?:;\u2026\u201d\u2019)]\s*$/u.test(prev.text);
  const isShort = prev.right - prev.left < widestLine * HEADING_LINE_RATIO;
  if (isShort && !endsSentence && /^[\p{Lu}\p{N}]/u.test(line.text.trimStart())) return '\n';

  return ' ';
}

function startsLowercase(str) {
  return typeof str === 'string' && /^\p{Ll}/u.test(str);
}

function appendSeparator(text, separator) {
  if (!separator) return text;
  if (text.length === 0) return text;
  if (separator === '\n' && text.endsWith('\n')) return text;
  if (separator === ' ' && /\s$/.test(text)) return text;
  return text + separator;
}

const DEFAULT_MAX_UNIT_CHARS = 280;

/**
 * Split a page's text into the units we speak and highlight.
 *
 * A unit is normally one sentence. Very long sentences are broken at clause
 * boundaries: speech engines handle short utterances more responsively, a
 * stalled utterance costs less to restart, and a highlight spanning half a page
 * stops being useful anyway.
 */
export function segmentUnits(pageModel, { maxChars = DEFAULT_MAX_UNIT_CHARS, locale } = {}) {
  const units = [];

  for (const sentence of splitSentences(pageModel.text, locale)) {
    for (const chunk of splitLongRange(pageModel.text, sentence.start, sentence.end, maxChars)) {
      const trimmed = trimRange(pageModel.text, chunk.start, chunk.end);
      if (!trimmed) continue;
      units.push({
        pageIndex: pageModel.pageIndex,
        start: trimmed.start,
        end: trimmed.end,
        text: pageModel.text.slice(trimmed.start, trimmed.end),
      });
    }
  }

  return units;
}

function splitSentences(text, locale) {
  const sentences =
    typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? [...new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(text)].map((s) => ({
          start: s.index,
          end: s.index + s.segment.length,
        }))
      : splitSentencesFallback(text);

  // Sentence segmentation does not break on layout, so a heading with no full
  // stop would otherwise be spoken as part of the paragraph beneath it.
  // `buildPageModel` marks those places with a newline.
  return mergeAbbreviationSplits(text, sentences).flatMap((sentence) =>
    splitAtHardBreaks(text, sentence)
  );
}

// Titles and short forms that take a full stop without ending a sentence.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'hon', 'st', 'sr', 'jr',
  'fig', 'figs', 'eq', 'ref', 'refs', 'no', 'vol', 'pp', 'ch', 'sec',
  'al', 'cf', 'eg', 'ie', 'viz', 'vs', 'approx', 'est', 'dept', 'univ',
  'inc', 'ltd', 'co', 'corp', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul',
  'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

/**
 * Re-join sentences that ICU split at an abbreviation.
 *
 * "Dr. Lovelace wrote..." segments as two sentences because the rules break on
 * full-stop + space + capital. Left alone it makes the reader pause mid-name
 * and the highlight jump, so the pieces are stitched back together.
 */
function mergeAbbreviationSplits(text, sentences) {
  const merged = [];

  for (const sentence of sentences) {
    const previous = merged[merged.length - 1];
    const previousText = previous ? text.slice(previous.start, previous.end) : '';

    // Never merge across a layout break: that boundary is structural, and an
    // abbreviation that happens to end a heading still ends it. Only the
    // junction matters — a trailing newline inside `sentence` is the break
    // *after* it, which says nothing about whether it joins what came before.
    const brokenAtJunction = /\n\s*$/.test(previousText);

    if (previous && !brokenAtJunction && endsWithAbbreviation(previousText)) {
      previous.end = sentence.end;
      continue;
    }
    merged.push({ ...sentence });
  }

  return merged;
}

function endsWithAbbreviation(chunk) {
  const trimmed = chunk.trimEnd();
  if (!trimmed.endsWith('.')) return false;
  const word = trimmed.slice(0, -1).match(/[\p{L}]+$/u)?.[0];
  if (!word) return false;
  // A lone capital is an initial ("J. Random Hacker").
  if (word.length === 1 && /\p{Lu}/u.test(word)) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

function splitAtHardBreaks(text, { start, end }) {
  const parts = [];
  let cursor = start;
  for (let i = start; i < end; i++) {
    if (text[i] !== '\n') continue;
    if (i + 1 > cursor) parts.push({ start: cursor, end: i + 1 });
    cursor = i + 1;
  }
  if (cursor < end) parts.push({ start: cursor, end });
  return parts;
}

// Used only where Intl.Segmenter is unavailable. Deliberately conservative:
// it requires the terminator to be followed by whitespace so that "Dr. Smith"
// and "3.5" stay in one piece.
function splitSentencesFallback(text) {
  const ranges = [];
  const pattern = /[^.!?…]*[.!?…]+(?=\s|$)|[^.!?…]+$/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges.length > 0 ? ranges : [{ start: 0, end: text.length }];
}

/** Break [start, end) into pieces of at most `maxChars`, preferring clause breaks. */
function splitLongRange(text, start, end, maxChars) {
  if (end - start <= maxChars) return [{ start, end }];

  const pieces = [];
  let cursor = start;

  while (end - cursor > maxChars) {
    const limit = cursor + maxChars;
    const breakAt =
      lastIndexOfAny(text, [',', ';', ':', '—', '–', ')'], cursor + maxChars / 3, limit) ??
      lastIndexOfAny(text, [' ', '\n'], cursor + maxChars / 3, limit) ??
      limit - 1;
    pieces.push({ start: cursor, end: breakAt + 1 });
    cursor = breakAt + 1;
  }

  if (cursor < end) pieces.push({ start: cursor, end });
  return pieces;
}

function lastIndexOfAny(text, chars, from, to) {
  for (let i = Math.floor(to); i >= Math.ceil(from); i--) {
    if (chars.includes(text[i])) return i;
  }
  return null;
}

function trimRange(text, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (s >= e) return null;
  // A range of nothing but punctuation has nothing to say out loud.
  if (!/[\p{L}\p{N}]/u.test(text.slice(s, e))) return null;
  return { start: s, end: e };
}

/**
 * Rectangles covering the character range [start, end) of a page, in unscaled
 * device space, merged to one rect per line.
 */
export function rectsForRange(pageModel, start, end) {
  const rects = [];

  for (const piece of pageModel.pieces) {
    if (piece.end <= start) continue;
    if (piece.start >= end) break;

    const from = Math.max(start, piece.start) - piece.start + piece.itemCharStart;
    const to = Math.min(end, piece.end) - piece.start + piece.itemCharStart;
    const item = pageModel.items[piece.itemIndex];
    const rect = sliceRect(pageModel.boxes[piece.itemIndex], item.str, from, to);
    if (rect && rect.width > 0 && rect.height > 0) rects.push(rect);
  }

  return mergeRectsByLine(rects);
}

/**
 * Character range of the word containing `offset`, clipped to [from, to).
 *
 * Speech engines report a boundary as a start offset; some also give a length,
 * but not all do, so we can always fall back to finding the word ourselves.
 */
export function wordRangeAt(text, offset, from = 0, to = text.length) {
  let start = Math.min(Math.max(offset, from), Math.max(to - 1, from));
  while (start > from && !/\s/.test(text[start - 1])) start--;
  let end = Math.max(start, offset);
  while (end < to && !/\s/.test(text[end])) end++;
  return end > start ? { start, end } : null;
}
