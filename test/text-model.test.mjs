import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { buildPageModel, segmentUnits, rectsForRange, wordRangeAt } from '../src/core/text-model.js';
import { mergeRectsByLine, boundingRect, hitTest } from '../src/core/geometry.js';

const fixture = new URL('./fixtures/sample.pdf', import.meta.url);

async function loadPageModels() {
  const data = new Uint8Array(readFileSync(fixture));
  const loadingTask = getDocument({ data, isEvalSupported: false });
  const doc = await loadingTask.promise;
  const models = [];
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    models.push(buildPageModel(textContent, viewport.transform, i));
  }
  await loadingTask.destroy();
  return models;
}

test('page text joins wrapped lines into readable prose', async () => {
  const [page1] = await loadPageModels();
  assert.match(page1.text, /A spoken document is a sequence of sentences\./);
  // "...should know\nwhich one it is on." must survive the line break as a space.
  assert.match(page1.text, /should know which one it is on\./);
  assert.doesNotMatch(page1.text, /know\s{2,}which/);
});

test('sentences become separate speech units', async () => {
  const [page1] = await loadPageModels();
  const units = segmentUnits(page1);
  const texts = units.map((u) => u.text);

  assert.ok(texts.includes('A spoken document is a sequence of sentences.'), texts.join(' | '));
  assert.ok(texts.some((t) => t.startsWith('Highlighting the current sentence')));
  // "Dr. Lovelace" must not split at the abbreviation.
  assert.ok(texts.some((t) => t.includes('Dr. Ada Lovelace wrote about this')), texts.join(' | '));
});

test('unit offsets address the page text exactly', async () => {
  const models = await loadPageModels();
  for (const model of models) {
    for (const unit of segmentUnits(model)) {
      assert.equal(model.text.slice(unit.start, unit.end), unit.text);
      assert.equal(unit.pageIndex, model.pageIndex);
    }
  }
});

test('a sentence spanning two lines yields one rect per line', async () => {
  const [page1] = await loadPageModels();
  const units = segmentUnits(page1);
  const wrapped = units.find((u) => u.text.startsWith('A spoken document'));
  const short = units.find((u) => u.text.startsWith('It still holds'));

  const wrappedRects = rectsForRange(page1, wrapped.start, wrapped.end);
  const shortRects = rectsForRange(page1, short.start, short.end);

  assert.equal(wrappedRects.length, 1, 'sentence sits on a single line here');
  assert.equal(shortRects.length, 1);
  // Rects must land inside the page box, below the top margin.
  for (const rect of [...wrappedRects, ...shortRects]) {
    assert.ok(rect.x >= 0 && rect.x < 612, `x=${rect.x}`);
    assert.ok(rect.y >= 0 && rect.y < 792, `y=${rect.y}`);
    assert.ok(rect.height > 5 && rect.height < 40, `height=${rect.height}`);
  }
  // The later sentence must sit lower on the page than the earlier one.
  assert.ok(shortRects[0].y > wrappedRects[0].y);
});

test('a sentence wrapping mid-line produces two line rects', async () => {
  const [page1] = await loadPageModels();
  const units = segmentUnits(page1);
  const unit = units.find((u) => u.text.startsWith('The reader should know'));
  const rects = rectsForRange(page1, unit.start, unit.end);
  assert.equal(rects.length, 2, `expected two lines, got ${JSON.stringify(rects)}`);
  assert.ok(rects[1].y > rects[0].y);
});

test('word ranges resolve to a narrower rect than the sentence', async () => {
  const [page1] = await loadPageModels();
  const unit = segmentUnits(page1).find((u) => u.text.startsWith('A spoken document'));
  const word = wordRangeAt(page1.text, unit.start + 2, unit.start, unit.end);

  assert.equal(page1.text.slice(word.start, word.end), 'spoken');
  const wordRects = rectsForRange(page1, word.start, word.end);
  const unitRects = rectsForRange(page1, unit.start, unit.end);
  assert.equal(wordRects.length, 1);
  assert.ok(wordRects[0].width < unitRects[0].width);
  assert.ok(wordRects[0].x >= unitRects[0].x - 0.01);
});

test('wordRangeAt clips to the unit and handles offsets inside a word', () => {
  const text = 'Alpha beta gamma';
  assert.deepEqual(wordRangeAt(text, 8), { start: 6, end: 10 });
  assert.equal(text.slice(6, 10), 'beta');
  assert.deepEqual(wordRangeAt(text, 0, 0, 5), { start: 0, end: 5 });
  assert.equal(wordRangeAt(text, 16, 16, 16), null);
});

test('long sentences split at clause boundaries', () => {
  const clause = 'a'.repeat(120);
  const text = `${clause}, ${clause}, ${clause}.`;
  const model = { pageIndex: 0, text, pieces: [], boxes: [], items: [] };
  const units = segmentUnits(model, { maxChars: 150 });

  assert.ok(units.length >= 3, `expected a split, got ${units.length}`);
  for (const unit of units) assert.ok(unit.text.length <= 150);
  assert.equal(units.map((u) => u.text).join(' '), text);
});

test('mergeRectsByLine groups by baseline, not by order', () => {
  const merged = mergeRectsByLine([
    { x: 40, y: 10, width: 10, height: 12 },
    { x: 10, y: 10.2, width: 20, height: 12 },
    { x: 10, y: 40, width: 30, height: 12 },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { x: 10, y: 10, width: 40, height: 12.2 });
  assert.equal(merged[1].y, 40);
});

test('boundingRect and hitTest agree with merged rects', () => {
  const rects = [
    { x: 10, y: 10, width: 20, height: 10 },
    { x: 10, y: 30, width: 40, height: 10 },
  ];
  assert.deepEqual(boundingRect(rects), { x: 10, y: 10, width: 40, height: 30 });
  assert.equal(boundingRect([]), null);
  assert.equal(hitTest(rects, 15, 35), true);
  assert.equal(hitTest(rects, 45, 15), false);
});

test('word rects follow glyph widths, not character counts', async () => {
  const [page1] = await loadPageModels();
  // "Dr. Ada Lovelace wrote about this in 1843, roughly."
  const unit = segmentUnits(page1).find((u) => u.text.startsWith('Dr. Ada Lovelace'));
  const lineRects = rectsForRange(page1, unit.start, unit.end);

  const find = (word) => {
    const at = page1.text.indexOf(word, unit.start);
    return rectsForRange(page1, at, at + word.length)[0];
  };

  const lovelace = find('Lovelace');
  const wrote = find('wrote');

  // Successive words must not overlap and must stay in reading order.
  assert.ok(lovelace.x + lovelace.width <= wrote.x + 1, 'words must not overlap');
  assert.ok(wrote.x > lovelace.x);
  // Both must sit inside the sentence's own box.
  const line = lineRects[0];
  assert.ok(lovelace.x >= line.x - 0.5 && wrote.x + wrote.width <= line.x + line.width + 0.5);

  // The measured width of "Lovelace" (8 glyphs, wide) must exceed
  // "wrote" (5 glyphs) by roughly the ratio of their advances.
  const ratio = lovelace.width / wrote.width;
  assert.ok(ratio > 1.3 && ratio < 2.2, `ratio=${ratio.toFixed(2)}`);
});

test('advanceFractions is monotonic and normalised', async () => {
  const { advanceFractions } = await import('../src/core/geometry.js');
  const fractions = advanceFractions('Illustrating WWW.');
  assert.equal(fractions[0], 0);
  assert.equal(fractions.at(-1), 1);
  for (let i = 1; i < fractions.length; i++) {
    assert.ok(fractions[i] > fractions[i - 1], `not increasing at ${i}`);
  }
  // A capital W must advance far more than a lowercase l.
  const w = fractions[14] - fractions[13];
  const l = fractions[2] - fractions[1];
  assert.ok(w > l * 3, `W=${w} l=${l}`);
  assert.deepEqual(advanceFractions(''), [0]);
});
