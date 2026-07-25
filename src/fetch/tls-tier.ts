/**
 * TLS-fingerprint HTTP tier.
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
import { anySignal } from '../util/abort.js';
import { guardFetchUrl, guardResolvedHost } from '../watch/ssrf.js';

const log = createLogger('fetch');

export interface TlsFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Caller-supplied abort signal (e.g. the per-fetch deadline assembled by the
   * search content-fetch stage / router). When provided it is COMBINED with the
   * internal `timeoutMs` budget — whichever fires first wins — so the TLS tier
   * never mints a fresh full timeout on top of an already-spent per-fetch
   * deadline. Dropping it would let a timeout-escalation path stack
   * HTTP-timeout + a fresh TLS-timeout (a latency blowup).
   */
  signal?: AbortSignal;
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

/** Host-equality of two URLs; malformed inputs are treated as different hosts. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

/** A copy of `headers` with any Cookie entry removed (case-insensitive), or the
 *  original reference when there is nothing to strip. */
function stripCookieHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  let stripped = false;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'cookie') { stripped = true; continue; }
    out[k] = v;
  }
  return stripped ? out : headers;
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
 * Profiles tried, in order, when the active profile is served an anti-bot
 * challenge. Some networks (e.g. the Stack Exchange Cloudflare edge)
 * serve every chrome impersonation profile a "Just a moment" 403 in <50ms but
 * return a full 200 page on a firefox/safari fingerprint. Rotating across
 * distinct browser families recovers those pages without a browser-engine
 * escalation. A chrome 403 fails in <50ms, so chrome→firefox rotation costs
 * ~1s total — well within the per-fetch stage budget. Rotation beats flipping
 * the default because it survives a future per-profile block too.
 */
const PROFILE_FALLBACK_ORDER = ['firefox_143', 'safari_18'] as const;

/**
 * Cap on total impersonation attempts per fetch (active profile + rotations).
 * Bounds the rotation so a fully-walled host fails fast and escalates to the
 * browser engine rather than walking an unbounded profile list.
 */
const MAX_PROFILE_ATTEMPTS = 3;

/**
 * Build the bounded, de-duplicated list of impersonation profiles to try for a
 * single fetch: the configured/active profile first, then the fixed fallback
 * order, capped at {@link MAX_PROFILE_ATTEMPTS}.
 */
function buildProfileRotation(active: string): string[] {
  const order: string[] = [active];
  for (const profile of PROFILE_FALLBACK_ORDER) {
    if (order.length >= MAX_PROFILE_ATTEMPTS) break;
    if (!order.includes(profile)) order.push(profile);
  }
  return order;
}

const PDF_MAGIC = '%PDF-';

function bufferLooksLikePdf(buf: Buffer): boolean {
  return buf.length >= PDF_MAGIC.length && buf.subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC;
}

async function readResponse(url: string, response: WreqResponse): Promise<TlsFetchResult> {
  const headers = headersToRecord(response.headers);
  const contentType = headers['content-type'] ?? '';
  const declaredPdf = contentType.includes('application/pdf');
  // Mirror the HTTP tier: buffer a declared PDF, and also sniff an ambiguous
  // (generic/absent) content-type for the %PDF- magic marker so an
  // extension-less PDF served without a proper header is still byte-buffered.
  const ambiguousType = contentType === '' || contentType.includes('application/octet-stream');
  let html = '';
  let rawBuffer: Buffer | undefined;
  // Normalised so a magic-bytes PDF is reported as application/pdf downstream.
  let effectiveContentType = contentType;
  if (declaredPdf && typeof response.arrayBuffer === 'function') {
    const ab = await response.arrayBuffer();
    rawBuffer = Buffer.from(ab);
  } else if (ambiguousType && typeof response.arrayBuffer === 'function') {
    const buf = Buffer.from(await response.arrayBuffer());
    if (bufferLooksLikePdf(buf)) {
      rawBuffer = buf;
      effectiveContentType = 'application/pdf';
    } else {
      html = buf.toString('utf-8');
    }
  } else {
    html = await response.text();
  }
  return {
    url,
    finalUrl: response.url ?? url,
    html,
    contentType: effectiveContentType,
    statusCode: response.status,
    headers,
    rawBuffer,
  };
}

/**
 * TLS-impersonation fetch with bounded profile rotation on anti-bot challenges.
 *
 * Returns the same shape as the default HTTP tier so router.ts can swap tiers
 * without branching elsewhere. When the active profile is served an anti-bot
 * challenge (Cloudflare/DataDome — see {@link isAntiBotSignal}) the tier
 * rotates to the next browser family in {@link PROFILE_FALLBACK_ORDER} and
 * returns the first healthy response. If every profile stays blocked it returns
 * the last (still-blocked) result so the router can escalate. All attempts
 * share ONE combined deadline (caller signal + internal timeout) so rotation
 * never mints a fresh full timeout per profile (a latency blowup).
 */
export async function tlsFetch(url: string, options: TlsFetchOptions = {}): Promise<TlsFetchResult> {
  const backend = await loadBackend();
  const config = getConfig();
  const timeoutMs = options.timeoutMs ?? config.fetchTimeoutMs;

  // Combine the internal timeout budget with the caller's deadline (if any) so
  // every attempt shares the same per-fetch budget rather than stacking a
  // fresh full timeout on top of an already-spent one. Built ONCE and reused
  // across rotations. `anySignal` is the hand-rolled combiner the HTTP tier
  // uses (Node 20.0–20.2 lack AbortSignal.any; floor is >=20).
  let signal: AbortSignal | undefined;
  let cleanup: (() => void) | undefined;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (options.signal) {
      const combined = anySignal([options.signal, timeout]);
      signal = combined.signal;
      cleanup = combined.cleanup;
    } else {
      signal = timeout;
    }
  } catch {
    signal = options.signal;
  }

  const profiles = buildProfileRotation(config.tlsBrowser);
  const allowPrivate = config.fetchAllowPrivate;
  const maxHops = config.maxRedirects;

  // Manual, SSRF-re-guarded redirect follower for the TLS-impersonation tier.
  // The backend would otherwise follow 3xx internally with no per-hop guard,
  // so a public URL could be redirected onto a private/metadata target. We
  // follow hops ourselves (redirect:'manual') and re-guard every resolved
  // Location under the same policy the input URL got.
  const guardedBackendFetch = async (browser: string): Promise<WreqResponse> => {
    let current = url;
    const seen = new Set<string>();
    for (let hop = 0; hop <= maxHops; hop++) {
      if (seen.has(current)) throw new Error(`redirect loop at ${current}`);
      seen.add(current);
      // Fetch-time SSRF re-check. `guardFetchUrl` (applied on the redirect
      // Location below) only validates the LITERAL host, so a public hostname
      // whose DNS record points at a blocked address (cloud metadata /
      // RFC-1918 / loopback in serve mode) passes it and is only caught here,
      // before we connect. Applies to the input URL AND every redirect hop.
      // Skip literal IPs — already validated. Same allowPrivate policy as the
      // literal guard.
      {
        const rhost = new URL(current).hostname;
        const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(rhost) || rhost.includes(':');
        if (!isIpLiteral) {
          const resolved = await guardResolvedHost(rhost, 'target url', { allowPrivate });
          if (!resolved.ok) {
            throw new Error(`Redirect blocked: ${resolved.reason}. ${resolved.hint}`);
          }
        }
      }
      // Never carry a Cookie across a cross-host redirect hop — a reused,
      // host-scoped anti-bot clearance must not leak to a different origin.
      const hopHeaders = sameHost(url, current)
        ? options.headers
        : stripCookieHeader(options.headers);
      const resp = await backend.fetch(current, {
        headers: hopHeaders,
        browser,
        signal,
        redirect: 'manual',
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = headersToRecord(resp.headers)['location'];
        if (!loc) return resp;
        current = new URL(loc, current).toString();
        const guard = guardFetchUrl(current, 'redirect location', { allowPrivate });
        if (!guard.ok) {
          throw new Error(`Redirect blocked: ${guard.reason}. ${guard.hint}`);
        }
        continue;
      }
      return resp;
    }
    throw new Error(`too many redirects from ${url}`);
  };

  try {
    let last: TlsFetchResult | undefined;
    for (const browser of profiles) {
      const response = await guardedBackendFetch(browser);
      const result = await readResponse(url, response);

      // Healthy response — return immediately. No rotation on a first-try win.
      if (!isAntiBotSignal(result.statusCode, result.html)) {
        return result;
      }

      // Anti-bot challenge: remember it and rotate to the next profile. Every
      // rotation reuses the SAME shared deadline (never a fresh per-attempt
      // timeout); the bounded profile list caps the total work, and a real
      // exhausted deadline makes the next `backend.fetch` reject — which
      // propagates and fails fast rather than walking the rest of the list.
      last = result;
    }
    // Every profile stayed blocked (or the shared deadline fired). Surface the
    // last result so the router can escalate to the browser engine.
    return last as TlsFetchResult;
  } finally {
    // Detach the combiner's listeners from the (long-lived) caller signal so a
    // shared per-fetch deadline doesn't accumulate one listener per TLS attempt.
    cleanup?.();
  }
}

const ANTI_BOT_STATUS = new Set([403, 429, 503]);

const CHALLENGE_MARKERS = [
  'cf-browser-verification',
  'Just a moment',
  // Cloudflare's classic WAF block page ("Attention Required! | Cloudflare").
  // It carries none of the JS-challenge markers, so a 200/403 block leaked its
  // thin "Sorry, you have been blocked" body as content. Already an
  // interstitial title (see CHALLENGE_TITLE_PATTERN); mirrored here so the body
  // scan / isChallengeShell catches it too. Skeleton-gated at 2xx.
  'Attention Required!',
  '_cfChlOpt',
  // DataDome inserts a `dd-loader` sensor and inline script that begins
  // `window._dd_s` — either is a strong "blocked" signal.
  'dd-loader',
  '_dd_s',
  // DataDome's "enable JavaScript" interstitial (used by G2 and others) renders
  // `<p id="cmsg">Please enable JS and disable any ad blocker</p>` and carries
  // NONE of the sensor markers above. The `id="cmsg"` attribute is a DataDome
  // template signature that never appears in article prose; at a 2xx status the
  // isChallengeShell skeleton gate still applies, so a real article can't trip.
  'id="cmsg"',
  // PerimeterX / HUMAN "press & hold" interstitial (Walmart, StockX, …) — often
  // served at HTTP 200 to MASK the block. The px SENSOR (`window._px`) rides on
  // every real page and must NOT be a marker; these two strings appear only on
  // the interstitial itself. The captcha widget id is vendor-standard; the
  // "Robot or human?" title is the interstitial's own title. Skeleton-gated at
  // 2xx, so a real article that merely mentions the phrase can't trip.
  'id="px-captcha"',
  'Robot or human?',
] as const;

export function isAntiBotStatus(status: number): boolean {
  return ANTI_BOT_STATUS.has(status);
}

// The modern Cloudflare challenge-platform script path. Present in modern
// interstitial bodies AND already used as a skeleton marker below — but here it
// only counts as a challenge signal when it co-occurs with an anti-bot STATUS
// (see isChallengeResponse), so a 200 page that merely links a `/cdn-cgi/...`
// script can never trip it.
const MODERN_CHALLENGE_PLATFORM_MARKER = '/cdn-cgi/challenge-platform/';

/**
 * Header-driven challenge signal. Cloudflare sets `cf-mitigated: challenge`
 * (or `block`) specifically to mark a challenge/block response, so it carries
 * ZERO over-fire risk — a real article response never sends it. Header casing
 * varies across tiers, so the lookup is case-insensitive.
 */
export function hasChallengeHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'cf-mitigated') continue;
    const v = (value ?? '').toLowerCase();
    if (v.includes('challenge') || v.includes('block')) return true;
  }
  return false;
}

/**
 * DataDome block signal from response headers. DataDome (used by G2, Reddit,
 * and others) does NOT send Cloudflare's `cf-mitigated`; on a block it sets
 * `x-dd-b: 1` (its explicit block flag) and/or `x-datadome: protected|blocked`.
 * The `x-datadome-cid` client-id header is stamped on ALLOWED responses too, so
 * it is deliberately ignored here. Caller status-gates this (see
 * isChallengeResponse) for defence in depth — a real 200 never trips it.
 */
export function hasDataDomeBlockHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    const v = (value ?? '').toLowerCase().trim();
    if (k === 'x-dd-b' && v !== '' && v !== '0') return true;
    if (k === 'x-datadome' && (v === 'protected' || v === 'blocked')) return true;
  }
  return false;
}

/**
 * Combined challenge classifier that recognises BOTH legacy and modern
 * Cloudflare challenge shapes without widening the shared CHALLENGE_MARKERS
 * list (which drives isRateLimit / isChallengeShell — those must not shift).
 *
 * Fires when ANY of:
 *   - the `cf-mitigated` response header marks a challenge/block (zero
 *     over-fire — the primary modern signal), OR
 *   - the existing status-agnostic shell classifier fires (isChallengeShell:
 *     anti-bot-status + legacy body markers, OR a 2xx legacy shell with the
 *     skeleton gate), OR
 *   - an anti-bot STATUS (403/429/503) co-occurs with the modern
 *     `/cdn-cgi/challenge-platform/` script marker.
 *
 * The challenge-platform marker is STATUS-gated and the legacy body path keeps
 * its skeleton gate (via isChallengeShell), so a 200 article that merely quotes
 * challenge markers or references `/cdn-cgi/...` can never trip it.
 */
export function isChallengeResponse(
  statusCode: number,
  html: string | null | undefined,
  headers?: Record<string, string> | undefined,
): boolean {
  if (hasChallengeHeader(headers)) return true;
  // DataDome block headers count only on an anti-bot status — its client-id
  // header rides along on allowed 200s, so status-gating keeps zero over-fire.
  if (isAntiBotStatus(statusCode) && hasDataDomeBlockHeader(headers)) return true;
  if (isChallengeShell(statusCode, html)) return true;
  if (isAntiBotStatus(statusCode) && html) {
    const slice = html.length > 32768 ? html.slice(0, 32768) : html;
    if (slice.includes(MODERN_CHALLENGE_PLATFORM_MARKER)) return true;
  }
  return false;
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

// --- Browser-tier-only contextual detection (D6) ---
//
// The browser tier fast-fails a hard challenge page (see browser-pool.ts). It
// must NOT touch the shared CHALLENGE_MARKERS list (which drives router
// escalation + isRateLimit): a bare-substring turnstile marker there would
// over-fire. Instead the browser tier layers a CONTEXTUAL turnstile signal on
// top of the shared body scan, gated on a challenge-page skeleton.

// Turnstile widget marker — only meaningful in the browser tier and only when
// co-occurring with a challenge skeleton. Deliberately NOT in CHALLENGE_MARKERS.
const TURNSTILE_MARKER = 'cf-turnstile';
// A script the challenge interstitial loads to run the browser check.
const CHALLENGE_PLATFORM_SRC = '/cdn-cgi/challenge-platform/';
// Interstitial page titles. Cloudflare's "Just a moment" already lives in the
// shared marker list; this covers the title form used by the skeleton check
// without widening the shared list.
const CHALLENGE_TITLE_PATTERN = /<title>[^<]*(?:just a moment|attention required|checking your browser)[^<]*<\/title>/i;
// Below this rendered-text size a body carries no real article content — the
// hallmark of an interstitial that is nothing but a challenge widget.
const CHALLENGE_SKELETON_MAX_TEXT = 600;
// A server-rendered interactive form (login/search) proves the body is a real
// page, not a challenge interstitial (which injects its widget via JS and ships
// no real form). Used to exempt text-light login pages from the skeleton check.
const REAL_FORM_PATTERN = /<form[\s>][\s\S]*?<(?:input|button|select|textarea)[\s>]/i;

// Approximate the visible text length of an HTML body: strip script/style and
// tags, collapse whitespace. Cheap and bounded — the caller only cares whether
// the result is tiny (interstitial) or substantial (real page).
function approxVisibleTextLength(html: string): number {
  const slice = html.length > 32768 ? html.slice(0, 32768) : html;
  const stripped = slice
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length;
}

/**
 * Browser-tier-only heuristic: does the page look like a challenge-page
 * skeleton rather than a real document? True when ANY of:
 *   - the visible body text is near-empty (interstitials carry almost no prose), OR
 *   - a `/cdn-cgi/challenge-platform/` script is loaded, OR
 *   - the page title is a known interstitial title.
 *
 * This is the CONTEXT gate for the contextual turnstile signal — a real login
 * page that embeds a Turnstile widget has substantial content, no
 * challenge-platform script, and a normal title, so it is never a skeleton.
 */
/**
 * Is the rendered body near-empty (below the interstitial content floor)? A
 * challenge poll uses this AFTER full hydration: a body that never filled with
 * real content did not truly clear — some bot walls (DataDome) swap the
 * interstitial for a tiny stub carrying no marker, which a marker-based
 * clear-check misreads as a pass. Empty/absent HTML counts as near-empty.
 */
export function isNearEmptyBody(html: string | null | undefined): boolean {
  if (!html) return true;
  return approxVisibleTextLength(html) < CHALLENGE_SKELETON_MAX_TEXT;
}

export function isChallengeSkeleton(html: string | null | undefined): boolean {
  if (!html) return false;
  const slice = html.length > 32768 ? html.slice(0, 32768) : html;
  if (slice.includes(CHALLENGE_PLATFORM_SRC)) return true;
  if (CHALLENGE_TITLE_PATTERN.test(slice)) return true;
  // A real server-rendered interactive form means this is a genuine page (e.g.
  // a text-light login screen), not an interstitial skeleton.
  if (REAL_FORM_PATTERN.test(slice)) return false;
  return approxVisibleTextLength(slice) < CHALLENGE_SKELETON_MAX_TEXT;
}

/**
 * Browser-tier challenge-body predicate. Fires when the shared body scan
 * matches (hasChallengeBody) OR when the Turnstile widget marker co-occurs
 * with a challenge-page skeleton. The turnstile signal is CONTEXTUAL — a bare
 * `cf-turnstile` substring on a full real page (a login form) never fires.
 * The shared CHALLENGE_MARKERS list is untouched.
 */
export function hasBrowserChallengeBody(html: string | null | undefined): boolean {
  if (!html) return false;
  if (hasChallengeBody(html)) return true;
  const slice = html.length > 32768 ? html.slice(0, 32768) : html;
  if (slice.includes(TURNSTILE_MARKER) && isChallengeSkeleton(slice)) return true;
  return false;
}

/**
 * Browser-tier CLEAR-CHECK: does the CURRENTLY-RENDERED body still show a
 * challenge? Used as the `isStillChallenge` predicate the completion poll
 * re-evaluates each tick — it MUST key on the live DOM, never the (stale) nav
 * header, so a genuinely-cleared challenge (the real page rendered) reports
 * false and the poll returns cleared.
 *
 * Fires when EITHER:
 *   - the existing browser challenge-body scan matches
 *     (hasBrowserChallengeBody: legacy markers, or contextual turnstile on a
 *     skeleton), OR
 *   - the modern-CF `/cdn-cgi/challenge-platform/` script marker is present AND
 *     the body is a near-empty skeleton (visible text under the interstitial
 *     floor). The skeleton gate here is TEXT-LENGTH based — deliberately NOT
 *     isChallengeSkeleton, which short-circuits true on the marker itself — so a
 *     real full article that merely references the script path (substantial
 *     prose) is NOT treated as still-challenge and the poll clears.
 */
export function stillShowingChallenge(html: string | null | undefined): boolean {
  if (!html) return false;
  if (hasBrowserChallengeBody(html)) return true;
  const slice = html.length > 32768 ? html.slice(0, 32768) : html;
  if (
    slice.includes(MODERN_CHALLENGE_PLATFORM_MARKER) &&
    approxVisibleTextLength(slice) < CHALLENGE_SKELETON_MAX_TEXT
  ) {
    return true;
  }
  return false;
}

/**
 * A 429 without an anti-bot challenge body is a plain
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
 * Status-agnostic challenge-shell classifier. A challenge interstitial must
 * never be returned as fetch content REGARDLESS of HTTP status — some bot
 * walls (DataDome "enable JavaScript" pages) serve the shell at HTTP 200.
 *
 * Fires when EITHER:
 *   - (anti-bot status AND challenge body) — the pre-existing status-gated
 *     signal, preserved verbatim, OR
 *   - (2xx AND challenge markers present AND challenge-page skeleton) — the
 *     200-shell case. BOTH the markers AND the skeleton are required: markers
 *     alone must never fire (an article quoting 'Just a moment' or 'dd-loader'
 *     is legit content), and a skeleton alone is a plain SPA shell handled by
 *     the SPA-empty-content path, not the challenge path.
 */
export function isChallengeShell(statusCode: number, html: string | null | undefined): boolean {
  if (!html) return false;
  if (isAntiBotStatus(statusCode) && hasChallengeBody(html)) return true;
  const is2xx = statusCode >= 200 && statusCode < 300;
  if (is2xx && hasChallengeBody(html) && isChallengeSkeleton(html)) return true;
  return false;
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
