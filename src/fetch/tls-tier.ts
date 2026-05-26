/**
 * Slice D2 — TLS-fingerprint HTTP tier.
 *
 * Wraps the `wreq-js` napi backend in the same surface as the default HTTP
 * tier (HttpClient.fetch shape). The wreq module is lazy-imported on the
 * first call so MCP servers that never need TLS impersonation don't pay the
 * 654ms cold-start cost. The cached module is null when the optional dep is
 * not installed for the host platform; callers must handle the
 * `tls_tier_unavailable` rejection.
 *
 * Anti-bot signals are recognised by status code (403 / 429 / 503) and by
 * three challenge-page body markers (Cloudflare's `cf-browser-verification`
 * and `Just a moment`, plus DataDome sensor scripts). Callers (router) use
 * these helpers to decide whether to escalate.
 */

import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('fetch');

export interface TlsFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface TlsFetchResult {
  url: string;
  finalUrl: string;
  html: string;
  contentType: string;
  statusCode: number;
  headers: Record<string, string>;
  rawBuffer?: Buffer;
}

export class TlsTierUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super('tls_tier_unavailable');
    this.name = 'TlsTierUnavailableError';
  }
}

// Minimum shape we use from `wreq-js` — fetch is the public entry point.
interface WreqHeaders {
  entries?: () => Iterable<[string, string]>;
  forEach?: (cb: (v: string, k: string) => void) => void;
}

interface WreqResponse {
  status: number;
  url?: string;
  headers: WreqHeaders;
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

interface WreqFetchInit {
  headers?: Record<string, string>;
  browser?: string;
  signal?: AbortSignal;
  redirect?: 'follow' | 'manual' | 'error';
}

type WreqFetch = (url: string, init?: WreqFetchInit) => Promise<WreqResponse>;

interface LoadedTlsBackend {
  fetch: WreqFetch;
}

let _backendPromise: Promise<LoadedTlsBackend> | null = null;
let _backendCached: LoadedTlsBackend | null = null;

/** Test-only: reset the lazy-load memo so the next call re-imports. */
export function _resetTlsBackend(): void {
  _backendPromise = null;
  _backendCached = null;
}

/**
 * Override the lazy-loaded backend (test-only). When set, `loadBackend()`
 * resolves to this object without touching `await import('wreq-js')`,
 * letting tests assert the wiring without bundling a 54 MB native dep.
 */
let _testBackendOverride: LoadedTlsBackend | null = null;
export function _setTlsBackendForTests(backend: LoadedTlsBackend | null): void {
  _testBackendOverride = backend;
  _resetTlsBackend();
}

// Module specifier held as a `string` (not a string literal) so the TS
// compiler skips module resolution. `wreq-js` is declared in
// `optionalDependencies` and may be absent when the host platform has no
// prebuilt napi binary OR when the user runs `npm install --omit=optional`.
// Resolving it as a literal would break `tsc --noEmit` on those installs;
// the dynamic import still throws at runtime and we surface that as
// `TlsTierUnavailableError`.
const WREQ_MODULE_ID: string = 'wreq-js';

interface WreqJsModuleShape {
  fetch?: WreqFetch;
  default?: { fetch?: WreqFetch };
}

async function loadBackend(): Promise<LoadedTlsBackend> {
  if (_testBackendOverride) return _testBackendOverride;
  if (_backendCached) return _backendCached;
  if (_backendPromise) return _backendPromise;
  _backendPromise = (async () => {
    try {
      // Dynamic import keeps the napi binary out of the module graph for
      // every command that doesn't actually invoke the TLS tier.
      const mod = (await import(WREQ_MODULE_ID)) as WreqJsModuleShape;
      const fetchFn: WreqFetch | undefined = mod.fetch ?? mod.default?.fetch;
      if (!fetchFn) {
        throw new Error('wreq-js: no fetch export found');
      }
      const backend: LoadedTlsBackend = { fetch: fetchFn };
      _backendCached = backend;
      return backend;
    } catch (err) {
      _backendPromise = null;
      throw new TlsTierUnavailableError(err);
    }
  })();
  return _backendPromise;
}

function headersToRecord(h: WreqHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof h.entries === 'function') {
    for (const [k, v] of h.entries()) {
      out[k.toLowerCase()] = v;
    }
  } else if (typeof h.forEach === 'function') {
    h.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  }
  return out;
}

/**
 * Single-shot TLS-impersonation fetch. Returns the same shape as the default
 * HTTP tier so router.ts can swap tiers without branching elsewhere.
 */
export async function tlsFetch(url: string, options: TlsFetchOptions = {}): Promise<TlsFetchResult> {
  const backend = await loadBackend();
  const config = getConfig();
  const timeoutMs = options.timeoutMs ?? config.fetchTimeoutMs;

  let signal: AbortSignal | undefined;
  try {
    signal = AbortSignal.timeout(timeoutMs);
  } catch {
    signal = undefined;
  }

  const response = await backend.fetch(url, {
    headers: options.headers,
    browser: config.tlsBrowser,
    signal,
  });

  const headers = headersToRecord(response.headers);
  const contentType = headers['content-type'] ?? '';
  const isPdf = contentType.includes('application/pdf');
  let html = '';
  let rawBuffer: Buffer | undefined;
  if (isPdf && typeof response.arrayBuffer === 'function') {
    const ab = await response.arrayBuffer();
    rawBuffer = Buffer.from(ab);
  } else {
    html = await response.text();
  }

  return {
    url,
    finalUrl: response.url ?? url,
    html,
    contentType,
    statusCode: response.status,
    headers,
    rawBuffer,
  };
}

const ANTI_BOT_STATUS = new Set([403, 429, 503]);

const CHALLENGE_MARKERS = [
  'cf-browser-verification',
  'Just a moment',
  '_cfChlOpt',
  // DataDome inserts a `dd-loader` sensor and inline script that begins
  // `window._dd_s` — either is a strong "blocked" signal.
  'dd-loader',
  '_dd_s',
] as const;

export function isAntiBotStatus(status: number): boolean {
  return ANTI_BOT_STATUS.has(status);
}

export function hasChallengeBody(html: string | null | undefined): boolean {
  if (!html) return false;
  // Bound the scan to the first 32KB — challenge pages are tiny and we don't
  // want to pay full-document regex on a real 5MB article.
  const slice = html.length > 32768 ? html.slice(0, 32768) : html;
  for (const marker of CHALLENGE_MARKERS) {
    if (slice.includes(marker)) return true;
  }
  return false;
}

/**
 * Slice 5 (audit H4): a 429 without an anti-bot challenge body is a plain
 * rate-limit, not an anti-bot wall. Playwright will hit the same rate
 * limit, so escalation just pays the browser cold-start cost for no gain.
 *
 * We treat the response as rate-limited (NOT anti-bot) when:
 *   (a) statusCode === 429, AND
 *   (b) the body does NOT carry a Cloudflare/DataDome challenge marker.
 *
 * Callers (router) check this first and surface the 429 up the stack
 * instead of escalating. A Retry-After header strengthens the signal but
 * isn't required — many CDNs return 429 without one.
 */
export function isRateLimit(statusCode: number, html: string | null | undefined): boolean {
  if (statusCode !== 429) return false;
  return !hasChallengeBody(html);
}

export function isAntiBotSignal(statusCode: number, html: string | null | undefined): boolean {
  // Rate-limits are not anti-bot signals — see `isRateLimit`.
  if (isRateLimit(statusCode, html)) return false;
  return isAntiBotStatus(statusCode) || hasChallengeBody(html);
}

/**
 * Heuristic: the page came back but tells the user that JavaScript is
 * required. Mirrors playwright-tier.shouldEscalate's marker check but is
 * exposed separately so the router can distinguish "TLS failed → try
 * Playwright" from "anti-bot wall → already escalated".
 */
export function looksJsRequired(html: string | null | undefined): boolean {
  if (!html) return true;
  const slice = html.length > 32768 ? html.slice(0, 32768) : html;
  return /enable javascript/i.test(slice);
}

/** Lightweight debug helper used by router to log routing decisions. */
export function describeAntiBot(statusCode: number, html: string | null | undefined): string | null {
  if (isAntiBotStatus(statusCode)) return `status_${statusCode}`;
  if (hasChallengeBody(html)) return 'challenge_body';
  return null;
}

// Touch the logger import so tree-shaking doesn't kill it when log call-sites
// are introduced later.
void log;
