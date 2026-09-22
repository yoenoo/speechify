/**
 * Serves web/dist/ over plain HTTP for local development.
 *
 * There is no framework here on purpose: the app is static files (ES modules,
 * CSS, the pdf.js assets), so anything that serves a directory over HTTP with
 * correct content types works — this script, `npx serve`, or the static host
 * you deploy to.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'web', 'dist');
const PORT = Number(process.env.PORT) || 5173;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/octet-stream',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const resolved = path.resolve(DIST, relative);

  // Refuse anything that escapes web/dist/ — a path like /../package.json
  // should 404, not read the rest of the repo.
  if (!resolved.startsWith(DIST)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(resolved);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
    });
    response.end(body);
  } catch (error) {
    if (error.code === 'ENOENT') response.writeHead(404).end('Not found');
    else {
      console.error(error);
      response.writeHead(500).end('Server error');
    }
  }
});

server.listen(PORT, () => {
  console.log(`Speechify is running at http://localhost:${PORT}`);
});
