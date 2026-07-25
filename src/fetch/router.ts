import { getConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { contentAppearsEmpty } from './content-check.js';
import { getAuthOptions } from './auth.js';
import { fetchWithPlaywright, shouldEscalate } from './playwright-tier.js';
import { describeFetchError } from './error-describe.js';
import {
  tlsFetch,
  isAntiBotSignal,
  isAntiBotStatus,
  isChallengeShell,
  isChallengeResponse,
  isRateLimit,
  looksJsRequired,
  describeAntiBot,
  TlsTierUnavailableError,
  type TlsFetchResult,
} from './tls-tier.js';
import {
  getDomainRouting,
  recordTlsImpersonationSuccess,
  getDomainClearance,
  clearDomainClearance,
  getBackoff,
  recordBackoff,
  type DomainClearance,
} from '../cache/store.js';
import {
  parseRetryAfter,
  clampBackoffMs,
  DEFAULT_BACKOFF_MS,
} from './politeness.js';
import { resolveStealthUA } from './stealth.js';
import {
  CLEARANCE_COOKIE_NAME,
  clearanceCookieValue,
  isClearanceFresh,
  uaMatchesTier,
  parsedClearanceCookie,
  type ClearanceTier,
} from './clearance-reuse.js';
import { ChallengeBlockedError } from './browser-pool.js';
import { BrowserAcquirer, BROWSER_INSTALLING_NOTE, BROWSER_UNAVAILABLE_ERROR } from './browser-acquire.js';
import { anySignal } from '../util/abort.js';
import { guardFetchUrl, guardResolvedHost } from '../watch/ssrf.js';
import type { RawFetchResult, BrowserAction, Mode, StageError, ContentCompleteness } from '../types.js';

// Domains we know up-front are heavily client-rendered. HTTP-first detection
// keeps mis-classifying these (react.dev SSRs enough nav text to clear the
// empty-content threshold even though the article body only mounts after
// hydration), so we route them straight to Playwright on the first visit.
const KNOWN_SPA_DOMAINS = new Set<string>([
  'react.dev',
  'nextjs.org',
  'vuejs.org',
  'svelte.dev',
  'angular.io',
  'angular.dev',
  'preactjs.com',
  'solidjs.com',
  'remix.run',
  'astro.build',
  'nuxt.com',
]);

// Known anti-bot, connection-timeout-prone CONTENT domains. These
// close the connection / time out BEFORE returning a 4xx/5xx, so the
// signal-based HTTP→TLS escalation never sees a response to react to — the
// plain-HTTP fetch just burns the whole per-fetch budget on a doomed call and
// falls back to snippet-only. Routing them through the TLS-impersonation tier
// FIRST (even when the global tier is off) lets high-value pages (e.g. Stack
// Overflow accepted answers) hydrate instead of returning snippets. Stack
// Exchange runs the entire network on the same anti-bot stack, so the core SE
// Q&A sites are included. Extend at runtime via WIGOLO_TLS_DOMAINS.
const ANTI_BOT_TLS_DOMAINS = new Set<string>([
  'stackoverflow.com',
  'serverfault.com',
  'superuser.com',
  'askubuntu.com',
  'stackexchange.com',
  'mathoverflow.net',
]);

export interface RouterFetchOptions {
  renderJs?: 'auto' | 'always' | 'never';
  useAuth?: boolean;
  headers?: Record<string, string>;
  screenshot?: boolean;
  actions?: BrowserAction[];
  force_refresh?: boolean;
  mode?: Mode;
  /**
   * Conditional-GET headers. When set, the HTTP path sends them with the
   * request and a 304 response is returned as RawFetchResult with
   * statusCode=304 + html=''. Routes that always escalate to Playwright
   * (renderJs=always, useAuth, actions) ignore these headers.
   */
  conditionalHeaders?: {
    ifNoneMatch?: string;
    ifModifiedSince?: string;
  };
  /** Optional abort signal. When provided, in-flight HTTP or browser fetches
   *  will be cancelled when the signal fires. No behavior change — signal is
   *  only plumbed here; enforcement lives in the HTTP client and browser pool. */
  signal?: AbortSignal;
}

export interface HttpClient {
  fetch(
    url: string,
    options?: {
      headers?: Record<string, string>;
      timeoutMs?: number;
      conditionalHeaders?: {
        ifNoneMatch?: string;
        ifModifiedSince?: string;
      };
      signal?: AbortSignal;
    },
  ): Promise<{
    url: string;
    finalUrl: string;
    html: string;
    contentType: string;
    statusCode: number;
    headers: Record<string, string>;
    rawBuffer?: Buffer;
  }>;
}

/**
 * Options accepted by the browser tier's `fetchWithBrowser`. `stealth` opts a
 * single fetch into the dedicated anti-bot fingerprint-hardening context path.
 */
export interface BrowserFetchArgs {
  headers?: Record<string, string>;
  storageStatePath?: string;
  userDataDir?: string;
  screenshot?: boolean;
  actions?: BrowserAction[];
  cdpUrl?: string;
  signal?: AbortSignal;
  stealth?: boolean;
  injectedCookies?: Array<{ name: string; value: string; domain: string; path?: string }>;
}

export interface BrowserPoolInterface {
  fetchWithBrowser(
    url: string,
    options?: BrowserFetchArgs,
  ): Promise<RawFetchResult>;
  /** Optional pre-launch of the browser engine so a later fetch doesn't pay
   *  cold-start inline. Idempotent + best-effort. Pools that don't implement it
   *  simply skip prewarming. */
  warm?(): Promise<void>;
}

export type HttpFetcher = (
  url: string,
  options?: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
) => Promise<{ url: string; html: string; text: string }>;

export type PlaywrightFetcher = (
  url: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<{ html: string; text: string; completeness: ContentCompleteness }>;

/**
 * Injectable TLS-impersonation fetcher. Same shape as `tlsFetch`
 * from tls-tier.ts; left injectable so unit tests can stub without touching
 * the wreq-js native binary.
 */
export type TlsFetcher = (
  url: string,
  options?: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
) => Promise<TlsFetchResult>;

/**
 * Cheap content-type probe. Resolves true when the URL serves a PDF (by HEAD
 * content-type or magic-bytes). Injectable so router tests don't hit the
 * network. Defaults to {@link defaultPdfProbe}.
 */
export type PdfProbe = (url: string, signal?: AbortSignal) => Promise<boolean>;

/** Pluggable hooks to learning/persistence layer so router tests don't need a DB. */
export interface TlsRoutingPersistence {
  getPreferTls(domain: string): boolean;
  recordSuccess(domain: string): void;
}

/**
 * Anti-bot clearance store seam (S-A2). The router reads a stored clearance
 * before a dispatch and purges a dead one after a re-challenge. Injectable so
 * router unit tests exercise reuse without a DB; defaults to the cache store.
 *
 * S-A5 extends the seam with the per-host rate-limit backoff window so the same
 * injection point covers both clearance reuse and origin-politeness backoff.
 */
export interface ClearanceStore {
  get(host: string): DomainClearance | null;
  clear(host: string): void;
  /** Epoch ms when the host's rate-limit cooldown ends, or null when none. */
  getBackoff(host: string): number | null;
  /** Record a per-host rate-limit cooldown (epoch ms). */
  recordBackoff(host: string, untilEpochMs: number): void;
}

export interface SmartRouterOptions {
  httpClient?: HttpClient;
  browserPool?: BrowserPoolInterface;
  httpFetcher?: HttpFetcher;
  playwrightFetcher?: PlaywrightFetcher;
  /** When provided, overrides the default lazy-loaded wreq backend. */
  tlsFetcher?: TlsFetcher;
  /** Persistence for `prefer_tls_impersonation` learning. */
  tlsPersistence?: TlsRoutingPersistence;
  /** Anti-bot clearance reuse store. Defaults to the cache store. */
  clearanceStore?: ClearanceStore;
  /** Overrides the default HEAD/magic-bytes PDF probe (tests inject a stub). */
  pdfProbe?: PdfProbe;
  /**
   * Coordinates lazy browser-engine acquisition when the browser tier is
   * entered on a machine without the browser installed. Injectable so router
   * tests can control the acquisition outcome without touching the installer.
   * Defaults to a shared {@link BrowserAcquirer}.
   */
  browserAcquirer?: BrowserAcquirer;
  /**
   * Opt-in Tier-B escape-hatch fetchers (challenge-solver + hosted reader).
   * Injectable so router tests exercise the ladder without the real network
   * rungs. Defaults to a lazy `import('./escape-hatch.js')` so a default
   * install never loads the module.
   */
  escapeHatch?: EscapeHatchFetchers;
}

/** The two escape-hatch rung fetchers, injectable for tests. */
export interface EscapeHatchFetchers {
  solverFetch: typeof import('./escape-hatch.js').solverFetch;
  hostedReaderFetch: typeof import('./escape-hatch.js').hostedReaderFetch;
}

interface DomainStats {
  failureCount: number;
  preferPlaywright: boolean;
}

// Path extensions that a browser treats as a file download rather than a
// navigable document. Chromium fires a download event / throws "Download is
// starting" on these, so they must be buffered by the byte tier instead of
// being handed to Playwright. Pattern-level (extension set), NOT a site list.
const BINARY_DOWNLOAD_EXTENSIONS = [
  '.pdf', '.zip',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
];

// True when the URL's pathname ends in a known binary-download extension.
// Returns false (never throws) for malformed URLs.
export function looksLikeBinaryDownload(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return BINARY_DOWNLOAD_EXTENSIONS.some((ext) => pathname.endsWith(ext));
}

// The leading bytes of every PDF file. Used as a content-sniff fallback when a
// server serves a PDF without a distinguishing content-type header.
const PDF_MAGIC = '%PDF-';

/**
 * True when an HTTP/TLS-tier result is a PDF regardless of URL extension —
 * either the response advertised `application/pdf`, or the buffered bytes begin
 * with the PDF magic marker. A PDF response is a completed byte-tier result and
 * must never be re-routed to the browser (which treats it as a download and
 * hard-errors "Download is starting"). Extension-independent by design.
 */
export function looksLikePdfResult(result: { contentType?: string; rawBuffer?: Buffer }): boolean {
  const ct = result.contentType?.toLowerCase() ?? '';
  if (ct.includes('application/pdf')) return true;
  const buf = result.rawBuffer;
  if (buf && buf.length >= PDF_MAGIC.length) {
    return buf.subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC;
  }
  return false;
}

/**
 * Cheap content-type probe: a HEAD request that reads only `Content-Type`, with
 * a bounded ranged-GET magic-bytes fallback when HEAD is unreliable (blocked /
 * missing header). Resolves true when the URL serves a PDF, false otherwise or
 * on any error — a probe failure must never block a fetch. Bounded to a short
 * timeout so it adds minimal latency and can only run when we are already about
 * to pay a browser cold-start.
 */
export async function defaultPdfProbe(url: string, signal?: AbortSignal): Promise<boolean> {
  const probeTimeoutMs = 3000;
  const timeout = AbortSignal.timeout(probeTimeoutMs);
  const combined = signal ? anySignal([signal, timeout]) : { signal: timeout, cleanup: () => {} };
  const allowPrivate = getConfig().fetchAllowPrivate;
  const maxHops = getConfig().maxRedirects;

  // Manual, SSRF-re-guarded redirect follower. `redirect:'follow'` would let a
  // public URL 302 the probe onto a private/metadata target; instead we follow
  // hops ourselves and re-guard every resolved Location. A blocked hop resolves
  // to `null` so the caller treats it as a probe failure (non-fatal by
  // contract) rather than issuing the request.
  const guardedFetch = async (
    target: string,
    init: { method: string; headers?: Record<string, string> },
  ): Promise<Response | null> => {
    let current = target;
    const seen = new Set<string>();
    for (let hop = 0; hop <= maxHops; hop++) {
      if (seen.has(current)) return null;
      seen.add(current);
      // Fetch-time SSRF re-check. `guardFetchUrl` (applied on the redirect
      // Location below) only validates the LITERAL host, so a public hostname
      // whose DNS record points at a blocked address (cloud metadata /
      // RFC-1918 / loopback in serve mode) passes it and is only caught here,
      // before we connect. Applies to the input target AND every redirect
      // hop. Skip literal IPs — already validated. Same allowPrivate policy
      // as the literal guard.
      {
        const rhost = new URL(current).hostname;
        const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(rhost) || rhost.includes(':');
        if (!isIpLiteral) {
          const resolved = await guardResolvedHost(rhost, 'target url', { allowPrivate });
          if (!resolved.ok) return null;
        }
      }
      const resp = await fetch(current, { ...init, redirect: 'manual', signal: combined.signal });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) return resp;
        try { await resp.arrayBuffer(); } catch { /* drain */ }
        current = new URL(loc, current).toString();
        if (!guardFetchUrl(current, 'redirect location', { allowPrivate }).ok) return null;
        continue;
      }
      return resp;
    }
    return null;
  };

  try {
    const head = await guardedFetch(url, { method: 'HEAD' });
    if (!head) return false;
    const ct = head.headers.get('content-type')?.toLowerCase() ?? '';
    if (ct.includes('application/pdf')) return true;
    // HEAD returned a definitive non-PDF content-type → trust it, skip the GET.
    if (ct && !ct.includes('application/octet-stream')) return false;
    // No / ambiguous content-type: sniff the first bytes with a ranged GET.
    const ranged = await guardedFetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-15' },
    });
    if (!ranged) return false;
    const rangedCt = ranged.headers.get('content-type')?.toLowerCase() ?? '';
    if (rangedCt.includes('application/pdf')) return true;
    // Read only the first chunk from the stream — a server that ignores the
    // Range header would otherwise stream the whole file into memory. We only
    // need the 5-byte %PDF- marker; cancel the body once we have it.
    const reader = ranged.body?.getReader();
    if (!reader) return false;
    try {
      const { value } = await reader.read();
      if (!value) return false;
      const head5 = Buffer.from(value.subarray(0, PDF_MAGIC.length)).toString('latin1');
      return head5 === PDF_MAGIC;
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    return false;
  } finally {
    combined.cleanup();
  }
}

function isKnownSpaDomain(host: string): boolean {
  const lower = host.toLowerCase();
  if (KNOWN_SPA_DOMAINS.has(lower)) return true;
  // Match subdomains: docs.react.dev → react.dev hit
  for (const d of KNOWN_SPA_DOMAINS) {
    if (lower.endsWith(`.${d}`)) return true;
  }
  return false;
}

function matchesDomainSet(host: string, set: Set<string> | readonly string[]): boolean {
  const lower = host.toLowerCase();
  for (const d of set) {
    if (lower === d || lower.endsWith(`.${d}`)) return true;
  }
  return false;
}

/**
 * A domain is in the anti-bot TLS-first set when it is in the
 * built-in {@link ANTI_BOT_TLS_DOMAINS} list OR the operator-supplied
 * WIGOLO_TLS_DOMAINS list. Both match the host exactly or as a subdomain.
 */
function isAntiBotTlsDomain(host: string, extra: readonly string[]): boolean {
  return matchesDomainSet(host, ANTI_BOT_TLS_DOMAINS) || matchesDomainSet(host, extra);
}

/**
 * Public predicate over a full URL. True when the URL's host
 * is in the curated anti-bot/TLS-first set or the operator-supplied
 * WIGOLO_TLS_DOMAINS list — i.e. the same domains {@link SmartRouter.fetch}
 * routes through the TLS-impersonation tier first. The search-hydration path
 * uses this to grant those domains a larger per-URL fetch budget so a working
 * TLS attempt (~1-5s) is not starved by the small balanced per-URL budget.
 * Returns false (never throws) for malformed URLs.
 */
export function isAntiBotTlsFirstUrl(url: string, extraDomains: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return isAntiBotTlsDomain(host, extraDomains);
}

/**
 * Whether a browser-tier fetch should use the dedicated anti-bot
 * fingerprint-hardening (stealth) context, given the configured mode and
 * whether THIS browser fetch was reached via an anti-bot / challenge
 * escalation.
 *
 *   - 'off'  → never harden.
 *   - 'on'   → harden every browser fetch.
 *   - 'auto' → harden ONLY an anti-bot / challenge escalation (a bot wall the
 *              lower tiers could not clear). A benign SPA-shell render or an
 *              explicit browser request (render_js:'always' / auth / actions)
 *              is left on the pooled default fingerprint — hardening a benign
 *              page adds cost + a distinct context for no anti-bot benefit.
 */
export function stealthForBrowser(
  config: Pick<Config, 'stealth'>,
  ctx: { antiBotEscalation: boolean },
): boolean {
  switch (config.stealth) {
    case 'off':
      return false;
    case 'on':
      return true;
    default:
      return ctx.antiBotEscalation;
  }
}

// Connection-level timeout / reset errors that surface as a THROW
// (no HTTP status) rather than a response. Mirrors the retryable set the HTTP
// client uses; the AbortSignal.timeout path throws TimeoutError, while raw
// socket failures carry a Node error `code`.
const TIMEOUT_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);

function isConnectionTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const code = (err as Error & { code?: string }).code;
  return code !== undefined && TIMEOUT_ERROR_CODES.has(code);
}

export class SmartRouter {
  private readonly domainMap = new Map<string, DomainStats>();
  private readonly httpClient?: HttpClient;
  private readonly browserPool?: BrowserPoolInterface;
  private readonly httpFetcher: HttpFetcher;
  private readonly playwrightFetcher: PlaywrightFetcher;
  private readonly tlsFetcher: TlsFetcher;
  private readonly tlsPersistence: TlsRoutingPersistence;
  private readonly pdfProbe: PdfProbe;
  private readonly browserAcquirer: BrowserAcquirer;
  private readonly clearanceStore: ClearanceStore;
  private readonly escapeHatchOverride: EscapeHatchFetchers | undefined;

  constructor(httpClient: HttpClient, browserPool: BrowserPoolInterface);
  constructor(options: SmartRouterOptions);
  constructor(
    httpClientOrOptions: HttpClient | SmartRouterOptions,
    browserPool?: BrowserPoolInterface,
  ) {
    if (browserPool !== undefined) {
      this.httpClient = httpClientOrOptions as HttpClient;
      this.browserPool = browserPool;
    } else if (
      httpClientOrOptions &&
      typeof httpClientOrOptions === 'object' &&
      ('httpClient' in httpClientOrOptions ||
        'browserPool' in httpClientOrOptions ||
        'httpFetcher' in httpClientOrOptions ||
        'playwrightFetcher' in httpClientOrOptions ||
        'tlsFetcher' in httpClientOrOptions ||
        'tlsPersistence' in httpClientOrOptions ||
        'clearanceStore' in httpClientOrOptions ||
        'pdfProbe' in httpClientOrOptions ||
        'escapeHatch' in httpClientOrOptions)
    ) {
      const opts = httpClientOrOptions as SmartRouterOptions;
      if (!opts.httpFetcher && !opts.httpClient) {
        throw new Error('SmartRouter: must provide either httpFetcher or httpClient in options');
      }
      this.httpClient = opts.httpClient;
      this.browserPool = opts.browserPool;
      this.httpFetcher = opts.httpFetcher ?? this.makeDefaultHttpFetcher();
      this.playwrightFetcher = opts.playwrightFetcher ?? fetchWithPlaywright;
      this.tlsFetcher = opts.tlsFetcher ?? tlsFetch;
      this.tlsPersistence = opts.tlsPersistence ?? defaultTlsPersistence();
      this.pdfProbe = opts.pdfProbe ?? defaultPdfProbe;
      this.browserAcquirer = opts.browserAcquirer ?? new BrowserAcquirer();
      this.clearanceStore = opts.clearanceStore ?? defaultClearanceStore();
      this.escapeHatchOverride = opts.escapeHatch;
      return;
    } else {
      // Backwards-compat: single HttpClient positional (unusual but safe)
      this.httpClient = httpClientOrOptions as HttpClient;
    }
    this.httpFetcher = this.makeDefaultHttpFetcher();
    this.playwrightFetcher = fetchWithPlaywright;
    this.tlsFetcher = tlsFetch;
    this.tlsPersistence = defaultTlsPersistence();
    this.pdfProbe = defaultPdfProbe;
    this.browserAcquirer = new BrowserAcquirer();
    this.clearanceStore = defaultClearanceStore();
  }

  /**
   * The stored clearance for `host` when it is fresh AND presentable by `tier`,
   * else null. Purges an EXPIRED entry as a side-effect so a dead cookie is not
   * carried forward. A UA mismatch (e.g. a Firefox-minted clearance for the
   * Chromium browser tier) returns null WITHOUT clearing — the entry may still
   * be valid for another tier.
   */
  private clearanceFor(host: string, tier: ClearanceTier): DomainClearance | null {
    let stored: DomainClearance | null;
    try {
      stored = this.clearanceStore.get(host);
    } catch {
      return null;
    }
    if (!stored) return null;
    if (!isClearanceFresh(stored, Date.now())) {
      try { this.clearanceStore.clear(host); } catch { /* best-effort */ }
      return null;
    }
    if (!uaMatchesTier(stored.ua, tier)) return null;
    if (clearanceCookieValue(stored.cookie) == null) return null;
    return stored;
  }

  /**
   * Merge a reused clearance `Cookie:` header for the header tiers (tls/http)
   * into `headers` without clobbering caller headers. Returns the original
   * reference when there is no usable clearance so no allocation happens on the
   * common path.
   */
  private withClearanceHeader(
    host: string,
    tier: 'tls' | 'http',
    headers?: Record<string, string>,
  ): Record<string, string> | undefined {
    const clearance = this.clearanceFor(host, tier);
    if (!clearance) return headers;
    const value = clearanceCookieValue(clearance.cookie);
    if (value == null) return headers;
    const existingCookie = headers?.['Cookie'] ?? headers?.['cookie'];
    const cookieValue = existingCookie
      ? `${existingCookie}; ${CLEARANCE_COOKIE_NAME}=${value}`
      : `${CLEARANCE_COOKIE_NAME}=${value}`;
    return { ...headers, Cookie: cookieValue };
  }

  /**
   * HTTP-tier dispatch that injects a reused clearance `Cookie:` header for the
   * URL's host (best-effort cross-tier). Every real HTTP dispatch routes through
   * here so no call site is left unthreaded. The http-client's redirect follower
   * strips the Cookie on a cross-host hop, so the cookie never leaks.
   */
  private async httpClientFetch(
    url: string,
    opts: {
      headers?: Record<string, string>;
      timeoutMs?: number;
      conditionalHeaders?: RouterFetchOptions['conditionalHeaders'];
      signal?: AbortSignal;
    },
  ): Promise<Awaited<ReturnType<HttpClient['fetch']>>> {
    if (!this.httpClient) throw new Error('SmartRouter: httpClient not configured');
    let host: string | null = null;
    try { host = new URL(url).hostname; } catch { host = null; }
    const headers = host ? this.withClearanceHeader(host, 'http', opts.headers) : opts.headers;
    return this.httpClient.fetch(url, { ...opts, headers });
  }

  private makeDefaultHttpFetcher(): HttpFetcher {
    return async (url, opts) => {
      if (!this.httpClient) {
        throw new Error('SmartRouter: httpClient not configured');
      }
      const r = await this.httpClientFetch(url, opts ?? {});
      return { url: r.url, html: r.html, text: '' };
    };
  }

  /**
   * Dispatch an implicit/auto-path fetch that would otherwise go to the browser
   * tier. A browser treats a PDF response as a download and hard-errors
   * ("Download is starting"), so — for URLs whose extension didn't already
   * short-circuit to HTTP — we run a cheap content-type probe first. When the
   * probe says PDF, the fetch is served by the byte tier instead. The probe
   * only runs on this browser-bound path, so normal HTML fetches (which are
   * served HTTP-first) never pay for it.
   */
  private async browserOrHttpForBinary(
    url: string,
    domain: string,
    opts: { headers?: Record<string, string>; screenshot?: boolean; conditionalHeaders?: RouterFetchOptions['conditionalHeaders']; signal?: AbortSignal },
    logger: ReturnType<typeof createLogger>,
  ): Promise<RawFetchResult | StageError> {
    const { headers, screenshot, conditionalHeaders, signal } = opts;
    // An extension-typed binary already routed to HTTP upstream, so this probe
    // only fires for extensionless URLs about to hit the browser.
    if (!looksLikeBinaryDownload(url)) {
      let isPdf = false;
      try {
        isPdf = await this.pdfProbe(url, signal);
      } catch {
        isPdf = false;
      }
      if (isPdf) {
        if (!this.httpClient) throw new Error('SmartRouter: httpClient not configured');
        logger.debug('content-type probe identified a PDF, routing to http instead of browser', { url, domain });
        const result = await this.httpClientFetch(url, { headers, conditionalHeaders, signal });
        this.ensureStats(domain);
        return this.toRawFetchResult(result);
      }
    }
    if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
    // Domain-marked / binary auto path — not an anti-bot escalation, so 'auto'
    // leaves it unhardened; 'on' still hardens every browser fetch.
    return this.browserFetch(url, {
      headers,
      screenshot,
      signal,
      stealth: stealthForBrowser(getConfig(), { antiBotEscalation: false }),
    });
  }

  /**
   * Invoke the browser tier and map a hard bot-protection challenge
   * (ChallengeBlockedError, thrown by the browser pool's anti-bot fast-fail)
   * to a structured `blocked_by_challenge` stage error instead of letting it
   * propagate as an unhandled throw. All other errors propagate unchanged.
   * Every browser-tier call site routes through here so the mapping is uniform.
   *
   * This is ALSO the single lazy-acquisition choke point (D3): before touching
   * the browser pool we ensure the browser engine is installed. When it is not,
   * a memoized background install is joined for a bounded budget; if it hasn't
   * finished in time we DON'T block the tool call for minutes — we fall back to
   * the best lower-tier content the caller already has (`fallback`, when the
   * escalation site captured an HTTP/TLS response) with an actionable note, or,
   * when no lower-tier content exists, return an actionable stage error.
   */
  private async browserFetch(
    url: string,
    options: BrowserFetchArgs & { fallback?: RawFetchResult },
  ): Promise<RawFetchResult | StageError> {
    if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');

    const { fallback, ...browserOptions } = options;
    const acquired = await this.browserAcquirer.ensureBrowser();
    if (acquired !== 'ready') {
      const logger = createLogger('fetch');
      if (fallback) {
        logger.info('browser engine not ready within budget — returning lower-tier content with note', { url });
        // The browser was the escalation target because the lower tier returned
        // a challenge shell (or an anti-bot-status challenge body). If we cannot
        // acquire it, we must NOT fall back to returning that shell as content —
        // guard it so a challenge fallback becomes blocked_by_challenge, while
        // legit lower-tier content passes through unchanged with the note.
        return this.guardChallengeShell({ ...fallback, warning: BROWSER_INSTALLING_NOTE });
      }
      logger.info('browser engine not ready within budget and no lower-tier content — failing with actionable error', { url });
      return {
        error: 'browser_engine_unavailable',
        error_reason: BROWSER_UNAVAILABLE_ERROR,
        stage: 'fetch',
        hint: 'run `wigolo warmup --browser` to install the browser engine now, then retry',
      };
    }

    // Seed a reused browser-tier clearance (same-tier preferred). Skipped for
    // the CDP path (an external browser owns its own cookie jar) and when the
    // caller already supplied injectedCookies. The host is scoped onto the
    // cookie so the browser drops it on any cross-host redirect.
    if (!browserOptions.cdpUrl && !browserOptions.injectedCookies) {
      let host: string | null = null;
      try { host = new URL(url).hostname; } catch { host = null; }
      if (host) {
        const clearance = this.clearanceFor(host, 'browser');
        const cookie = clearance ? parsedClearanceCookie(clearance.cookie, host) : null;
        if (cookie) {
          browserOptions.injectedCookies = [cookie];
        }
      }
    }

    try {
      // Guard the browser SUCCESS return: a browser result that is STILL a
      // challenge (an uncleared modern-CF interstitial that reports 403 +
      // cf-mitigated + a challenge body) must become a labeled
      // blocked_by_challenge, never leak the shell as content. guardChallengeShell
      // runs isChallengeResponse(status, html, headers). A CLEARED challenge is
      // safe here: the browser pool normalises a cleared result to 200 and drops
      // the stale cf-mitigated header, so the guard only fires on a genuine
      // still-challenge; normal content passes through unchanged.
      return this.guardChallengeShell(await this.browserPool.fetchWithBrowser(url, browserOptions));
    } catch (err) {
      if (err instanceof ChallengeBlockedError) {
        // Terminal browser challenge-block. Before returning the fast-fail, try
        // the opt-in escape-hatch rungs (solver → hosted reader) IF configured.
        // Unconfigured rungs no-op and never load the module (default path).
        const cleared = await this.tryEscapeHatch(url, browserOptions.signal);
        if (cleared) return cleared;
        return {
          error: err.code,
          error_reason: err.message,
          stage: 'fetch',
          hint: err.hint,
        };
      }
      throw err;
    }
  }

  /**
   * Opt-in Tier-B escape-hatch ladder, tried only after the browser tier hits a
   * hard challenge-block. Rungs are attempted in order: challenge-solver, then
   * hosted reader. Each is OFF unless its URL is configured; when neither is
   * configured this returns null WITHOUT loading the escape-hatch module, so a
   * default install never pays for it. Any rung that clears the page wins.
   */
  private async tryEscapeHatch(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<RawFetchResult | null> {
    const cfg = getConfig();
    if (!cfg.solverUrl && !cfg.hostedReaderUrl) return null;

    const fetchers =
      this.escapeHatchOverride ?? (await import('./escape-hatch.js'));
    const hatchCfg = {
      solverUrl: cfg.solverUrl,
      hostedReaderUrl: cfg.hostedReaderUrl,
      fetchAllowPrivate: cfg.fetchAllowPrivate,
      maxRedirects: cfg.maxRedirects,
      fetchTimeoutMs: cfg.fetchTimeoutMs,
    };

    if (cfg.solverUrl) {
      const solved = await fetchers.solverFetch(url, hatchCfg, { signal });
      if (solved) return solved;
    }
    if (cfg.hostedReaderUrl) {
      const read = await fetchers.hostedReaderFetch(url, hatchCfg, { signal });
      if (read) return read;
    }
    return null;
  }

  /**
   * Terminal choke point: never return a challenge-shell body as final fetch
   * content. When a lower tier's result is about to exit to the caller as final
   * content (http-only mode, TLS terminal, escalation exhausted) and the body
   * classifies as a challenge shell (challenge markers + skeleton, at any HTTP
   * status), map it to the same `blocked_by_challenge` stage error the browser
   * tier raises — the caller gets a structured, actionable error instead of the
   * interstitial markdown. A clean result passes through untouched.
   */
  private guardChallengeShell(raw: RawFetchResult): RawFetchResult | StageError {
    if (isChallengeResponse(raw.statusCode, raw.html, raw.headers)) {
      const err = new ChallengeBlockedError(raw.url);
      return {
        error: err.code,
        error_reason: err.message,
        stage: 'fetch',
        hint: err.hint,
      };
    }
    return raw;
  }

  async fetch(url: string, options: RouterFetchOptions & { mode: 'stealth' }): Promise<RawFetchResult | StageError>;
  async fetch(url: string, options?: RouterFetchOptions): Promise<RawFetchResult>;
  async fetch(
    url: string,
    options: RouterFetchOptions = {},
  ): Promise<RawFetchResult | StageError> {
    const { renderJs = 'auto', useAuth = false, headers, screenshot, actions, mode, conditionalHeaders, signal } = options;
    const config = getConfig();
    const logger = createLogger('fetch');
    const threshold = config.browserFallbackThreshold;
    const domain = new URL(url).hostname;

    // Stealth mode: static fetch first, escalate to Playwright when content is thin.
    if (mode === 'stealth') {
      // A 429 backoff window is the origin rate-limiting us — stealth is the
      // retry-past-a-block escape hatch, but it cannot clear a rate limit, so
      // it respects the window too rather than hammering the origin.
      const stealthBackoff = this.backoffWindowResult(url, domain);
      if (stealthBackoff) {
        logger.debug('host in rate-limit backoff window — skipping stealth origin fetch', { url, domain });
        return stealthBackoff;
      }
      logger.debug('routing to stealth (static then escalate)', { url });
      const staticResult = await this.httpFetcher(url, { headers, signal });
      this.ensureStats(domain);
      // Escalate on thin content (shouldEscalate) OR on a challenge shell. The
      // /enable javascript/i shell already trips shouldEscalate, but a
      // challenge skeleton that carries markers yet exceeds the 500-char floor
      // and never says "enable javascript" would otherwise pass through — the
      // isChallengeShell check (markers + skeleton) covers that shape too.
      const stealthChallenge = isChallengeShell(200, staticResult.html);
      if (!shouldEscalate(staticResult.text) && !stealthChallenge) {
        return {
          url: staticResult.url,
          finalUrl: staticResult.url,
          html: staticResult.html,
          contentType: 'text/html',
          statusCode: 200,
          method: 'http',
          headers: {},
        };
      }
      // The stealth escalation uses the daemon browser helper
      // (playwright-tier.ts), which is a browser-tier entry outside browserFetch.
      // Thread lazy acquisition here too so no escalation call site is left
      // unthreaded — when the browser can't be acquired within budget, return the
      // static content already in hand with the actionable note rather than a
      // hard failure or a minutes-long block.
      const acquired = await this.browserAcquirer.ensureBrowser();
      if (acquired !== 'ready') {
        logger.info('stealth escalation: browser engine not ready within budget — returning static content with note', { url });
        // If the static body is itself a challenge shell we cannot fall back to
        // returning it — surface the structured challenge error instead of the
        // interstitial markdown.
        return this.guardChallengeShell({
          url: staticResult.url,
          finalUrl: staticResult.url,
          html: staticResult.html,
          contentType: 'text/html',
          statusCode: 200,
          method: 'http',
          headers: {},
          warning: BROWSER_INSTALLING_NOTE,
        });
      }
      try {
        const pw = await this.playwrightFetcher(url, { signal });
        return {
          url: staticResult.url,
          finalUrl: staticResult.url,
          html: pw.html,
          contentType: 'text/html',
          statusCode: 200,
          method: 'browser',
          headers: {},
          escalated: true,
          contentCompleteness: pw.completeness,
        };
      } catch (err) {
        if (err instanceof Error && err.message === 'playwright_not_installed') {
          const hint = (err as Error & { hint?: string }).hint ?? 'npx playwright install chromium';
          return {
            error: 'playwright_not_installed',
            error_reason: 'Stealth mode requested but Playwright chromium is not installed',
            stage: 'fetch',
            hint,
          };
        }
        const described = describeFetchError(err);
        return {
          error: 'playwright_fetch_failed',
          error_reason: described.reason,
          stage: 'fetch',
          hint: described.hint ?? 'Stealth fetch failed; check network or retry',
        };
      }
    }

    // Cache mode: HTTP-only with tight timeout, never escalates to a browser.
    if (mode === 'cache') {
      if (actions && actions.length > 0) {
        logger.warn('mode=cache ignores browser actions; switch to default/stealth to execute them', {
          url,
          actionCount: actions.length,
        });
      }
      logger.debug('routing to http (cache)', { url });
      if (!this.httpClient) throw new Error('SmartRouter: httpClient not configured');
      const result = await this.httpClientFetch(url, {
        headers,
        timeoutMs: config.fastTimeoutMs,
        conditionalHeaders,
        signal,
      });
      this.ensureStats(domain);
      const raw = this.toRawFetchResult(result);
      // Don't probe content of a 304 — body is empty by spec, not a SPA shell.
      raw.jsRequired = result.statusCode === 304 ? false : contentAppearsEmpty(result.html);
      return raw;
    }

    // Actions always force Playwright --- actions need a live browser page
    if (actions && actions.length > 0) {
      if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
      const authOptions = useAuth ? (await getAuthOptions() ?? {}) : {};
      logger.debug('routing to playwright', { url, reason: 'actions present' });
      return this.browserFetch(url, {
        headers,
        screenshot,
        actions,
        ...authOptions,
        signal,
        stealth: stealthForBrowser(config, { antiBotEscalation: false }),
      });
    }

    // Always Playwright for auth or explicit override
    if (renderJs === 'always' || useAuth) {
      if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
      const authOptions = useAuth ? (await getAuthOptions() ?? {}) : {};
      logger.debug('routing to playwright', { url, reason: useAuth ? 'auth' : 'render_js=always' });
      // Explicit browser request (auth / render_js:always) — not an anti-bot
      // escalation, so 'auto' leaves it unhardened; 'on' still hardens.
      return this.browserFetch(url, {
        headers,
        screenshot,
        ...authOptions,
        signal,
        stealth: stealthForBrowser(config, { antiBotEscalation: false }),
      });
    }

    // HTTP only, no fallback
    if (renderJs === 'never') {
      if (!this.httpClient) throw new Error('SmartRouter: httpClient not configured');
      logger.debug('routing to http (never)', { url });
      const result = await this.httpClientFetch(url, { headers, conditionalHeaders, signal });
      const neverStats = this.ensureStats(domain);
      // A known-SPA domain that returns substantive
      // HTTP content on a render_js: never call proves the domain is
      // reachable without a browser. Reset the sticky pre-mark so a
      // subsequent default-mode fetch on the same domain skips Playwright.
      // Guarded to known-SPA pre-marks only — see the equivalent block in
      // the auto-mode path below for the rationale.
      const neverStatus = result.statusCode;
      const neverOk = neverStatus >= 200 && neverStatus < 300;
      if (neverOk && neverStats.preferPlaywright && isKnownSpaDomain(domain) && !contentAppearsEmpty(result.html)) {
        logger.info('known-SPA domain served substantive HTTP via render_js:never — downgrading prefer-chromium', { url, domain });
        neverStats.preferPlaywright = false;
      }
      // http-only mode can never escalate to the browser to clear a challenge,
      // so a challenge shell here is terminal — surface the structured error
      // instead of returning the interstitial markdown.
      return this.guardChallengeShell(this.toRawFetchResult(result));
    }

    // Binary downloads (PDF/zip/office docs) must go to the byte tier: the
    // HTTP/TLS tiers buffer them into rawBuffer, but a browser treats a
    // download response as a "Download is starting" hard error. Force HTTP when
    // the URL looks like a binary download. Explicit browser requests
    // (renderJs='always' / useAuth / actions) already returned above and are
    // honored; renderJs='never' is already HTTP-only — so this only affects the
    // implicit auto path where the domain might otherwise prefer Playwright.
    if (looksLikeBinaryDownload(url)) {
      if (!this.httpClient) throw new Error('SmartRouter: httpClient not configured');
      logger.debug('routing to http (binary download)', { url });
      const result = await this.httpClientFetch(url, { headers, conditionalHeaders, signal });
      this.ensureStats(domain);
      return this.toRawFetchResult(result);
    }

    // auto: honor an active rate-limit backoff window before touching the
    // origin — a 429 means the origin is rate-limiting us, so re-hammering it
    // (any tier) does not help. Expired/absent windows fall through and fetch
    // normally (no false positives).
    const autoBackoff = this.backoffWindowResult(url, domain);
    if (autoBackoff) {
      logger.debug('host in rate-limit backoff window — skipping origin fetch', { url, domain });
      return autoBackoff;
    }

    // auto: check if domain is already marked for Playwright
    const stats = this.ensureStats(domain);

    if (stats.preferPlaywright) {
      logger.debug('routing to playwright (domain marked)', { url, domain });
      return this.browserOrHttpForBinary(url, domain, { headers, screenshot, conditionalHeaders, signal }, logger);
    }

    // Decide whether to try the TLS-impersonation tier
    // before HTTP. We try TLS-first when:
    //   - WIGOLO_TLS_TIER=on, or
    //   - WIGOLO_TLS_TIER=auto AND the domain has been promoted via repeated
    //     success (prefer_tls_impersonation=1 in domain_routing), or
    //   - the domain is in the curated anti-bot/timeout-prone allowlist
    //     (ANTI_BOT_TLS_DOMAINS or WIGOLO_TLS_DOMAINS) — these time out at the
    //     connection level before returning a status code, so a plain-HTTP
    //     attempt just burns the per-fetch budget. This case applies EVEN when
    //     the global tier is 'off', so the curated set opts in without forcing
    //     TLS-first for everything.
    const tlsMode = config.tlsTier;
    const tlsTierEnabled = tlsMode !== 'off';
    const tlsDomainPreferred = tlsTierEnabled && this.tlsPersistence.getPreferTls(domain);
    const isAntiBotDomain = isAntiBotTlsDomain(domain, config.tlsDomains);
    const tryTlsFirst = tlsMode === 'on' || tlsDomainPreferred || isAntiBotDomain;
    // Whether a TLS retry is permitted at all (TLS-first OR escalation). The
    // anti-bot allowlist enables the tier locally even with the global flag off.
    const tlsUsable = tlsTierEnabled || isAntiBotDomain;

    if (tryTlsFirst) {
      const tlsTry = await this.tryTlsTier(url, domain, headers, signal);
      if (tlsTry.ok) {
        return this.guardChallengeShell(tlsTry.result);
      }
      // TLS failed → fall through to HTTP, then to Playwright if needed.
      logger.debug('tls-first miss, falling back to http', { url, domain, reason: tlsTry.reason });
    }

    // Try HTTP first
    try {
      if (!this.httpClient) throw new Error('SmartRouter: httpClient not configured');
      let result = await this.httpClientFetch(url, { headers, conditionalHeaders, signal });

      // 304 = unchanged: pass through; never escalate to a browser.
      if (result.statusCode === 304) {
        return this.toRawFetchResult(result);
      }

      // A bare 403 (anti-bot status, no challenge body) is sometimes a
      // UA-fingerprint block rather than a hard wall. Before paying the cost of
      // a heavier tier, retry the HTTP fetch EXACTLY ONCE with a rotated
      // desktop User-Agent. If the rotated attempt is no longer blocked, use it;
      // if it is still blocked, fall through with the retried result so the
      // existing escalation ladder runs unchanged. A 403 is NOT a rate-limit, so
      // no backoff window is recorded. Bounded to one retry — no loop.
      // Restricted to a BARE 403 (no challenge markers): a Cloudflare/DataDome
      // challenge-body 403 is a strong wall a UA rotation cannot clear, so it
      // escalates directly without paying for a doomed retry.
      if (result.statusCode === 403 && !isChallengeResponse(result.statusCode, result.html, result.headers)) {
        const rotatedUa = resolveStealthUA();
        const currentUa = headers?.['User-Agent'] ?? config.userAgent;
        if (rotatedUa !== currentUa) {
          logger.debug('bare 403 — retrying once with a rotated user-agent', { url, domain });
          const retried = await this.httpClientFetch(url, {
            headers: { ...headers, 'User-Agent': rotatedUa },
            conditionalHeaders,
            signal,
          });
          if (!isAntiBotSignal(retried.statusCode, retried.html)) {
            logger.debug('rotated user-agent cleared the 403', { url, domain });
            return this.guardChallengeShell(this.toRawFetchResult(retried));
          }
          // Still blocked — carry the retried result into the escalation ladder.
          result = retried;
        }
      }

      // A PDF response is a completed byte-tier result. The HTTP tier returns
      // it with empty html + rawBuffer; without this short-circuit the empty
      // html trips the SPA-shell heuristic below and escalates to the browser,
      // which hard-errors on the download. Recognise it by content-type or
      // magic bytes — extensionless PDFs (arxiv.org/pdf/<id>) land here too.
      if (looksLikePdfResult(result)) {
        logger.debug('http returned a PDF, passing through (no browser escalation)', { url, domain });
        return this.toRawFetchResult(result);
      }

      // A 429 without a challenge body is a rate-limit,
      // not an anti-bot wall. Playwright cannot bypass a rate limit, so
      // escalation just pays the browser cold-start cost. Surface the 429
      // directly so callers (tools/fetch.ts) can map it to a stage error.
      if (isRateLimit(result.statusCode, result.html)) {
        // Park the host in a bounded backoff window so subsequent fetches don't
        // re-hammer it. Honor Retry-After when present; otherwise a default
        // window. A hostile/absurd Retry-After is clamped so a domain is never
        // parked for hours.
        const retryMs = clampBackoffMs(
          parseRetryAfter(result.headers['retry-after'], Date.now()) ?? DEFAULT_BACKOFF_MS,
        );
        try {
          this.clearanceStore.recordBackoff(domain, Date.now() + retryMs);
        } catch {
          // Best-effort — never block the pass-through on a persistence miss.
        }
        logger.debug('rate-limited, backing off', {
          url,
          domain,
          backoffSeconds: Math.round(retryMs / 1000),
        });
        return this.toRawFetchResult(result);
      }

      // Challenge interstitial shell. Some bot walls (DataDome "enable
      // JavaScript" pages) serve the challenge at HTTP 200, which the
      // status-gated anti-bot checks below miss. Escalate exactly as an
      // anti-bot-status response would — TLS first when usable, else the
      // browser (which may clear the challenge within its settle window). This
      // is intentionally NOT a hard fail at the HTTP tier. Restricted to the
      // 2xx-shell case here (markers AND skeleton); status-driven signals stay
      // with the blocks below so a bare 403 with no markers is unaffected.
      const is2xxShell =
        result.statusCode >= 200 && result.statusCode < 300 &&
        isChallengeShell(result.statusCode, result.html);
      if (is2xxShell) {
        if (tlsUsable) {
          const tlsTry = await this.tryTlsTier(url, domain, headers, signal);
          if (tlsTry.ok) {
            return this.guardChallengeShell(tlsTry.result);
          }
        }
        if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
        logger.info('challenge shell at 2xx: escalating to browser', {
          url,
          domain,
          httpStatus: result.statusCode,
          signal: describeAntiBot(result.statusCode, result.html),
        });
        stats.preferPlaywright = true;
        return this.browserFetch(url, {
          headers,
          screenshot,
          signal,
          stealth: stealthForBrowser(config, { antiBotEscalation: true }),
          fallback: this.toRawFetchResult(result),
        });
      }

      // Anti-bot signal (403/503 or challenge body, plus 429 with
      // a challenge body) escalates to the TLS tier first when
      // WIGOLO_TLS_TIER is auto/on; if the TLS tier also fails or isn't
      // installed, fall through to Playwright.
      if (tlsUsable && !tryTlsFirst && isAntiBotSignal(result.statusCode, result.html)) {
        const tlsTry = await this.tryTlsTier(url, domain, headers, signal);
        if (tlsTry.ok) {
          return tlsTry.result;
        }
        if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
        logger.info('anti-bot signal: tls tier failed, escalating to playwright', {
          url,
          domain,
          httpStatus: result.statusCode,
          tlsReason: tlsTry.reason,
        });
        stats.preferPlaywright = true;
        return this.browserFetch(url, {
          headers,
          screenshot,
          signal,
          stealth: stealthForBrowser(config, { antiBotEscalation: true }),
          fallback: this.toRawFetchResult(result),
        });
      }

      // With TLS tier disabled, escalate to Playwright
      // only when we have a STRONG anti-bot signal — a Cloudflare/DataDome
      // challenge body. A bare 403 (or any anti-bot status code without a
      // challenge marker) is NOT enough on its own: an admin endpoint
      // returning a substantive 403 HTML page should pass through as-is.
      // Previously this case was handled implicitly by SPA-shell detection
      // on small challenge bodies, but we now gate that on 2xx-only — so
      // the bot-wall escalation must be made explicit, and the same body-
      // marker check we use elsewhere keeps it from over-firing.
      if (
        !tlsTierEnabled &&
        isAntiBotStatus(result.statusCode) &&
        isChallengeResponse(result.statusCode, result.html, result.headers)
      ) {
        if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
        logger.info('anti-bot challenge: escalating to browser (tls tier disabled)', {
          url,
          domain,
          httpStatus: result.statusCode,
          signal: describeAntiBot(result.statusCode, result.html),
        });
        stats.preferPlaywright = true;
        return this.browserFetch(url, {
          headers,
          screenshot,
          signal,
          stealth: stealthForBrowser(config, { antiBotEscalation: true }),
          fallback: this.toRawFetchResult(result),
        });
      }

      // SPA-shell detection is only meaningful for 2xx
      // responses. A 4xx/5xx body is an error page, not a hydration shell —
      // escalating to Playwright won't recover content the server refuses
      // to ship. Pass non-2xx through; tools/fetch.ts surfaces them as
      // stage errors.
      const status = result.statusCode;
      const isSuccessful = status >= 200 && status < 300;
      if (isSuccessful && contentAppearsEmpty(result.html)) {
        if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
        logger.info('SPA shell detected, marking domain for playwright', { url, domain });
        stats.preferPlaywright = true;
        // Benign SPA render — anti-bot hardening only when the mode is 'on'.
        return this.browserFetch(url, {
          headers,
          screenshot,
          signal,
          stealth: stealthForBrowser(config, { antiBotEscalation: false }),
          fallback: this.toRawFetchResult(result),
        });
      }

      // A known-SPA domain (pre-marked preferPlaywright
      // via KNOWN_SPA_DOMAINS) that returns a substantive HTTP response
      // demonstrates the domain is reachable without a browser. Reset the
      // sticky pre-mark so subsequent requests skip the Playwright cold
      // start. This only resets pre-marks — domains that became
      // preferPlaywright via genuine failure (failureCount threshold OR
      // anti-bot escalation OR SPA-shell detection) are not affected
      // because those code paths return early above without reaching here.
      if (isSuccessful && stats.preferPlaywright && isKnownSpaDomain(domain)) {
        logger.info('known-SPA domain returned substantive HTTP — downgrading prefer-chromium flag', { url, domain });
        stats.preferPlaywright = false;
      }

      // Final HTTP-tier content return. The explicit 2xx-shell escalation above
      // already re-routes challenge interstitials to the browser, but guard the
      // terminal return too so no challenge body can leak to the caller if a
      // future branch reaches here with one.
      return this.guardChallengeShell(this.toRawFetchResult(result));
    } catch (err) {
      stats.failureCount++;
      logger.warn('http fetch failed', {
        url,
        domain,
        failureCount: stats.failureCount,
        error: err instanceof Error ? err.message : String(err),
      });

      // Timeout-as-escalation-signal. Anti-bot content domains (and
      // any domain when the global tier is on) close the connection / time out
      // BEFORE returning a status code, so the response-based escalation above
      // never fires. When the HTTP attempt throws a timeout/connection error
      // AND the TLS tier is usable here AND we have not already tried it first,
      // retry via the TLS tier before giving up. The retry reuses the caller's
      // `signal`, so it draws from the SAME per-fetch deadline rather than
      // adding to it.
      if (tlsUsable && !tryTlsFirst && isConnectionTimeout(err)) {
        const tlsTry = await this.tryTlsTier(url, domain, headers, signal);
        if (tlsTry.ok) {
          logger.info('http timeout escalated to tls tier', { url, domain });
          return tlsTry.result;
        }
        logger.debug('timeout tls escalation miss', { url, domain, reason: tlsTry.reason });
      }

      if (stats.failureCount >= threshold) {
        if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
        logger.info('failure threshold reached, marking domain for playwright', { url, domain, threshold });
        stats.preferPlaywright = true;
        // Repeated plain-HTTP failure is not itself an anti-bot signal —
        // harden only when the mode is 'on'.
        return this.browserFetch(url, {
          headers,
          screenshot,
          signal,
          stealth: stealthForBrowser(config, { antiBotEscalation: false }),
        });
      }

      throw err;
    }
  }

  getDomainStats(domain: string): DomainStats | undefined {
    return this.domainMap.get(domain);
  }

  /**
   * Pre-launch the browser engine so a subsequent fetch that escalates to the
   * browser doesn't pay the cold-start inline. Best-effort and idempotent —
   * a no-op when no browser pool is configured or the pool doesn't support
   * warming. Latency-only; never changes fetch results.
   */
  async prewarmBrowser(): Promise<void> {
    if (this.browserPool?.warm) {
      await this.browserPool.warm();
    }
  }

  private ensureStats(domain: string): DomainStats {
    let stats = this.domainMap.get(domain);
    if (!stats) {
      // Known SPA domains start in `preferPlaywright` so the very first visit
      // skips the HTTP-only round that would otherwise return a nav shell.
      stats = {
        failureCount: 0,
        preferPlaywright: isKnownSpaDomain(domain),
      };
      this.domainMap.set(domain, stats);
    }
    return stats;
  }

  // Exposed for testing — callers should not branch on this.
  /* istanbul ignore next */
  static isKnownSpaDomain(host: string): boolean {
    return isKnownSpaDomain(host);
  }

  private toRawFetchResult(
    result: Awaited<ReturnType<HttpClient['fetch']>>,
  ): RawFetchResult {
    return {
      url: result.url,
      finalUrl: result.finalUrl,
      html: result.html,
      contentType: result.contentType,
      statusCode: result.statusCode,
      method: 'http',
      headers: result.headers,
      rawBuffer: result.rawBuffer,
    };
  }

  /**
   * When `host` is inside an active rate-limit backoff window, returns a
   * synthetic 429 result WITHOUT touching the origin — a 429 is the origin
   * rate-limiting us, so re-hammering it (even via stealth/force_refresh) does
   * not help and is impolite. The plain-text body carries no challenge markers,
   * so it maps to `http_429` downstream exactly as a real pass-through 429 does.
   * Returns null when there is no active window (null or expired) so the caller
   * fetches normally — no false positives.
   */
  private backoffWindowResult(url: string, host: string): RawFetchResult | null {
    let backoffUntil: number | null;
    try {
      backoffUntil = this.clearanceStore.getBackoff(host);
    } catch {
      backoffUntil = null;
    }
    if (backoffUntil == null || Date.now() >= backoffUntil) return null;
    return {
      url,
      finalUrl: url,
      html: `host is in a rate-limit backoff window; retry after ${new Date(backoffUntil).toISOString()}`,
      contentType: 'text/plain',
      statusCode: 429,
      method: 'http',
      headers: { 'retry-after': String(Math.ceil((backoffUntil - Date.now()) / 1000)) },
    };
  }

  // --- TLS-impersonation tier helpers ---

  /**
   * Attempt the TLS-impersonation tier for `url`. Returns:
   *  - { ok: true, result } when the tier completed AND the response does
   *    not look like a still-blocking challenge / JS-required page
   *  - { ok: false, reason } when the tier is unavailable (missing native
   *    binary, network error) OR the response still looks anti-bot / JS-
   *    required so the router should escalate to Playwright.
   *
   * Records success against the domain on every healthy response. The
   * `prefer_tls_impersonation` flip is performed by the persistence layer
   * once the success threshold is reached.
   */
  private async tryTlsTier(
    url: string,
    domain: string,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ ok: true; result: RawFetchResult } | { ok: false; reason: 'unavailable' | 'still_blocked' | 'js_required' | 'error'; error?: unknown }>
  {
    const logger = createLogger('fetch');
    // Best-effort cross-tier reuse: a stored clearance for this host is injected
    // as a Cookie header (any minting UA is allowed for the header tiers). A
    // different JA3 may still be re-challenged — that surfaces as an anti-bot
    // signal below and escalates normally.
    const tlsHeaders = this.withClearanceHeader(domain, 'tls', headers);
    let r: TlsFetchResult;
    try {
      r = await this.tlsFetcher(url, { headers: tlsHeaders, signal });
    } catch (err) {
      if (err instanceof TlsTierUnavailableError) {
        logger.debug('tls tier unavailable, escalating', { url, domain });
        return { ok: false, reason: 'unavailable', error: err };
      }
      logger.warn('tls tier error, escalating', {
        url,
        domain,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason: 'error', error: err };
    }

    // A PDF from the TLS tier is a completed byte result: empty html + rawBuffer.
    // Return it before the js-required check, which would otherwise treat the
    // empty html as a "please enable JS" shell (looksJsRequired('') is true) and
    // escalate to the browser — where the PDF download hard-errors.
    if (looksLikePdfResult(r)) {
      try {
        this.tlsPersistence.recordSuccess(domain);
      } catch {
        // Persistence is best-effort — never block a successful fetch.
      }
      return {
        ok: true,
        result: {
          url: r.url,
          finalUrl: r.finalUrl,
          html: r.html,
          contentType: r.contentType,
          statusCode: r.statusCode,
          method: 'tls-impersonation',
          headers: r.headers,
          rawBuffer: r.rawBuffer,
        },
      };
    }

    if (isAntiBotSignal(r.statusCode, r.html)) {
      // Re-validation: if we injected a reused clearance and it STILL tripped
      // the anti-bot wall, the stored clearance is dead for this tier — purge it
      // so it isn't replayed, then escalate normally.
      if (tlsHeaders !== headers) {
        try { this.clearanceStore.clear(domain); } catch { /* best-effort */ }
      }
      logger.info('tls tier returned anti-bot signal, escalating to playwright', {
        url,
        domain,
        statusCode: r.statusCode,
        signal: describeAntiBot(r.statusCode, r.html),
      });
      return { ok: false, reason: 'still_blocked' };
    }
    if (looksJsRequired(r.html) && r.html.length < 2000) {
      // "Please enable JS" with tiny body → page is asking for a browser.
      logger.info('tls tier landed on JS-required page, escalating', { url, domain });
      return { ok: false, reason: 'js_required' };
    }

    // Healthy response. Record the success so future visits can prefer TLS.
    try {
      this.tlsPersistence.recordSuccess(domain);
    } catch {
      // Persistence is best-effort — never block a successful fetch.
    }

    return {
      ok: true,
      result: {
        url: r.url,
        finalUrl: r.finalUrl,
        html: r.html,
        contentType: r.contentType,
        statusCode: r.statusCode,
        method: 'tls-impersonation',
        headers: r.headers,
        rawBuffer: r.rawBuffer,
      },
    };
  }
}

/**
 * Default persistence wires straight to the cache store. Created lazily by
 * the SmartRouter constructor so tests that never touch the DB never
 * trigger a `getDatabase()` call.
 */
function defaultClearanceStore(): ClearanceStore {
  return {
    get(host) {
      try {
        return getDomainClearance(host);
      } catch {
        return null;
      }
    },
    clear(host) {
      try {
        clearDomainClearance(host);
      } catch {
        // Best-effort — swallow.
      }
    },
    getBackoff(host) {
      try {
        return getBackoff(host);
      } catch {
        return null;
      }
    },
    recordBackoff(host, untilEpochMs) {
      try {
        recordBackoff(host, untilEpochMs);
      } catch {
        // Best-effort — swallow.
      }
    },
  };
}

function defaultTlsPersistence(): TlsRoutingPersistence {
  return {
    getPreferTls(domain) {
      try {
        const row = getDomainRouting(domain);
        return row?.preferTlsImpersonation ?? false;
      } catch {
        return false;
      }
    },
    recordSuccess(domain) {
      try {
        recordTlsImpersonationSuccess(domain, getConfig().tlsSuccessThreshold);
      } catch {
        // Best-effort — swallow.
      }
    },
  };
}
