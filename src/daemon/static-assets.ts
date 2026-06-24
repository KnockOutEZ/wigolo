import { createReadStream, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * The daemon's static-serve seam for the Studio web app shell. It is deliberately NARROW so it can sit in
 * the OPEN (pre-auth) section of `handleRequest` — like `/health` — without ever shadowing the auth-gated
 * API surface (`/mcp`, `/sse`, `/messages`):
 *
 *   - It OWNS only `GET /` (→ index.html) and `GET /<name>.<ext>` for a fixed asset-extension allowlist.
 *     Any other path (`/mcp`, `/health`, `/sse`, no-extension paths, disallowed extensions) is NOT owned —
 *     `serveStaticAsset` returns false and the caller falls through to the auth gate + router. This is what
 *     keeps the static route from opening the API: it can only ever answer for the allowlisted shell assets.
 *   - The asset name segment forbids `/` and `..` by construction (the regex), and the resolved path is then
 *     re-checked to be contained within the served root — so a 0600 secret outside the root (the session
 *     handle `current.json` in the data dir) can never be reached, and a `.json` in the root is not served
 *     either (json is not an asset extension).
 *
 * Returns true iff it handled the request (wrote a response); false to fall through.
 */

// Asset extensions the shell legitimately ships. NOTE: `.json` is intentionally ABSENT — the session handle
// (`current.json`) is a 0600 secret and must never be serveable, even if one ever landed inside the root.
const ASSET_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:js|mjs|css|html|map|svg|ico|png|woff2?)$/;

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  png: 'image/png',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

function contentTypeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Map an owned pathname to its file name within the root, or null when the path is not an owned shell asset. */
function ownedAssetName(pathname: string): string | null {
  if (pathname === '/') return 'index.html';
  const name = pathname.slice(1); // strip leading '/'
  return ASSET_RE.test(name) ? name : null;
}

export function serveStaticAsset(webappRoot: string, pathname: string, res: ServerResponse): boolean {
  const name = ownedAssetName(pathname);
  if (name === null) return false; // not a shell asset → caller falls through to auth + router

  const rootResolved = resolve(webappRoot);
  const fileResolved = resolve(join(rootResolved, name));
  // Containment belt (the regex is the suspenders): refuse anything that escapes the served root.
  if (fileResolved !== rootResolved && !fileResolved.startsWith(rootResolved + sep)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return true;
  }

  try {
    const st = statSync(fileResolved);
    if (!st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': contentTypeFor(name), 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    createReadStream(fileResolved).pipe(res);
    return true;
  } catch {
    // Missing/unreadable owned asset → a real 404 (still "handled" — never falls through to the API).
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return true;
  }
}
