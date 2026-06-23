import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { contentAppearsEmpty } from './content-check.js';
import { getAuthOptions } from './auth.js';
import { fetchWithPlaywright, shouldEscalate } from './playwright-tier.js';
import { describeFetchError } from './error-describe.js';
import {
  tlsFetch,
  isAntiBotSignal,
  isAntiBotStatus,
  isRateLimit,
  hasChallengeBody,
  looksJsRequired,
  describeAntiBot,
  TlsTierUnavailableError,
  type TlsFetchResult,
} from './tls-tier.js';
import {
  getDomainRouting,
  recordTlsImpersonationSuccess,
} from '../cache/store.js';
import type { RawFetchResult, BrowserAction, Mode, StageError } from '../types.js';
import { guardNavigation, type NavSource } from '../security/ssrf.js';

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

// Wave-2 W4: known anti-bot, connection-timeout-prone CONTENT domains. These
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
  /**
   * Who initiated this fetch (P6-a exfil guard). 'agent' (default, fail-closed) blocks
   * loopback/RFC1918; 'human' (CLI/REPL entry, where the person typed the URL) may reach a
   * local dev server. Cloud-metadata / link-local is blocked for BOTH. Machine-discovered URLs
   * (research/agent/find_similar) keep the 'agent' default.
   */
  source?: NavSource;
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

export interface BrowserPoolInterface {
  fetchWithBrowser(
    url: string,
    options?: { headers?: Record<string, string>; storageStatePath?: string; userDataDir?: string; screenshot?: boolean; actions?: BrowserAction[]; cdpUrl?: string; signal?: AbortSignal },
  ): Promise<RawFetchResult>;
}

export type HttpFetcher = (
  url: string,
  options?: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
) => Promise<{ url: string; html: string; text: string }>;

export type PlaywrightFetcher = (
  url: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<{ html: string; text: string }>;

/**
 * Slice D2: injectable TLS-impersonation fetcher. Same shape as `tlsFetch`
 * from tls-tier.ts; left injectable so unit tests can stub without touching
 * the wreq-js native binary.
 */
export type TlsFetcher = (
  url: string,
  options?: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
) => Promise<TlsFetchResult>;

/** Pluggable hooks to learning/persistence layer so router tests don't need a DB. */
export interface TlsRoutingPersistence {
  getPreferTls(domain: string): boolean;
  recordSuccess(domain: string): void;
}

export interface SmartRouterOptions {
  httpClient?: HttpClient;
  browserPool?: BrowserPoolInterface;
  httpFetcher?: HttpFetcher;
  playwrightFetcher?: PlaywrightFetcher;
  /** Slice D2 — when provided, overrides the default lazy-loaded wreq backend. */
  tlsFetcher?: TlsFetcher;
  /** Slice D2 — persistence for `prefer_tls_impersonation` learning. */
  tlsPersistence?: TlsRoutingPersistence;
}

interface DomainStats {
  failureCount: number;
  preferPlaywright: boolean;
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
 * Wave-2 W4: a domain is in the anti-bot TLS-first set when it is in the
 * built-in {@link ANTI_BOT_TLS_DOMAINS} list OR the operator-supplied
 * WIGOLO_TLS_DOMAINS list. Both match the host exactly or as a subdomain.
 */
function isAntiBotTlsDomain(host: string, extra: readonly string[]): boolean {
  return matchesDomainSet(host, ANTI_BOT_TLS_DOMAINS) || matchesDomainSet(host, extra);
}

/**
 * Slice C/3 (FIX2): public predicate over a full URL. True when the URL's host
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

// Wave-2 W4: connection-level timeout / reset errors that surface as a THROW
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
        'tlsPersistence' in httpClientOrOptions)
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
      return;
    } else {
      // Backwards-compat: single HttpClient positional (unusual but safe)
      this.httpClient = httpClientOrOptions as HttpClient;
    }
    this.httpFetcher = this.makeDefaultHttpFetcher();
    this.playwrightFetcher = fetchWithPlaywright;
    this.tlsFetcher = tlsFetch;
    this.tlsPersistence = defaultTlsPersistence();
  }

  private makeDefaultHttpFetcher(): HttpFetcher {
    return async (url, opts) => {
      if (!this.httpClient) {
        throw new Error('SmartRouter: httpClient not configured');
      }
      const r = await this.httpClient.fetch(url, opts);
      return { url: r.url, html: r.html, text: '' };
    };
  }

  async fetch(url: string, options: RouterFetchOptions & { mode: 'stealth' }): Promise<RawFetchResult | StageError>;
  async fetch(url: string, options?: RouterFetchOptions): Promise<RawFetchResult>;
  async fetch(
    url: string,
    options: RouterFetchOptions = {},
  ): Promise<RawFetchResult | StageError> {
    const { renderJs = 'auto', useAuth = false, headers, screenshot, actions, mode, conditionalHeaders, signal, source = 'agent' } = options;

    // P6-a exfil guard — runs before ANY fetcher (HTTP / TLS / browser), so a blocked target
    // never touches the network. Source-aware: agent blocks loopback/RFC1918 by default; human
    // (CLI/REPL) may reach a local dev server; cloud-metadata / link-local is blocked for both.
    // Redirect HOPS are re-validated in http-client.ts under the same source.
    const navVerdict = guardNavigation(url, { source, allowLoopback: true });
    if (!navVerdict.ok) {
      return {
        error: 'navigation_blocked',
        error_reason:
          navVerdict.code === 'blocked'
            ? `Blocked ${source}-initiated navigation to a non-public address: ${navVerdict.host ?? url}`
            : `Invalid navigation target (${navVerdict.code}): ${url}`,
        stage: 'fetch',
        hint:
          source === 'agent'
            ? 'Cloud-internal/metadata is never reachable; localhost/private addresses require a human-initiated request.'
            : 'The address is not a navigable public/local target.',
      };
    }

    const config = getConfig();
    const logger = createLogger('fetch');
    const threshold = config.browserFallbackThreshold;
    const domain = new URL(url).hostname;

    // Stealth mode: static fetch first, escalate to Playwright when content is thin.
    if (mode === 'stealth') {
      logger.debug('routing to stealth (static then escalate)', { url });
      const staticResult = await this.httpFetcher(url, { headers, signal });
      this.ensureStats(domain);
      if (!shouldEscalate(staticResult.text)) {
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
      try {
        const pw = await this.playwrightFetcher(url, { signal });
        return {
          url: staticResult.url,
          finalUrl: staticResult.url,
          html: pw.html,
          contentType: 'text/html',
          statusCode: 200,
          method: 'playwright',
          headers: {},
          escalated: true,
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
      const result = await this.httpClient.fetch(url, {
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
      return this.browserPool.fetchWithBrowser(url, { headers, screenshot, actions, ...authOptions, signal });
    }

    // Always Playwright for auth or explicit override
    if (renderJs === 'always' || useAuth) {
      if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
      const authOptions = useAuth ? (await getAuthOptions() ?? {}) : {};
      logger.debug('routing to playwright', { url, reason: useAuth ? 'auth' : 'render_js=always' });
      return this.browserPool.fetchWithBrowser(url, { headers, screenshot, ...authOptions, signal });
    }

    // HTTP only, no fallback
    if (renderJs === 'never') {
      if (!this.httpClient) throw new Error('SmartRouter: httpClient not configured');
      logger.debug('routing to http (never)', { url });
      const result = await this.httpClient.fetch(url, { headers, conditionalHeaders, signal });
      const neverStats = this.ensureStats(domain);
      // Slice 5 (audit H4): a known-SPA domain that returns substantive
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
      return this.toRawFetchResult(result);
    }

    // auto: check if domain is already marked for Playwright
    const stats = this.ensureStats(domain);

    if (stats.preferPlaywright) {
      if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
      logger.debug('routing to playwright (domain marked)', { url, domain });
      return this.browserPool.fetchWithBrowser(url, { headers, screenshot, signal });
    }

    // Slice D2 + Wave-2 W4: decide whether to try the TLS-impersonation tier
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
        return tlsTry.result;
      }
      // TLS failed → fall through to HTTP, then to Playwright if needed.
      logger.debug('tls-first miss, falling back to http', { url, domain, reason: tlsTry.reason });
    }

    // Try HTTP first
    try {
      if (!this.httpClient) throw new Error('SmartRouter: httpClient not configured');
      const result = await this.httpClient.fetch(url, { headers, conditionalHeaders, signal });

      // 304 = unchanged: pass through; never escalate to a browser.
      if (result.statusCode === 304) {
        return this.toRawFetchResult(result);
      }

      // Slice 5 (audit H4): a 429 without a challenge body is a rate-limit,
      // not an anti-bot wall. Playwright cannot bypass a rate limit, so
      // escalation just pays the browser cold-start cost. Surface the 429
      // directly so callers (tools/fetch.ts) can map it to a stage error.
      if (isRateLimit(result.statusCode, result.html)) {
        logger.debug('rate-limit (429) without challenge body — passing through, NOT escalating', { url, domain });
        return this.toRawFetchResult(result);
      }

      // Slice D2: anti-bot signal (403/503 or challenge body, plus 429 with
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
        return this.browserPool.fetchWithBrowser(url, { headers, screenshot, signal });
      }

      // Slice 5 (audit H4): with TLS tier disabled, escalate to Playwright
      // only when we have a STRONG anti-bot signal — a Cloudflare/DataDome
      // challenge body. A bare 403 (or any anti-bot status code without a
      // challenge marker) is NOT enough on its own: an admin endpoint
      // returning a substantive 403 HTML page should pass through as-is.
      // Previously this case was handled implicitly by SPA-shell detection
      // on small challenge bodies, but we now gate that on 2xx-only — so
      // the bot-wall escalation must be made explicit, and the same body-
      // marker check we use elsewhere keeps it from over-firing.
      if (!tlsTierEnabled && hasChallengeBody(result.html) && isAntiBotStatus(result.statusCode)) {
        if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
        logger.info('anti-bot challenge body: escalating to playwright (tls tier disabled)', {
          url,
          domain,
          httpStatus: result.statusCode,
          signal: describeAntiBot(result.statusCode, result.html),
        });
        stats.preferPlaywright = true;
        return this.browserPool.fetchWithBrowser(url, { headers, screenshot, signal });
      }

      // Slice 5 (audit H4): SPA-shell detection is only meaningful for 2xx
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
        return this.browserPool.fetchWithBrowser(url, { headers, screenshot, signal });
      }

      // Slice 5 (audit H4): a known-SPA domain (pre-marked preferPlaywright
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

      return this.toRawFetchResult(result);
    } catch (err) {
      stats.failureCount++;
      logger.warn('http fetch failed', {
        url,
        domain,
        failureCount: stats.failureCount,
        error: err instanceof Error ? err.message : String(err),
      });

      // Wave-2 W4: timeout-as-escalation-signal. Anti-bot content domains (and
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
        return this.browserPool.fetchWithBrowser(url, { headers, screenshot, signal });
      }

      throw err;
    }
  }

  getDomainStats(domain: string): DomainStats | undefined {
    return this.domainMap.get(domain);
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

  // --- Slice D2: TLS-impersonation tier helpers ---

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
    let r: TlsFetchResult;
    try {
      r = await this.tlsFetcher(url, { headers, signal });
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

    if (isAntiBotSignal(r.statusCode, r.html)) {
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
