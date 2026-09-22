/**
 * Generates web/sample.pdf: the bundled "Try a sample" document offered by
 * the website (and the hosted demo) so a visitor can try the app without
 * having a PDF of their own on hand.
 *
 * Reuses the same minimal PDF writer the test fixtures are built with, so the
 * app is exercised against exactly the kind of document it's actually built
 * from (Helvetica text, no embedded fonts) rather than a special case.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPdf } from '../test/fixtures/make-pdf.mjs';

const PAGES = [
  [
    { text: 'Try Reading This Aloud', size: 20, leading: 30 },
    { text: 'This short document exists so you can try Speechify without needing a PDF', size: 10, leading: 26 },
    { text: 'of your own. Press play below, and the sentence being read is highlighted', size: 10, leading: 14 },
    { text: 'here on the page, with the exact word inside it marked as it goes.', size: 10, leading: 14 },
    { text: 'Jump to any sentence', size: 13, leading: 28 },
    { text: 'Tap a sentence anywhere on this page and reading starts there immediately,', size: 10, leading: 20 },
    { text: 'whether it is the heading above, the middle of this paragraph, or the very', size: 10, leading: 14 },
    { text: 'last line below. Nothing in between gets replayed.', size: 10, leading: 14 },
    { text: 'Adjust the voice and speed', size: 13, leading: 28 },
    { text: 'Open the settings panel to change the voice or the reading rate. Both', size: 10, leading: 20 },
    { text: 'take effect starting with the next sentence, so a change made', size: 10, leading: 14 },
    { text: 'mid-sentence finishes that one first.', size: 10, leading: 14 },
    { text: 'This document continues onto a second page, so scrolling and multi-page', size: 10, leading: 24 },
    { text: 'playback both have something to show.', size: 10, leading: 14 },
  ],
  [
    { text: 'Page Two', size: 20, leading: 30 },
    { text: 'Reading carries on across the page break without a pause you would', size: 10, leading: 26 },
    { text: 'notice. Whatever page contains the sentence currently being read', size: 10, leading: 14 },
    { text: 'scrolls into view automatically.', size: 10, leading: 14 },
    { text: 'That is the whole tour. Open a PDF of your own from the button above', size: 10, leading: 24 },
    { text: 'whenever you are ready.', size: 10, leading: 14 },
  ],
];

const out = new URL('../web/sample.pdf', import.meta.url);
writeFileSync(out, buildPdf(PAGES));
console.log('wrote', fileURLToPath(out));
