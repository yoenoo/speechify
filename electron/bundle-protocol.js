/**
 * Serves the renderer over a custom `app://` scheme instead of `file://`.
 *
 * Two reasons it is worth the small amount of ceremony: `file://` pages are
 * treated as opaque origins, so ES module imports and workers are blocked
 * there, and a real origin lets the renderer run under a strict CSP with
 * `'self'` meaning something.
 */

import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const SCHEME = 'app';
export const ORIGIN = `${SCHEME}://bundle`;

// The only directories reachable over app://. Everything else is refused, so a
// bug in the viewer cannot be turned into a read of the rest of the disk.
const SERVE_ROOTS = ['src', 'node_modules/pdfjs-dist'];

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.icc': 'application/octet-stream',
};

/** Must run before `app.whenReady()`. */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** Must run after `app.whenReady()`. */
export function serveBundle(root) {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'src/index.html';
    const resolved = path.resolve(root, relative);

    const allowed = SERVE_ROOTS.some((serveRoot) => {
      const base = path.resolve(root, serveRoot);
      return resolved === base || resolved.startsWith(base + path.sep);
    });
    if (!allowed) return new Response('Not found', { status: 404 });

    const response = await net.fetch(pathToFileURL(resolved).toString());
    const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()];
    if (!type) return response;

    // net.fetch over file:// guesses conservatively; a module script served as
    // anything but a JavaScript type is rejected outright by the renderer.
    const headers = new Headers(response.headers);
    headers.set('Content-Type', type);
    return new Response(response.body, { status: response.status, headers });
  });
}
