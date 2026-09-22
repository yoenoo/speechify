/**
 * Assembles the browser build into web/dist/.
 *
 * There is no bundler: the app is ES modules all the way down, so the build is
 * a copy that preserves the relative import graph. `src/core`, `src/speech` and
 * `src/viewer` are copied verbatim — the web build runs the same code as the
 * desktop app, and anything that drifts would show up as a broken import
 * rather than as two subtly different implementations.
 */

import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'web', 'dist');
const PDFJS = path.join(ROOT, 'node_modules', 'pdfjs-dist');

// Published path <- source path. Published paths are what the HTML and the
// module imports reference.
const COPIES = [
  ['index.html', 'web/index.html'],
  ['mobile.css', 'web/mobile.css'],
  ['app.js', 'web/app.js'],
  ['core', 'src/core'],
  ['speech', 'src/speech'],
  ['viewer', 'src/viewer'],
  ['vendor/pdf.min.mjs', 'node_modules/pdfjs-dist/build/pdf.min.mjs'],
  ['vendor/pdf.worker.min.mjs', 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'],
  ['vendor/standard_fonts', 'node_modules/pdfjs-dist/standard_fonts'],
  // CJK PDFs need the character maps; scanned PDFs need the JBIG2/JPEG2000
  // wasm decoders; colour-managed PDFs need the bundled ICC profiles.
  ['vendor/cmaps', 'node_modules/pdfjs-dist/cmaps'],
  ['vendor/wasm', 'node_modules/pdfjs-dist/wasm'],
  ['vendor/iccs', 'node_modules/pdfjs-dist/iccs'],
];

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  for (const [to, from] of COPIES) {
    const destination = path.join(OUT, to);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(ROOT, from), destination, { recursive: true });
  }

  const files = await walk(OUT);
  const bytes = (await Promise.all(files.map(async (f) => (await stat(f)).size))).reduce(
    (a, b) => a + b,
    0
  );
  console.log(`web/dist: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  for (const file of files.filter((f) => f.endsWith('.js') || f.endsWith('.html'))) {
    console.log('  ', path.relative(OUT, file));
  }
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

main();
