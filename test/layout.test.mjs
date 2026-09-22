/**
 * Segmentation against a realistic page layout: a title and headings with no
 * terminating punctuation, a bulleted list, a hyphenated line break, and
 * abbreviations that must not be mistaken for sentence ends.
 *
 * These are the cases where punctuation alone gives the wrong answer, so they
 * are pinned down as exact expected output rather than loose assertions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { buildPageModel, segmentUnits, rectsForRange } from '../src/core/text-model.js';

const fixture = new URL('./fixtures/complex.pdf', import.meta.url);

async function loadFirstPage() {
  const data = new Uint8Array(readFileSync(fixture));
  const loadingTask = getDocument({ data, isEvalSupported: false });
  const doc = await loadingTask.promise;
  const page = await doc.getPage(1);
  const model = buildPageModel(
    await page.getTextContent(),
    page.getViewport({ scale: 1 }).transform,
    0
  );
  await loadingTask.destroy();
  return model;
}

const EXPECTED = [
  'On the Segmentation of Spoken Documents',
  'A. Researcher and B. Collaborator',
  'Abstract',
  'Reading a document aloud requires deciding where one utterance ends and the next begins.',
  'Prior work by Knuth et al. treats the problem as a purely typographic one.',
  'We show that layout carries information that punctuation alone does not, particularly around unpunctuated headings.',
  'See Fig. 2 for an overview of the pipeline.',
  '1 Introduction',
  'The contributions of this paper are as follows:',
  '• A line-level model of paragraph structure.',
  '• A mapping from characters back to page geometry.',
  '• An evaluation on 400 documents, described in Sec. 4.',
  'The remainder is organised as follows.',
  'Section 2 reviews prior work.',
  'Section 3 gives the method, and Sec. 4 the evaluation.',
];

test('a realistic page segments exactly as a reader would say it', async () => {
  const model = await loadFirstPage();
  assert.deepEqual(segmentUnits(model).map((u) => u.text), EXPECTED);
});

test('a heading in a larger face is its own utterance', async () => {
  const model = await loadFirstPage();
  const units = segmentUnits(model).map((u) => u.text);
  // The title must not run into the author line beneath it, and neither must
  // run into "Abstract" — none of the three ends with punctuation.
  assert.ok(units.includes('On the Segmentation of Spoken Documents'));
  assert.ok(units.includes('Abstract'));
  assert.ok(!units.some((u) => u.includes('Documents A.')));
  assert.ok(!units.some((u) => u.includes('Collaborator Abstract')));
});

test('a word hyphenated across a line break is rejoined', async () => {
  const model = await loadFirstPage();
  assert.match(model.text, /particularly around unpunctuated headings/);
  assert.doesNotMatch(model.text, /unpunctu-/);
  assert.doesNotMatch(model.text, /unpunctu ated/);
});

test('bullets start new utterances and keep their marker', async () => {
  const model = await loadFirstPage();
  const bullets = segmentUnits(model).filter((u) => u.text.startsWith('•'));
  assert.equal(bullets.length, 3);
  // The sentence before the list must not absorb the first bullet.
  const lead = segmentUnits(model).find((u) => u.text.endsWith('as follows:'));
  assert.ok(lead && !lead.text.includes('•'));
});

test('abbreviations do not end an utterance', async () => {
  const model = await loadFirstPage();
  const units = segmentUnits(model).map((u) => u.text);
  assert.ok(units.some((u) => u.includes('Knuth et al. treats')));
  assert.ok(units.some((u) => u.startsWith('See Fig. 2 for')));
  assert.ok(units.some((u) => u.endsWith('described in Sec. 4.')));
  // Initials in a name are not sentence ends either.
  assert.ok(units.includes('A. Researcher and B. Collaborator'));
  // ...but a real sentence end still is one.
  assert.ok(units.includes('The remainder is organised as follows.'));
});

test('every unit maps back to rectangles on the page', async () => {
  const model = await loadFirstPage();
  for (const unit of segmentUnits(model)) {
    const rects = rectsForRange(model, unit.start, unit.end);
    assert.ok(rects.length > 0, `no rects for ${JSON.stringify(unit.text)}`);
    for (const rect of rects) {
      assert.ok(rect.width > 0 && rect.height > 0, `degenerate rect for ${unit.text}`);
      assert.ok(rect.x >= 0 && rect.x + rect.width <= 612 + 1, `off-page: ${JSON.stringify(rect)}`);
      assert.ok(rect.y >= 0 && rect.y + rect.height <= 792 + 1, `off-page: ${JSON.stringify(rect)}`);
    }
  }
});

test('units appear in reading order down the page', async () => {
  const model = await loadFirstPage();
  const tops = segmentUnits(model).map((unit) => rectsForRange(model, unit.start, unit.end)[0].y);
  for (let i = 1; i < tops.length; i++) {
    assert.ok(tops[i] >= tops[i - 1] - 0.5, `unit ${i} moved up the page`);
  }
});

test('the title renders taller than the body text', async () => {
  const model = await loadFirstPage();
  const units = segmentUnits(model);
  const title = units.find((u) => u.text.startsWith('On the Segmentation'));
  const body = units.find((u) => u.text.startsWith('Reading a document'));
  const height = (unit) => rectsForRange(model, unit.start, unit.end)[0].height;
  assert.ok(height(title) > height(body) * 1.5, `${height(title)} vs ${height(body)}`);
});
