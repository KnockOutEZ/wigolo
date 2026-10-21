import { chromium, firefox, webkit, type Browser, type BrowserContext, type Download } from 'playwright';
import { readFile } from 'node:fs/promises';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { BrowserSelector, type SelectionStrategy } from './browser-selector.js';
import { executeActions } from './action-executor.js';
import { abortRejection } from '../util/abort.js';
import { settlePage, toCompleteness } from './settle.js';
import { DOM_VERDICT_SOURCE, type DomVerdict } from './hydration-probe.js';
import type { ContentCompleteness } from '../types.js';
import { sanitizedChildEnv } from '../util/child-env.js';
import { playwrightProxyOption } from './proxy-credentials.js';
import { redactUrl } from '../util/redact-url.js';
import { isAntiBotStatus, hasBrowserChallengeBody, isChallengeShell, isChallengeResponse, stillShowingChallenge, hasChallengeHeader, isNearEmptyBody } from './tls-tier.js';
import { pollUntilCleared, type ClearanceCookie } from './challenge-completion.js';
import { classifyChallenge, classifyImageSubType } from './challenge-classify.js';
import { runSolveLadder, type SolveLadderResult } from './solve-ladder.js';
import { autoPassChallenge } from './auto-pass.js';
import { aiSolveChallenge, type ImageSolveSubType, type WidgetImage } from './ai-solve.js';
import { humanSolveChallenge } from './human-solve.js';
import { connectScrapingBrowser } from './scraping-browser.js';
import { cdpDirectFetch } from './cdp-direct.js';
import { resolveStealthUA, stealthLaunchArgs, stealthContextOptions, parseChromeMajor, resolveStealthLauncher, recordLaunchedChromeMajor, STEALTH_INIT_SCRIPT } from './stealth.js';
import { humanizePage } from './behavior.js';
import { recordDomainClearance, clearDomainClearance } from '../cache/store.js';
import { CLEARANCE_COOKIE_NAME, clearanceExpiresIso } from './clearance-reuse.js';
import { guardResolvedHost } from '../watch/ssrf.js';
import type { RawFetchResult, BrowserType, ActionResult, BrowserAction, ChallengeClass, SolveMethod } from '../types.js';

/**
 * Host of a fetched URL, or null on a malformed URL. Used to key the anti-bot
 * clearance store (RAW hostname, matching domain_routing).
 */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * The UA a non-stealth (pooled/CDP) context actually advertises, read from the
 * live page. Only needed when persisting a clearance minted off the stealth
 * path (where the UA is already known). Returns null when the page can't be
 * evaluated (unit-test stubs), so persistence is skipped rather than recording
 * a UA that doesn't match what the tier presents.
 */
async function readAdvertisedUa(page: { evaluate?: unknown }): Promise<string | null> {
  if (typeof page.evaluate !== 'function') return null;
  try {
    const ua = await (page as { evaluate: (fn: () => string) => Promise<string> })
      .evaluate(() => navigator.userAgent);
    return typeof ua === 'string' && ua.length > 0 ? ua : null;
  } catch {
    return null;
  }
}

/**
 * Extract the cf_clearance cookie (value + expiry) from a cookie list harvested
 * by a solve rung, so a ladder-cleared challenge persists its clearance exactly
 * like the auto-poll pass path. Returns null when no clearance cookie is present.
 */
function findCfClearance(cookies: ClearanceCookie[]): { value: string; expires: number } | null {
  const c = cookies.find((k) => k.name === CLEARANCE_COOKIE_NAME && k.value.length > 0);
  return c ? { value: c.value, expires: c.expires } : null;
}

/**
 * Per-selector budget for a challenge-widget probe. The widget is already
 * painted when the solve ladder runs, so a hit resolves immediately; this bounds
 * the MISS. Must stay far under the browser engine's 30s actionability default —
 * an unbounded probe across the selector list costs minutes per blocked fetch.
 */
export const WIDGET_LOCATE_TIMEOUT_MS = 400;

/** Same-document widget selectors (Turnstile is not in an iframe). */
const WIDGET_DOC_SELECTORS = ['.cf-turnstile', '#challenge-form', 'input[type="checkbox"]'] as const;

/** Cross-origin checkbox iframes (reCAPTCHA anchor / hCaptcha checkbox). */
const WIDGET_FRAME_SELECTORS = [
  'iframe[src*="api2/anchor"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[title*="challenge" i]',
] as const;

/** How many selectors a total miss pays for. Exported so the budget contract is
 *  assertable without reaching into the private locator. */
/** Cross-origin frames a vision solve drives into, most specific first. */
const CHALLENGE_FRAME_SELECTORS = [
  'iframe[src*="api2/bframe"]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[title*="challenge" i]',
] as const;

export const WIDGET_LOCATE_SELECTOR_COUNT =
  WIDGET_DOC_SELECTORS.length + WIDGET_FRAME_SELECTORS.length;

/**
 * Thrown when the browser tier lands on a hard bot-protection challenge page
 * that does not clear within the settle window. Carries a structured code so
 * the router can map it to a `blocked_by_challenge` stage error instead of
 * hanging on the full navigation timeout. Message + hint use capability
 * language (never vendor internals).
 */
export class ChallengeBlockedError extends Error {
  readonly code = 'blocked_by_challenge' as const;
  readonly hint: string;
  /**
   * The underlying anti-bot HTTP status (403/429/503) that triggered the
   * challenge, when one is known. Threaded onto the router's stage error as
   * `http_status` so a hard challenge-block reaches the crawl adaptive-cooldown
   * (which only saw bare 403/429 before). Undefined when no reliable status
   * exists (e.g. a goto-timeout, or a 2xx interstitial shell) — never invented.
   */
  readonly httpStatus?: number;
  /**
   * Provenance the solve ladder threads onto the honest blocked path: the coarse
   * challenge class the classifier assigned, and the solve method (always
   * `null` on a block — no rung cleared it). The router copies these onto the
   * `blocked_by_challenge` stage error so the fetch result carries them.
   * Optional so the existing positional throws (goto-timeout, near-empty body)
   * still construct without them.
   */
  challengeClass?: ChallengeClass;
  solveMethod?: SolveMethod | null;
  constructor(
    public readonly targetUrl: string,
    message = "The site's bot protection served a challenge page that could not be cleared automatically",
    hint = 'Retry with use_auth: true using a real browser session, or fetch an alternate source for this content',
    httpStatus?: number,
    provenance?: { challengeClass?: ChallengeClass; solveMethod?: SolveMethod | null },
  ) {
    super(message);
    this.name = 'ChallengeBlockedError';
    this.hint = hint;
    this.httpStatus = httpStatus;
    this.challengeClass = provenance?.challengeClass;
    this.solveMethod = provenance?.solveMethod ?? null;
  }
}

export interface BrowserFetchOptions {
  timeoutMs?: number;
  storageStatePath?: string;
  userDataDir?: string;
  headers?: Record<string, string>;
  screenshot?: boolean;
  actions?: BrowserAction[];
  cdpUrl?: string;
  browserType?: BrowserType;
  signal?: AbortSignal;
  /**
   * When true, the fetch uses a DEDICATED per-fetch context with anti-bot
   * fingerprint hardening (a distinct UA + locale/timezone + an init script
   * that patches high-signal automation leaks), closed at end-of-fetch rather
   * than returned to the shared pool. Bounded by a separate semaphore so N
   * concurrent hardened fetches cannot exceed the browser cap. Ignored for the
   * CDP path (an external browser owns its own fingerprint).
   */
  stealth?: boolean;
  /**
   * Anti-bot clearance cookies to seed into the context BEFORE navigation
   * (S-A2 reuse). Each is applied via `context.addCookies(...)` scoped to its
   * own host, so it is dropped on any cross-host redirect hop. The router
   * populates this from a stored, unexpired, UA-matching clearance so a solved
   * challenge is replayed instead of re-solved.
   */
  injectedCookies?: Array<{ name: string; value: string; domain: string; path?: string }>;
  /**
   * Force a direct (no-proxy) launch for THIS fetch even when a proxy is
   * configured. Used by the router's managed-challenge direct-retry: a
   * datacenter proxy converts many managed challenges into blocks, so one
   * proxy-free browser attempt is made before returning blocked_by_challenge.
   * Only affects the dedicated stealth launch path (the escalation target).
   */
  forceNoProxy?: boolean;
  /**
   * Explicitly force the human-like INTERACTION pass on (true) or off (false)
   * for THIS fetch, overriding the config-derived default. When omitted, the
   * pool derives engagement from config: engage when `humanize === 'on'`, or
   * `humanize === 'auto' && stealth === true` (the escalation path). A benign
   * non-stealth fetch under the default `auto` performs NO interaction. The
   * router may later pass an explicit flag; today it is derived here.
   */
  humanize?: boolean;
}

export interface BrowserPoolOptions {
  browserType?: BrowserType;
}

export interface MultiBrowserPoolOptions {
  browserTypes?: BrowserType[];
  selectionStrategy?: SelectionStrategy;
}

export interface PoolTypeStat {
  type: BrowserType;
  activeCount: number;
  pooledCount: number;
}

const log = createLogger('fetch');

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

const NAV_RACE_PATTERN = /execution context (?:was )?destroyed|page is navigating|frame.*detached|target closed/i;
// Chromium rejects page.goto with this when the response is a download
// (e.g. a PDF served with content-type application/pdf).
const DOWNLOAD_START_PATTERN = /download is starting/i;
// How long to wait for a `download` event when goto rejects with "Download is
// starting" before the event handler captured it (an async race). Short — the
// download has already begun, so the event is imminent.
const DOWNLOAD_EVENT_WAIT_MS = 3000;

// Read a captured Playwright download into a Buffer, bounded by the caller's
// abort signal. Returns null when the bytes cannot be read.
async function readDownloadBuffer(
  download: Download,
  url: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  try {
    const path = await Promise.race([
      download.path(),
      abortRejection(signal),
    ]);
    if (!path) return null;
    return await Promise.race([
      readFile(path),
      abortRejection(signal),
    ]);
  } catch (err) {
    log.warn('failed to read intercepted download', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function readContentWithRetry(
  page: import('playwright').Page,
  url: string,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.content();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!NAV_RACE_PATTERN.test(msg) || attempt === 2) throw err;
      log.debug('page.content hit navigation race, retrying', { url, attempt, msg });
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return await page.content();
}

function getLauncher(type: BrowserType) {
  switch (type) {
    case 'firefox': return firefox;
    case 'webkit': return webkit;
    default: return chromium;
  }
}

interface TypePool {
  browser: Browser | null;
  pool: BrowserContext[];
  activeCount: number;
  waitQueue: Array<(ctx: BrowserContext) => void>;
  idleTimers: Map<BrowserContext, ReturnType<typeof setTimeout>>;
}

export class MultiBrowserPool {
  private readonly pools = new Map<BrowserType, TypePool>();
  private readonly selector: BrowserSelector;
  private readonly configuredTypes: BrowserType[];
  private shutdownCalled = false;
  // Bounded semaphore for the DEDICATED stealth path. That path launches its
  // own throwaway browser + context, bypassing the pooled activeCount/maxBrowsers
  // accounting — so without this a burst of stealth fetches could spawn one
  // browser per fetch and blow past the cap. Mirrors the acquire/release
  // activeCount + waitQueue pattern: a stealth fetch acquires a slot before
  // launching and releases it after close.
  private stealthActive = 0;
  private readonly stealthWaitQueue: Array<() => void> = [];
  // Cached outcome of the ONE-per-process authentic-browser probe on the
  // dedicated stealth path (T1-A). 'chrome' means an installed browser launched
  // successfully; 'bundled' means we fell back (or were forced) to the bundled
  // browser engine. null = not probed yet. Caching avoids paying the failed
  // channel:'chrome' launch cost on every stealth fetch. Chromium-only — the
  // authentic-channel concept does not apply to firefox/webkit.
  private resolvedStealthChannel: 'chrome' | 'bundled' | null = null;
  // Cached outcome of the hardened-driver LAUNCH probe. 'standard' means the
  // optional hardened driver imported but could not launch on this machine, so
  // we stop reaching for it. null = not yet demoted.
  private resolvedStealthDriver: 'standard' | null = null;

  constructor(options?: MultiBrowserPoolOptions) {
    let types = options?.browserTypes ?? ['chromium'];
    if (types.length === 0) {
      log.warn('empty browserTypes, defaulting to chromium');
      types = ['chromium'];
    }
    this.configuredTypes = [...types];
    this.selector = new BrowserSelector(types, options?.selectionStrategy ?? 'round-robin');

    for (const type of types) {
      this.pools.set(type, {
        browser: null,
        pool: [],
        activeCount: 0,
        waitQueue: [],
        idleTimers: new Map(),
      });
    }

    log.info('multi-browser pool initialized', {
      types: this.configuredTypes,
      strategy: options?.selectionStrategy ?? 'round-robin',
    });
  }

  getConfiguredTypes(): BrowserType[] {
    return [...this.configuredTypes];
  }

  getStats(): PoolTypeStat[] {
    return this.configuredTypes.map(type => {
      const p = this.pools.get(type)!;
      return {
        type,
        activeCount: p.activeCount,
        pooledCount: p.pool.length,
      };
    });
  }

  protected resolveType(requested?: BrowserType, url?: string): BrowserType {
    if (requested && this.pools.has(requested)) {
      return requested;
    }
    if (requested && !this.pools.has(requested)) {
      log.warn('requested browser type not configured, falling back', {
        requested,
        available: this.configuredTypes,
      });
      return this.configuredTypes[0];
    }
    // For hostname-hash strategy, use the URL hostname for deterministic selection
    if (url && this.selector.getStrategy() === 'hostname-hash') {
      try {
        const hostname = new URL(url).hostname;
        return this.selector.selectForHostname(hostname);
      } catch {
        return this.selector.select();
      }
    }
    return this.selector.select();
  }

  private async launchBrowser(type: BrowserType): Promise<Browser> {
    const typePool = this.pools.get(type)!;
    if (!typePool.browser) {
      const launcher = getLauncher(type);
      const cfg = getConfig();
      const proxy = playwrightProxyOption(cfg.proxyUrl, cfg.useProxy);
      log.debug('launching browser', { type, proxied: proxy !== undefined });
      typePool.browser = await launcher.launch({
        headless: true,
        env: sanitizedChildEnv({ stripProxy: true }),
        ...(proxy ? { proxy } : {}),
      });
    }
    return typePool.browser;
  }

  /**
   * Pre-launch the browser engine for the default (first configured) type so a
   * later fetch does not pay the browser cold-start inline. Idempotent — a
   * no-op when the browser is already launched — and best-effort: a launch
   * failure is swallowed (the lazy path on first fetch surfaces it honestly).
   * Latency-only; does not touch the context pool, so it never disturbs
   * in-flight fetches, downloads, or the idle-eviction bookkeeping.
   */
  async warm(): Promise<void> {
    if (this.shutdownCalled) return;
    const type = this.configuredTypes[0];
    const typePool = this.pools.get(type);
    if (!typePool || typePool.browser) return; // already warm
    try {
      await this.launchBrowser(type);
    } catch (err) {
      log.debug('browser prewarm skipped', {
        type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  protected async acquireForType(type: BrowserType): Promise<BrowserContext> {
    const config = getConfig();
    const maxBrowsers = config.maxBrowsers;
    const typePool = this.pools.get(type)!;

    if (typePool.pool.length > 0) {
      const ctx = typePool.pool.pop()!;
      const timer = typePool.idleTimers.get(ctx);
      if (timer !== undefined) {
        clearTimeout(timer);
        typePool.idleTimers.delete(ctx);
      }
      return ctx;
    }

    if (typePool.activeCount < maxBrowsers) {
      typePool.activeCount++;
      const browser = await this.launchBrowser(type);
      // acceptDownloads lets a PDF (or other binary) response be captured as a
      // download rather than triggering an unhandled navigation error. Harmless
      // for normal navigations — no download event fires.
      return browser.newContext({ acceptDownloads: true });
    }

    return new Promise<BrowserContext>((resolve) => {
      typePool.waitQueue.push(resolve);
    });
  }

  protected releaseForType(type: BrowserType, ctx: BrowserContext): void {
    const config = getConfig();
    const idleTimeoutMs = config.browserIdleTimeoutMs;
    const typePool = this.pools.get(type)!;

    if (typePool.waitQueue.length > 0) {
      const resolve = typePool.waitQueue.shift()!;
      resolve(ctx);
      return;
    }

    typePool.pool.push(ctx);

    const timer = setTimeout(() => {
      const idx = typePool.pool.indexOf(ctx);
      if (idx !== -1) {
        typePool.pool.splice(idx, 1);
        typePool.idleTimers.delete(ctx);
        typePool.activeCount = Math.max(0, typePool.activeCount - 1);
        ctx.close().catch(() => {});
      }
    }, idleTimeoutMs);

    typePool.idleTimers.set(ctx, timer);
  }

  // Acquire a dedicated-stealth concurrency slot. Resolves immediately when a
  // slot is free, otherwise queues until a release frees one. Default limit is
  // config.maxBrowsers so the hardened path shares the same overall cap as the
  // pooled path.
  private acquireStealthSlot(): Promise<void> {
    const limit = getConfig().maxBrowsers;
    if (this.stealthActive < limit) {
      this.stealthActive++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.stealthWaitQueue.push(resolve);
    });
  }

  // Release a dedicated-stealth slot. Hands the slot straight to the next
  // waiter when one is queued (keeping stealthActive at the cap), otherwise
  // decrements the active count.
  private releaseStealthSlot(): void {
    const next = this.stealthWaitQueue.shift();
    if (next) {
      next();
      return;
    }
    this.stealthActive = Math.max(0, this.stealthActive - 1);
  }

  /**
   * Launch the DEDICATED stealth browser (T1-A + T1-B). Prefers an authentic
   * installed browser (real TLS + version) via the browser engine's `chrome`
   * channel and falls back to the bundled engine when none is installed
   * (channel launch throws → relaunch without it). The probe outcome is cached
   * for the process so a machine without an installed browser does not repay
   * the failed-launch cost on every stealth fetch. Headless-by-default uses the
   * engine's windowless headless mode (headful-grade fingerprint, no visible
   * window); `browserHeadful` opts into a true visible window.
   *
   * Chromium-only for the authentic-channel path — the concept does not apply
   * to firefox/webkit, which always launch bundled. Returns the launched
   * browser; the caller owns closing it.
   *
   * Driver selection (T2-E): on chromium, when `stealthDriver` is auto/patchright
   * and the optional driver-hardened launcher is present, that launcher replaces
   * the standard one — it patches the CDP `Runtime.enable`-class automation leak
   * at the driver level. It accepts the SAME launch options (incl. channel:
   * 'chrome'), so the authentic-channel probe + headful + graceful fallback below
   * apply on top unchanged — patched driver + real installed Chrome combine. The
   * optional dep absent (or `stealthDriver: 'playwright'`, or firefox/webkit)
   * falls back to the standard launcher silently.
   */
  private async launchDedicatedStealthBrowser(type: BrowserType, forceNoProxy = false): Promise<Browser> {
    const cfg = getConfig();
    const standard = getLauncher(type);
    // `resolveStealthLauncher` proves the hardened driver IMPORTS — never that
    // it can LAUNCH. It resolves a browser revision it neither installs nor
    // owns, so a version skew between it and the standard driver leaves a
    // launcher that loads fine and then fails on every launch. Without a
    // launch-time fallback that hard-fails every anti-bot fetch, silently. Once
    // we learn it cannot launch on this machine we stop reaching for it.
    const hardened =
      this.resolvedStealthDriver === 'standard'
        ? standard
        : await resolveStealthLauncher(type, cfg.stealthDriver, standard);
    const usingHardened = hardened !== standard;
    // A managed-challenge direct-retry forces a proxy-free launch even when a
    // proxy is configured (a datacenter proxy blocks many managed challenges).
    const proxy = forceNoProxy ? undefined : playwrightProxyOption(cfg.proxyUrl, cfg.useProxy);
    // headless:false = a real visible window (opt-in). Default headless:true is
    // the engine's windowless new headless — headful-grade fingerprint, no
    // window ever pops for a background server.
    const headless = !cfg.browserHeadful;
    const baseOpts = {
      headless,
      args: stealthLaunchArgs(type),
      env: sanitizedChildEnv({ stripProxy: true }),
      ...(proxy ? { proxy } : {}),
    };

    /**
     * Launch through the hardened driver, degrading to the standard one when
     * the hardened driver itself cannot launch (as opposed to the CHANNEL being
     * unavailable, which the caller handles separately). The downgrade is
     * cached for the process so a broken optional driver is probed once, not
     * once per fetch. Errors from the STANDARD launcher propagate — at that
     * point there is nothing left to fall back to.
     */
    const launchWithFallback = async (opts: Record<string, unknown>): Promise<Browser> => {
      if (!usingHardened) return standard.launch(opts);
      try {
        return await hardened.launch(opts);
      } catch (err) {
        this.resolvedStealthDriver = 'standard';
        log.warn('hardened stealth driver could not launch, using the standard browser driver', {
          type,
          error: err instanceof Error ? err.message : String(err),
        });
        return standard.launch(opts);
      }
    };

    // Only chromium supports the authentic installed-browser channel. For
    // firefox/webkit (or a 'chromium'-forced config) launch bundled directly.
    const wantChannel = type === 'chromium' && cfg.browserChannel !== 'chromium';
    if (!wantChannel) {
      this.resolvedStealthChannel = 'bundled';
      return launchWithFallback(baseOpts);
    }

    // Cached probe: never re-attempt channel:'chrome' once we know it fails on
    // this machine, and never drop back to bundled once we know chrome works.
    if (this.resolvedStealthChannel === 'bundled') {
      return launchWithFallback(baseOpts);
    }
    if (this.resolvedStealthChannel === 'chrome') {
      return launchWithFallback({ ...baseOpts, channel: 'chrome' });
    }

    // First probe this process. Try the authentic browser; on ANY launch
    // failure (not installed / spawn error) fall back to the bundled engine and
    // cache the outcome so later fetches skip the failed attempt. A hardened
    // driver that cannot launch AT ALL is caught one level down, so a channel
    // failure and a driver failure cannot be confused for one another.
    try {
      const browser = await launchWithFallback({ ...baseOpts, channel: 'chrome' });
      this.resolvedStealthChannel = 'chrome';
      log.info('anti-bot stealth launch using authentic installed browser', { type });
      return browser;
    } catch (err) {
      this.resolvedStealthChannel = 'bundled';
      log.info('authentic browser unavailable, using bundled browser engine for stealth', {
        type,
        error: err instanceof Error ? err.message : String(err),
      });
      return launchWithFallback(baseOpts);
    }
  }

  async fetchWithBrowser(url: string, options: BrowserFetchOptions = {}): Promise<RawFetchResult> {
    // Bail out immediately if the caller's budget is already exhausted.
    if (options.signal?.aborted) throw options.signal.reason;

    // Monotonic start for the challenge-completion remaining-budget math below.
    const fetchStartMs = Date.now();
    const config = getConfig();
    const navTimeoutMs = options.timeoutMs ?? config.playwrightNavTimeoutMs;

    // OFF-BY-DEFAULT opt-in escalation rung: raw-CDP content fetch via a throwaway
    // real Chrome, no Playwright control plane (Phase 1). When `cdpDirect === 'off'`
    // (default) this block is a hard no-op and the path below is byte-identical to
    // today. When 'on' (always) or 'auto' (only on the anti-bot escalation path,
    // signalled by options.stealth) AND the fetch is content-only — no actions,
    // auth, downloads, screenshots, or a pinned/hosted CDP endpoint — try the rung
    // FIRST. On any null (Chrome absent, optional dep absent, connect/nav failure,
    // abort) fall through to the normal browser tier UNCHANGED. The rung makes no
    // claim to beat the existing stealth/patchright tier — it is a live-evaluation
    // escalation only, and never hard-fails a fetch.
    if (config.cdpDirect !== 'off') {
      const contentOnly =
        !options.actions?.length &&
        !options.cdpUrl &&
        !options.storageStatePath &&
        !options.userDataDir &&
        !options.screenshot &&
        !config.scrapingBrowserWss;
      const engage = config.cdpDirect === 'on' || (config.cdpDirect === 'auto' && options.stealth === true);
      if (contentOnly && engage) {
        log.debug('trying cdp-direct escalation rung', { url, mode: config.cdpDirect });
        const direct = await cdpDirectFetch(url, {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        });
        if (direct) {
          log.info('cdp-direct rung served content', { url });
          return direct;
        }
        log.debug('cdp-direct rung returned null, falling back to browser tier', { url });
        if (options.signal?.aborted) throw options.signal.reason;
      }
    }

    let ctx: BrowserContext;
    let cdpBrowser: Browser | null = null;
    let resolvedType: BrowserType;
    // A dedicated stealth fetch owns its context (and a throwaway browser) and
    // must close both at end-of-fetch instead of releasing to the shared pool.
    let dedicated = false;
    let dedicatedBrowser: Browser | null = null;
    let stealthSlotHeld = false;
    // The UA this context authoritatively advertises — recorded alongside a
    // minted clearance so a later reuse can UA-match the consuming tier. Known
    // on the stealth path (resolveStealthUA); the pooled/CDP default is read
    // from the live page below when we actually mint a clearance.
    let advertisedUa: string | null = null;

    // OFF by default: only reach the hosted scraping-browser rung when it is
    // explicitly configured (`scrapingBrowserWss`) AND the caller did not already
    // pin an explicit CDP endpoint. When null, this is a hard no-op — the default
    // acquire/launch path below is entirely unchanged. The connector itself
    // owns the P8 scheme-guard + credential redaction; a bad scheme / connect
    // failure returns null so we fall through to the normal browser tier.
    const scrapingWss = !options.cdpUrl ? config.scrapingBrowserWss : null;

    // Stealth applies only to the launch path — the CDP path connects to an
    // external browser that owns its own fingerprint. The hosted scraping-browser
    // rung is likewise external, so it also disables the local stealth launch.
    const useStealth = options.stealth === true && !options.cdpUrl && !scrapingWss;

    if (options.cdpUrl) {
      // CDP is always Chromium
      resolvedType = 'chromium';
      try {
        log.info('connecting via CDP', { cdpUrl: redactUrl(options.cdpUrl) });
        cdpBrowser = await chromium.connectOverCDP(options.cdpUrl);
        const contexts = cdpBrowser.contexts();
        ctx = contexts.length > 0 ? contexts[0] : await cdpBrowser.newContext();
      } catch (err) {
        log.warn('CDP connection failed, falling back to launch', {
          cdpUrl: redactUrl(options.cdpUrl),
          error: err instanceof Error ? err.message : String(err),
        });
        ctx = await this.acquireForType(resolvedType);
      }
    } else if (scrapingWss) {
      // Hosted scraping-browser rung (opt-in). Reuse the P8 connector: it
      // validates the ws:/wss: scheme, redacts credentials in every log line,
      // and connects over CDP. On success it hands back a live Browser we drive
      // exactly like the pinned-CDP path; on null (bad scheme / connect failure)
      // we fall back to the normal browser tier — a fetch is NEVER hard-failed.
      resolvedType = 'chromium';
      const scrapingHandle = await connectScrapingBrowser({
        wss: scrapingWss,
        signal: options.signal,
      }).catch(() => null);
      if (scrapingHandle) {
        // Treat the hosted browser like the pinned-CDP browser so the shared
        // finally closes it (never released to the local pool).
        cdpBrowser = scrapingHandle.browser;
        try {
          const contexts = cdpBrowser.contexts();
          ctx = contexts.length > 0 ? contexts[0] : await cdpBrowser.newContext();
        } catch (err) {
          // This runs BEFORE the main try/finally, so a context failure here
          // would strand the hosted browser — and a hosted one keeps running
          // (and billing) remotely. Close it and degrade like a failed connect.
          log.warn('hosted scraping-browser context creation failed, falling back to a local browser', {
            error: err instanceof Error ? err.message : String(err),
          });
          await scrapingHandle.close().catch(() => {});
          cdpBrowser = null;
          ctx = await this.acquireForType(resolvedType);
        }
      } else {
        // Off / bad scheme / connect failed → graceful fall back to launch.
        ctx = await this.acquireForType(resolvedType);
      }
    } else if (useStealth) {
      resolvedType = this.resolveType(options.browserType, url);
      // Bound concurrency BEFORE launching so a burst cannot exceed the cap.
      await this.acquireStealthSlot();
      stealthSlotHeld = true;
      dedicated = true;
      log.debug('fetching with browser (anti-bot fingerprint hardening)', { url, type: resolvedType });
      // Launch a SEPARATE throwaway browser with the hardening launch args so
      // those flags never leak into the shared pooled browser (which stays on
      // its default launch). The dedicated context + browser are closed in the
      // finally.
      //
      // This setup runs OUTSIDE the main try/finally below, so any throw here
      // (launch/newContext/addInitScript/newPage — e.g. browser not installed,
      // resource exhaustion, launch race) would otherwise leak the semaphore
      // slot AND orphan a launched browser. Clean up locally + rethrow. On the
      // success path the catch never runs, so the finally below stays the sole
      // releaser — no double-release.
      try {
        dedicatedBrowser = await this.launchDedicatedStealthBrowser(resolvedType, options.forceNoProxy);
        // UA/platform coherence (T1-C). The advertised UA MUST match the actual
        // runtime: its platform token reflects the real OS (process.platform)
        // and its Chrome major reflects the ACTUAL launched browser's version
        // (read via browser.version()), never a hardcoded Windows/142 mismatch.
        // On chromium this synthesized UA is byte-identical to the browser's
        // native desktop UA (so it stays coherent while remaining known for
        // clearance recording); the new-headless / authentic-browser path
        // guarantees no "HeadlessChrome" token. firefox/webkit keep the pinned
        // synthesized UA.
        // Guard version() for browser stubs without it (unit-test mocks) — a
        // missing/unparseable version falls back to the pinned Chrome major.
        const launchedVersion =
          typeof (dedicatedBrowser as { version?: unknown }).version === 'function'
            ? dedicatedBrowser.version()
            : null;
        const launchedMajor = parseChromeMajor(launchedVersion);
        // Publish the real major so the clearance reuse gate compares against
        // the identity this tier actually presents. Without this the gate keeps
        // testing the static pin and refuses every clearance we mint here.
        recordLaunchedChromeMajor(launchedMajor);
        advertisedUa =
          launchedMajor !== null
            ? resolveStealthUA(process.platform, launchedMajor)
            : resolveStealthUA();
        ctx = await dedicatedBrowser.newContext(stealthContextOptions(advertisedUa));
        // Guard for context stubs without addInitScript (unit-test mocks).
        if (typeof (ctx as { addInitScript?: unknown }).addInitScript === 'function') {
          await ctx.addInitScript(STEALTH_INIT_SCRIPT);
        }
      } catch (err) {
        // Close the orphaned throwaway browser (if launch got that far) and
        // free the concurrency slot before rethrowing — otherwise N such
        // failures would exhaust the semaphore and hang all later stealth
        // fetches.
        await dedicatedBrowser?.close().catch(() => {});
        dedicatedBrowser = null;
        if (stealthSlotHeld) {
          this.releaseStealthSlot();
          stealthSlotHeld = false;
        }
        throw err;
      }
    } else {
      resolvedType = this.resolveType(options.browserType, url);
      log.debug('fetching with browser', { url, type: resolvedType });
      ctx = await this.acquireForType(resolvedType);
    }

    // Seed reused anti-bot clearance cookies BEFORE navigation so a solved
    // challenge is replayed instead of re-solved. Each cookie is host-scoped by
    // the router, so the browser drops it on a cross-host redirect. Guarded for
    // context stubs without addCookies (unit-test mocks).
    if (
      options.injectedCookies &&
      options.injectedCookies.length > 0 &&
      typeof (ctx as { addCookies?: unknown }).addCookies === 'function'
    ) {
      await (ctx as { addCookies: (c: NonNullable<BrowserFetchOptions['injectedCookies']>) => Promise<void> })
        .addCookies(options.injectedCookies)
        .catch(() => {});
    }

    let page: import('playwright').Page;
    try {
      page = await ctx.newPage();
    } catch (err) {
      // newPage runs before the main try/finally. On the dedicated stealth path
      // a throw here would leak the semaphore slot + orphan the throwaway
      // browser exactly like the setup above; clean those up and rethrow. The
      // pooled/CDP paths keep their prior behavior (the context is not
      // dedicated, so only the rethrow applies).
      if (dedicated) {
        await ctx.close().catch(() => {});
        await dedicatedBrowser?.close().catch(() => {});
        dedicatedBrowser = null;
        if (stealthSlotHeld) {
          this.releaseStealthSlot();
          stealthSlotHeld = false;
        }
      }
      throw err;
    }

    // When the caller's signal fires, close THIS page (the private one we
    // just opened) so the in-flight navigation is cancelled and the slot is
    // returned quickly. We never close the shared pooled context.
    const onAbort = () => { page.close().catch(() => {}); };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // Capture a download so a PDF (or other binary) response served to the
    // browser is turned into a buffered result instead of a hard nav error.
    // Registered before goto so the event is never missed. Guarded so page
    // stubs without `on` (unit-test mocks) are unaffected.
    let capturedDownload: Download | undefined;
    if (typeof page.on === 'function') {
      page.on('download', (dl) => { capturedDownload = dl; });
    }

    if (options.headers) {
      await page.setExtraHTTPHeaders(options.headers);
    }

    let statusCode = 200;
    let contentType = '';
    let responseHeaders: Record<string, string> = {};
    let finalUrl = url;
    let gotoTimedOut = false;
    // True once a fetch entered the challenge-completion poll. A poll that clears
    // to a near-empty stub (DataDome swaps its interstitial for a tiny `g2.com`
    // body carrying no marker) must NOT be served as content — after full
    // hydration below, a still-empty body means the wall never really let us
    // through, so it's a labeled block, not a pass.
    let enteredChallengePoll = false;
    // Solve-ladder provenance, threaded onto the eventual RawFetchResult so the
    // fetch surface can audit which challenge class was hit and which rung (if
    // any) cleared it. `challengeClass` is set once the classifier runs on a
    // detected challenge; `solveMethod` is set by a rung that cleared, or left
    // undefined when no challenge was involved / the short auto-poll cleared it
    // without engaging the ladder.
    let detectedChallengeClass: ChallengeClass | undefined;
    let ladderSolveMethod: SolveMethod | null | undefined;

    try {
      // Pre-navigation fetch-time SSRF re-check. `guardFetchUrl` (applied
      // upstream on input + every redirect hop before a fetch reaches the
      // browser tier) only validates the LITERAL host, so a public hostname
      // whose DNS record points at a blocked address (cloud metadata /
      // RFC-1918 / loopback) passes it and is only caught here, before we
      // navigate. Skip literal IPs — already validated by the literal guard.
      //
      // CHECK-ONLY: this does NOT close DNS rebinding. Chromium performs its
      // OWN DNS resolution when it actually navigates, a separate lookup from
      // the one below — a host that flips its A/AAAA record between this
      // check and Chromium's own resolution (or that resolves differently to
      // Chromium than to Node) would still slip through. Pinning the
      // navigation itself to the validated address is a follow-up, tracked in
      // issue #207.
      {
        const navHost = hostOf(url);
        const isIpLiteral = navHost !== null && (/^\d{1,3}(\.\d{1,3}){3}$/.test(navHost) || navHost.includes(':'));
        if (navHost && !isIpLiteral) {
          const resolved = await guardResolvedHost(navHost, 'target url', {
            allowPrivate: getConfig().fetchAllowPrivate,
          });
          if (!resolved.ok) {
            throw new Error(`${resolved.reason}. ${resolved.hint}`);
          }
        }
      }
      try {
        // Race the navigation against the caller's abort signal so the fetch
        // rejects promptly instead of waiting for the full nav timeout.
        // abortRejection never settles when no signal is given, so it is a
        // safe loser in the race when signal is undefined.
        const response = await Promise.race([
          page.goto(url, {
            timeout: navTimeoutMs,
            waitUntil: 'domcontentloaded',
          }),
          abortRejection(options.signal),
        ]);

        if (response) {
          statusCode = response.status();
          finalUrl = response.url();
          const rawHeaders = response.headers();
          responseHeaders = rawHeaders;
          contentType = rawHeaders['content-type'] ?? '';
        }
      } catch (err) {
        // A PDF (or other binary) response makes Chromium reject goto with
        // "Download is starting" and/or fire a download event. Don't hard-error
        // — read the downloaded bytes and return them as a buffered result so
        // the tool layer extracts the PDF exactly like the HTTP-tier path.
        const msg = err instanceof Error ? err.message : String(err);
        if (capturedDownload || DOWNLOAD_START_PATTERN.test(msg)) {
          // Chromium can reject goto with "Download is starting" BEFORE the
          // `download` event handler has captured the object (the event is
          // emitted asynchronously). When we don't have it yet, wait briefly
          // for the event so a real PDF isn't lost to the race.
          let download = capturedDownload;
          if (!download && typeof page.waitForEvent === 'function') {
            download = await page
              .waitForEvent('download', { timeout: DOWNLOAD_EVENT_WAIT_MS })
              .catch(() => undefined);
          }
          if (download) {
            const buf = await readDownloadBuffer(download, url, options.signal);
            if (buf) {
              log.debug('intercepted browser download, returning buffered bytes', { url, bytes: buf.length });
              return {
                url,
                finalUrl: url,
                html: '',
                contentType: 'application/pdf',
                statusCode: 200,
                method: 'browser',
                headers: {},
                rawBuffer: buf,
              };
            }
          }
          // No download object (or unreadable) — surface as a download error
          // rather than pretending it was a normal navigation.
          throw err;
        }
        // SPAs may hydrate past the nav timeout. Rather than failing the whole
        // fetch, capture whatever HTML the page already rendered and tag a
        // warning so callers (and host LLMs) know the content is partial.
        // AbortError (from abortRejection) has name 'AbortError', NOT
        // 'TimeoutError', so isTimeout is false and the error is rethrown —
        // no new branch is needed here.
        const isTimeout =
          (err instanceof Error && err.name === 'TimeoutError') ||
          /Timeout\s+\d+ms\s+exceeded/i.test(msg);
        if (!isTimeout) throw err;
        gotoTimedOut = true;
        log.warn('page.goto timed out, returning partial content', { url, navTimeoutMs });
      }

      // Anti-bot fast-fail (D6). A hard bot-protection interstitial otherwise
      // holds the tab for the full nav + load timeout (30-45s). Fail fast so the
      // budget is bounded to a short settle window.
      //
      // Success path: STATUS-GATED — fire only when the response is an anti-bot
      // status AND the body carries a (contextual) challenge signal. Body
      // markers alone never fire (a 200 article quoting the markers passes).
      // After a bounded settle, RE-CHECK: an auto-passing challenge navigates to
      // a real page and proceeds normally.
      //
      // Timeout path: no reliable status on a goto timeout, so we require a
      // challenge-body signal (a shared marker, or the contextual turnstile on
      // a challenge skeleton). A normal SPA that merely timed out has a
      // near-empty shell but NO markers, so `hasBrowserChallengeBody` is false
      // and the existing partial-return behavior is preserved.
      if (gotoTimedOut) {
        // Peek at the partial body for a challenge signal. We deliberately do
        // NOT reuse it as the final body — the post-goto hydration waits below
        // may still render more content on a timed-out SPA, and the existing
        // behavior returns whatever the page holds AFTER those waits.
        const partial = await readContentWithRetry(page, url).catch(() => '');
        if (hasBrowserChallengeBody(partial)) {
          log.warn('challenge body on goto-timeout partial, fast-failing', { url });
          throw new ChallengeBlockedError(url);
        }
      } else if (isAntiBotStatus(statusCode) || isSuccessStatus(statusCode)) {
        // Widened past the anti-bot-status gate: some bot walls (DataDome
        // "enable JavaScript" shells) serve the challenge interstitial at HTTP
        // 200. The initial read + isChallengeShell check keeps the 2xx branch
        // precise — a real 200 article (even one that happens to be an SPA
        // shell without challenge markers) is NOT a challenge and falls
        // through to the normal hydration waits. Markers AND skeleton are both
        // required at 2xx (see isChallengeShell), so an article quoting the
        // markers never enters the settle window.
        const initial = await readContentWithRetry(page, url).catch(() => '');
        // TRIGGER (should we poll?): header-inclusive so a modern-CF 403 whose
        // body carries none of the legacy markers — its only signals are the
        // `cf-mitigated: challenge` nav header + the /cdn-cgi/challenge-platform/
        // script — still enters the completion poll. isChallengeResponse folds
        // in the header, the legacy shell classifier, and the status-gated
        // modern marker. The 2xx branch keeps isChallengeShell (markers +
        // skeleton) so a real 200 article never enters the settle window.
        const isChallenge = isAntiBotStatus(statusCode)
          ? isChallengeResponse(statusCode, initial, responseHeaders)
          : isChallengeShell(statusCode, initial);
        if (isChallenge) {
          // Poll the challenge to completion rather than settling once for a
          // fixed window: a real interstitial that runs its JS and navigates
          // after >5s used to be fast-failed even though it was about to pass.
          // The deadline is the min() of the configured completion timeout and
          // the caller's REMAINING fetch budget: `options.timeoutMs` is the
          // duration the caller's abort signal is already timing, so the
          // remaining budget is that minus the time already spent this call
          // (Date.now() - fetchStartMs). No caller budget => the full timeout.
          const completionTimeoutMs = config.challengeCompletionTimeoutMs;
          const remainingBudgetMs =
            options.timeoutMs !== undefined
              ? Math.max(0, options.timeoutMs - (Date.now() - fetchStartMs))
              : completionTimeoutMs;
          const deadlineMs = Math.min(completionTimeoutMs, remainingBudgetMs);
          enteredChallengePoll = true;
          log.warn('bot-protection challenge detected, polling to completion', { url, statusCode, deadlineMs });
          const outcome = await pollUntilCleared(page, {
            deadlineMs,
            intervalMs: 500,
            // CLEAR-CHECK (still a challenge?): keys on the CURRENT RENDERED
            // BODY only — NEVER the nav header, which stays `cf-mitigated:
            // challenge` even after the challenge clears (a header-based check
            // would never report cleared and would wrongly fast-fail a genuine
            // pass). stillShowingChallenge recognises the modern-CF rendered
            // skeleton (challenge-platform script + near-empty body) yet its
            // text-length skeleton gate lets a real article that merely
            // references the script path clear.
            isStillChallenge: (html) =>
              isAntiBotStatus(statusCode) ? stillShowingChallenge(html) : isChallengeShell(statusCode, html),
            readContent: (p) => readContentWithRetry(p as import('playwright').Page, url).catch(() => ''),
            readCookies: (p) => {
              const pg = p as import('playwright').Page;
              // Guard for page stubs without context() (unit-test mocks) and
              // for a transient read failure mid-navigation.
              if (typeof pg.context !== 'function') return Promise.resolve([]);
              return Promise.resolve(pg.context().cookies()).catch(() => []);
            },
            signal: options.signal,
          });
          if (!outcome.cleared) {
            // The short auto-poll did not clear. Before fast-failing, engage the
            // in-band solve ladder: classify the challenge shape and run the
            // applicable rung(s) IN THIS LIVE CONTEXT (the in-band constraint).
            // Only rungs whose knob is on engage; behavioral/none run nothing.
            const ladderHtml = await readContentWithRetry(page, url).catch(() => '');
            detectedChallengeClass = classifyChallenge(ladderHtml);
            const stillChallenge = (html: string) =>
              isAntiBotStatus(statusCode) ? stillShowingChallenge(html) : isChallengeShell(statusCode, html);
            const ladderRemainingMs = () =>
              options.timeoutMs !== undefined
                ? Math.max(0, options.timeoutMs - (Date.now() - fetchStartMs))
                : config.challengeCompletionTimeoutMs;
            const ladder = await this.runChallengeSolveLadder({
              page,
              url,
              config,
              challengeClass: detectedChallengeClass,
              isStillChallenge: stillChallenge,
              remainingMs: ladderRemainingMs,
              signal: options.signal,
            });
            if (ladder.solved) {
              ladderSolveMethod = ladder.solveMethod;
              // Normalise the stale challenge response the same way the auto-poll
              // pass path does, so the cleared page is not re-classified as
              // blocked downstream.
              if (isAntiBotStatus(statusCode)) statusCode = 200;
              if (hasChallengeHeader(responseHeaders)) {
                const normalized: Record<string, string> = {};
                for (const [k, v] of Object.entries(responseHeaders)) {
                  if (k.toLowerCase() === 'cf-mitigated') continue;
                  normalized[k] = v;
                }
                responseHeaders = normalized;
              }
              // Harvest a minted clearance the same way the auto-poll path does.
              const cf = findCfClearance(ladder.cookies);
              if (cf) {
                const host = hostOf(finalUrl) ?? hostOf(url);
                const ua = advertisedUa ?? (await readAdvertisedUa(page));
                if (host && ua) {
                  try {
                    recordDomainClearance(host, {
                      cookie: `${CLEARANCE_COOKIE_NAME}=${cf.value}`,
                      ua,
                      tier: 'browser',
                      expiresAt: clearanceExpiresIso(cf.expires),
                      solvedRoute: getConfig().proxyUrl ?? 'direct',
                    });
                  } catch { /* best-effort — never block the fetch */ }
                }
              }
              log.info('bot-protection challenge cleared by solve ladder', { url, solveMethod: ladder.solveMethod });
              // Fall through to the normal post-goto hydration + final read.
            } else {
              // Re-validation: if we SEEDED a reused clearance and it still landed
              // on a challenge, the stored clearance is dead. Purge it so it isn't
              // replayed next time, then fast-fail into the normal escalation
              // ladder (never serve the shell as content).
              if (options.injectedCookies && options.injectedCookies.length > 0) {
                const host = hostOf(finalUrl) ?? hostOf(url);
                if (host) {
                  try {
                    clearDomainClearance(host);
                  } catch { /* best-effort — never block the fetch */ }
                }
              }
              ladderSolveMethod = null;
              log.warn('bot-protection challenge did not clear within completion window, fast-failing', { url, statusCode });
              // Thread the triggering anti-bot status (403/429/503) so the router
              // surfaces it as http_status for the crawl cooldown. A 2xx shell
              // carries no anti-bot status, so leave it unset there. Carry the
              // classified challenge class so the honest blocked_by_challenge path
              // reports it.
              throw new ChallengeBlockedError(
                url, undefined, undefined,
                isAntiBotStatus(statusCode) ? statusCode : undefined,
                { challengeClass: detectedChallengeClass, solveMethod: null },
              );
            }
          }
          // Auto-passed: the challenge navigated to a real page. The captured
          // nav statusCode/responseHeaders are STALE — they still describe the
          // initial 403 + `cf-mitigated: challenge` interstitial response, not
          // the real page that ultimately rendered. Left as-is they would make
          // the router's guardChallengeShell (which runs isChallengeResponse on
          // the returned result) wrongly re-classify this CLEARED page as
          // blocked_by_challenge. Normalise the result to reflect the final page:
          // report a 200 and drop the stale challenge header so a cleared
          // challenge returns content, while a still-challenge (never reaches
          // here — it threw ChallengeBlockedError above) is the only path that
          // maps to blocked_by_challenge.
          if (isAntiBotStatus(statusCode)) {
            statusCode = 200;
          }
          if (hasChallengeHeader(responseHeaders)) {
            const normalized: Record<string, string> = {};
            for (const [k, v] of Object.entries(responseHeaders)) {
              if (k.toLowerCase() === 'cf-mitigated') continue;
              normalized[k] = v;
            }
            responseHeaders = normalized;
          }
          // Persist any minted clearance cookie against the exact UA this context
          // advertised + tier:'browser' so a later visit can replay it. Fall
          // through so the normal post-goto hydration waits run and the final
          // content read below captures the fully-rendered page.
          if (outcome.cfClearance) {
            const host = hostOf(finalUrl) ?? hostOf(url);
            const ua = advertisedUa ?? (await readAdvertisedUa(page));
            if (host && ua) {
              try {
                recordDomainClearance(host, {
                  cookie: `${CLEARANCE_COOKIE_NAME}=${outcome.cfClearance.value}`,
                  ua,
                  tier: 'browser',
                  expiresAt: clearanceExpiresIso(outcome.cfClearance.expires),
                  // A cf_clearance is IP/UA/TLS-bound; record the egress route it
                  // was solved on so reuse can refuse a route-identity mismatch.
                  solvedRoute: getConfig().proxyUrl ?? 'direct',
                });
              } catch { /* best-effort — never block the fetch */ }
            }
            log.debug('challenge cleared with clearance cookie', { url, expires: outcome.cfClearance.expires });
          }
          log.info('bot-protection challenge auto-passed within completion window', { url });
        }
      }

      // A fast goto can win its race while the budget is already exhausted —
      // bail before entering the post-goto waits so a never-networkidle SPA
      // can't hold the slot past the stage budget.
      if (options.signal?.aborted) throw options.signal.reason;

      // One shared post-goto settle (network idle + hybrid hydration gate)
      // drawn from the caller's REMAINING fetch budget, mirroring the challenge
      // poll's budget math above. Its completeness label is threaded onto the
      // returned result below (re-derived if actions mutate the DOM after).
      const remainingBudgetMs =
        options.timeoutMs !== undefined
          ? Math.max(0, options.timeoutMs - (Date.now() - fetchStartMs))
          : undefined;
      const settle = await settlePage(page, { budgetMs: remainingBudgetMs, signal: options.signal, url });
      if (options.signal?.aborted) throw options.signal.reason;

      // Human-like INTERACTION pass (behavioral realism). Runs AFTER the page
      // settles and BEFORE extraction so a behavioral-scoring anti-bot wall
      // sees session mouse movement + scroll + timing. Engagement is derived
      // from config unless the caller forces it via options.humanize:
      //   'on'   → every browser fetch; 'off' → never;
      //   'auto' → only on the stealth/escalation path (useStealth).
      // Bounded by a hard time cap drawn from the REMAINING budget so it never
      // blows the per-fetch budget, and it no-ops on a non-interactive page.
      const humanizeEngaged =
        options.humanize !== undefined
          ? options.humanize
          : config.humanize === 'on' || (config.humanize === 'auto' && useStealth);
      if (humanizeEngaged && !options.signal?.aborted) {
        const behaviorBudgetMs =
          options.timeoutMs !== undefined
            ? Math.max(0, Math.min(1500, options.timeoutMs - (Date.now() - fetchStartMs)))
            : 1200;
        if (behaviorBudgetMs > 0) {
          await humanizePage(page, { maxMs: behaviorBudgetMs, signal: options.signal });
        }
        if (options.signal?.aborted) throw options.signal.reason;
      }

      let actionResults: ActionResult[] | undefined;
      if (options.actions && options.actions.length > 0) {
        actionResults = await executeActions(page, options.actions);
      }

      // Client-side routers (React Router / Next.js) can fire a pushState
      // navigation during initial hydration. If page.content() runs mid-
      // transition Playwright throws "Execution context was destroyed".
      // Retry briefly so a hydration nav doesn't fail the whole fetch.
      const html = await readContentWithRetry(page, url);

      // A challenge poll that "cleared" but whose fully-hydrated body is still
      // near-empty never actually passed — the wall (DataDome) swapped its
      // interstitial for a tiny stub with no marker, which the marker-based
      // clear-check reads as a pass. Label it a block instead of leaking the
      // stub. Runs AFTER networkidle + the hydration probe, so a genuinely
      // cleared page (slow SPA included) has real content and is unaffected.
      if (enteredChallengePoll && isNearEmptyBody(html)) {
        log.warn('challenge auto-passed but hydrated body is near-empty — labeling blocked', { url });
        throw new ChallengeBlockedError(
          url, undefined, undefined, undefined,
          // A "pass" that hydrated to a near-empty stub never really cleared —
          // report the detected class with a null solve_method (honest block).
          { challengeClass: detectedChallengeClass, solveMethod: null },
        );
      }

      // Completeness label for the returned capture. Base is the settle verdict;
      // if actions ran, the DOM changed AFTER settle so re-derive from a fresh
      // verdict read. Then, if the FINAL html still looks like a challenge shell
      // that did NOT throw ChallengeBlockedError above (a 2xx interstitial with
      // real body length that slipped the near-empty gate), override to
      // challenge_shell so downstream never trusts it as content.
      let completeness: ContentCompleteness = settle.completeness;
      if (options.actions && options.actions.length > 0) {
        const v = (await page.evaluate(DOM_VERDICT_SOURCE).catch(() => null)) as DomVerdict | null;
        if (v) completeness = toCompleteness(settle.settledBy, v, settle.stillGrowing);
      }
      const looksLikeChallenge = isAntiBotStatus(statusCode)
        ? isChallengeResponse(statusCode, html, responseHeaders)
        : isChallengeShell(statusCode, html);
      if (looksLikeChallenge) {
        completeness = { level: 'shell', reason: 'challenge_shell', settled_by: settle.settledBy };
      }

      let screenshotBase64: string | undefined;
      if (options.screenshot) {
        // Screenshots require a real browser tab — the
        // HTTP and TLS tiers cannot rasterise a page. When `force_refresh`
        // is combined with `screenshot: true` the request unavoidably pays
        // the full Playwright cold-start (~5-8s) on top of the navigation
        // itself. This is intrinsic to producing a pixel-accurate image and
        // not a routing bug; downstream callers should expect that cost.
        const buf = await page.screenshot({ fullPage: true });
        screenshotBase64 = buf.toString('base64');
      }

      return {
        url,
        finalUrl,
        html,
        contentType,
        statusCode,
        method: 'browser',
        headers: responseHeaders,
        screenshot: screenshotBase64,
        actionResults,
        contentCompleteness: completeness,
        ...(gotoTimedOut ? { warning: 'goto_timeout_partial_content' } : {}),
        // Solve-ladder provenance: the challenge class detected (if any) and the
        // rung that cleared it. Absent when no challenge was involved.
        ...(detectedChallengeClass !== undefined ? { challenge_class: detectedChallengeClass } : {}),
        ...(ladderSolveMethod !== undefined ? { solve_method: ladderSolveMethod } : {}),
      };
    } finally {
      // Detach the abort listener before closing so we don't trigger a
      // redundant close call if abort fires after we're already in finally.
      options.signal?.removeEventListener('abort', onAbort);
      // Close the page; tolerate already-closed (double-close is safe).
      await page.close().catch(() => {});
      if (cdpBrowser) {
        await cdpBrowser.close().catch(() => {});
      } else if (dedicated) {
        // Dedicated stealth path: close the per-fetch context + throwaway
        // browser (NEVER release to the shared pool) — guaranteed on abort too
        // — then free the concurrency slot for the next waiter.
        await ctx.close().catch(() => {});
        if (dedicatedBrowser) {
          await dedicatedBrowser.close().catch(() => {});
        }
        if (stealthSlotHeld) {
          this.releaseStealthSlot();
        }
      } else {
        // Always release the slot — even on abort — so the pool is not leaked.
        this.releaseForType(resolvedType, ctx);
      }
    }
  }

  /**
   * Build the concrete injected rung callbacks and run the pure solve ladder in
   * the LIVE browser context (the in-band constraint — same session that owns
   * the challenge). Everything Playwright/CDP/LLM-specific lives here; the ladder
   * itself stays pure. Returns the ladder outcome; never throws for a solve
   * failure (the caller decides the block), but DOES propagate an abort.
   */
  private async runChallengeSolveLadder(args: {
    page: import('playwright').Page;
    url: string;
    config: ReturnType<typeof getConfig>;
    challengeClass: ChallengeClass;
    isStillChallenge: (html: string) => boolean;
    remainingMs: () => number;
    signal?: AbortSignal;
  }): Promise<SolveLadderResult> {
    const { page, url, config, challengeClass, isStillChallenge, remainingMs, signal } = args;
    const readContent = (p: unknown) =>
      readContentWithRetry(p as import('playwright').Page, url).catch(() => '');
    const readCookies = (p: unknown): Promise<ClearanceCookie[]> => {
      const pg = p as import('playwright').Page;
      if (typeof pg.context !== 'function') return Promise.resolve([]);
      return Promise.resolve(pg.context().cookies() as Promise<ClearanceCookie[]>).catch(() => []);
    };

    // --- auto-pass (interactive): trusted CDP gesture over the widget ---------
    const tryAutoPass = async () => {
      // A lazily-created extra CDP client (never the driver connection) drives
      // trusted Input.dispatchMouseEvent — isTrusted-true events a WAF cannot
      // tell from a real hand. Guard for page stubs without a context/CDP.
      const cdp = await this.newCdpSession(page).catch(() => null);
      const locateWidget = () => this.locateChallengeWidget(page).catch(() => null);
      const dispatchTrustedMove = async (x: number, y: number) => {
        if (!cdp) return;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }).catch(() => {});
      };
      const dispatchTrustedClick = async (x: number, y: number) => {
        if (!cdp) return;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }).catch(() => {});
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }).catch(() => {});
      };
      const res = await autoPassChallenge({
        page,
        locateWidget,
        dispatchTrustedMove,
        dispatchTrustedClick,
        readContent,
        readCookies,
        isStillChallenge,
        deadlineMs: remainingMs(),
        signal,
      });
      await cdp?.detach().catch(() => {});
      return { passed: res.passed, cookies: res.cookies ?? [] };
    };

    // --- ai-vision (image): in-band vision solve ------------------------------
    const tryAiSolve = async () => {
      // Refine the image sub-type from the live challenge HTML (grid / slider /
      // text). Read best-effort; an empty read falls back to the grid default.
      const challengeHtml = await readContent(page);
      const subType = this.imageSubTypeFor(challengeClass, challengeHtml);
      const res = await aiSolveChallenge({
        page,
        subType,
        screenshotWidget: () => this.screenshotChallengeWidget(page),
        readInstruction: () => this.readChallengeInstruction(page),
        solveWithVision: async ({ image, prompt, schema }) => {
          const { runLlmJson } = await import('../integrations/cloud/llm/run.js');
          const r = await runLlmJson({
            prompt,
            jsonSchema: schema,
            image: { data: image.data, mediaType: image.mediaType },
            signal,
          });
          return r.values;
        },
        clickTiles: (indices) => this.clickChallengeTiles(page, indices),
        dragSlider: (offsetPx) => this.dragChallengeSlider(page, offsetPx),
        typeText: (text) => this.typeChallengeText(page, text),
        submit: () => this.submitChallenge(page),
        readContent,
        readCookies,
        isStillChallenge,
        maxAttempts: config.aiSolveMaxAttempts,
        intervalMs: 500,
        deadlineMs: remainingMs(),
        signal,
      });
      return { solved: res.solved, cookies: res.cookies };
    };

    // --- human (last): visible-surface fallback -------------------------------
    const tryHuman = async () => {
      const res = await humanSolveChallenge({
        page,
        info: { url, challengeClass },
        // A visible surface exists only on the headful browser path; headless
        // hard-no-ops in the human module.
        hasVisibleSurface: config.browserHeadful,
        consent: config.humanSolveConsent,
        onNeedHuman: async () => {
          await this.bringToFront(page).catch(() => {});
          log.warn('a challenge needs you to solve it in the browser window', { url });
        },
        readContent,
        readCookies,
        isStillChallenge,
        humanSolveTimeoutMs: config.humanSolveTimeoutMs,
        intervalMs: 1000,
        signal,
      });
      return { solved: res.solved, cookies: res.solved ? res.cookies : [] };
    };

    // Vision availability: a vision-capable cloud provider (anthropic / openai /
    // gemini) must be configured; the text-only custom/Ollama backend and Groq
    // are not used for image solves, so ai-solve is skipped cleanly otherwise.
    //
    // The check touches the OS keychain / decrypts the AES key file, so gate it:
    // only resolve it when it can matter — an image-class challenge whose aiSolve
    // knob is engaged. Every other class (behavioral / interactive / none) can
    // never run the ai-vision rung, so visionAvailable is a fixed false there and
    // we skip the keychain read entirely. The ladder still gets a correct
    // visionAvailable for the image path.
    const aiSolveEngaged = config.aiSolve !== 'off';
    const visionAvailable =
      challengeClass === 'image' && aiSolveEngaged ? await this.visionProviderAvailable() : false;

    return runSolveLadder({
      challengeClass,
      gates: { autoPass: config.autoPass, aiSolve: config.aiSolve, humanSolve: config.humanSolve },
      visionAvailable,
      tryAutoPass,
      tryAiSolve,
      tryHuman,
      signal,
    });
  }

  /** True when a vision-capable cloud provider (anthropic/openai/gemini) is
   *  configured. Groq (weak vision) and the text-only custom backend don't
   *  count, so ai-solve is skipped cleanly when only those are present. */
  private async visionProviderAvailable(): Promise<boolean> {
    try {
      const { selectProviderWithKeyStore } = await import('../integrations/cloud/llm/select.js');
      const resolved = await selectProviderWithKeyStore(process.env, { dataDir: getConfig().dataDir });
      if (!resolved) return false;
      return resolved.provider === 'anthropic' || resolved.provider === 'openai' || resolved.provider === 'gemini';
    } catch {
      return false;
    }
  }

  /** Open an additional CDP client on the page (never the driver connection) for
   *  trusted input dispatch. Guarded for page stubs without a context. */
  private async newCdpSession(page: import('playwright').Page): Promise<import('playwright').CDPSession | null> {
    const ctx = typeof page.context === 'function' ? page.context() : null;
    if (!ctx || typeof ctx.newCDPSession !== 'function') return null;
    return ctx.newCDPSession(page);
  }

  /** Locate the interactive challenge checkbox/widget and its viewport centre,
   *  frame-aware (the reCAPTCHA anchor + hCaptcha checkbox live in iframes; the
   *  Turnstile widget is same-document). Returns null when no widget is found.
   *
   *  Every probe carries an EXPLICIT short timeout. The widget is already
   *  rendered by the time the ladder runs, so a match is immediate and a miss
   *  should cost milliseconds — but `boundingBox()` with no timeout inherits the
   *  browser engine's 30s actionability default, and a full miss then costs
   *  30s × every selector. Measured live: that turned a 15s
   *  blocked_by_challenge into a 226s one on the DEFAULT config, because
   *  `autoPass` engages on the escalation path out of the box. */
  private async locateChallengeWidget(page: import('playwright').Page): Promise<{ x: number; y: number } | null> {
    const probe = (sel: string) =>
      page.locator(sel).first().boundingBox({ timeout: WIDGET_LOCATE_TIMEOUT_MS }).catch(() => null);

    // Same-document Turnstile widget first.
    for (const sel of WIDGET_DOC_SELECTORS) {
      const box = await probe(sel);
      if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    // Cross-origin checkbox iframes (reCAPTCHA anchor / hCaptcha checkbox): the
    // iframe element's box is enough to aim the trusted click at the checkbox.
    for (const sel of WIDGET_FRAME_SELECTORS) {
      const box = await probe(sel);
      // Aim at the left-side checkbox region of the widget iframe, not its centre.
      if (box) return { x: box.x + Math.min(28, box.width / 2), y: box.y + box.height / 2 };
    }
    return null;
  }

  /** Which image sub-type the ai-vision driver should attempt for an image-class
   *  challenge. Refines the challenge HTML into the concrete solver sub-type
   *  (grid / slider / text) via the pure classifier; conservative — defaults to
   *  the grid solver (reCAPTCHA/hCaptcha common case) on any ambiguity or when no
   *  html could be read. */
  private imageSubTypeFor(_challengeClass: ChallengeClass, html: string): ImageSolveSubType {
    return classifyImageSubType(html);
  }

  /** A clipped screenshot of the challenge widget for the vision model. Falls
   *  back to a full-page shot when the widget frame can't be located. */
  private async screenshotChallengeWidget(page: import('playwright').Page): Promise<WidgetImage> {
    const box = await this.locateChallengeWidget(page).catch(() => null);
    const clip = box
      ? { x: Math.max(0, box.x - 160), y: Math.max(0, box.y - 160), width: 400, height: 500 }
      : undefined;
    // Egress note: this screenshot is sent to the configured cloud vision
    // provider by the ai-vision rung (opt-in `aiSolve`; AUP posture per spec §8).
    // The full-page fallback below widens what leaves the machine, so it only
    // runs once the ladder has already engaged the opt-in ai-solve path.
    const buf = clip
      ? await page.screenshot({ clip }).catch(() => page.screenshot())
      : await page.screenshot();
    return { data: buf.toString('base64'), mediaType: 'image/png' };
  }

  /** Best-effort challenge instruction text (e.g. "select all traffic lights").
   *  Empty string when none can be read. */
  private async readChallengeInstruction(page: import('playwright').Page): Promise<string> {
    for (const sel of ['.rc-imageselect-desc-no-canonical', '.rc-imageselect-instructions', '.prompt-text']) {
      const txt = await page.locator(sel).first().innerText().catch(() => '');
      if (txt && txt.trim().length > 0) return txt.trim();
    }
    return '';
  }

  /** The cross-origin reCAPTCHA image-select (bframe) / hCaptcha challenge frame
   *  a vision solve drives into, or null when it can't be resolved. */
  private async challengeSolveFrame(page: import('playwright').Page) {
    if (typeof page.frameLocator !== 'function') return null;
    // `frameLocator` builds a LAZY locator — it does not throw when no matching
    // frame exists, so a try/catch around it never fires and the loop always
    // returned the FIRST selector. hCaptcha and generic challenge frames were
    // therefore never targeted: every solve drove the reCAPTCHA bframe locator,
    // matching nothing. Probe the underlying iframe element instead.
    for (const sel of CHALLENGE_FRAME_SELECTORS) {
      const present = await page
        .locator(sel)
        .first()
        .count()
        .then((n) => n > 0)
        .catch(() => false);
      if (present) return page.frameLocator(sel).first();
    }
    return null;
  }

  /** Click the vision-selected image tiles inside the challenge frame. Tiles are
   *  0-based left-to-right, top-to-bottom; the frame exposes them as a table of
   *  cells. Best-effort per tile so one un-clickable index never aborts the set. */
  private async clickChallengeTiles(page: import('playwright').Page, indices: number[]): Promise<void> {
    const frame = await this.challengeSolveFrame(page);
    if (!frame) return;
    for (const idx of indices) {
      const cell = frame.locator('table td, .task-image').nth(idx);
      await cell.click({ timeout: 2000 }).catch(() => {});
    }
  }

  /** Drag the slider handle by `offsetPx` via a trusted mouse gesture. */
  private async dragChallengeSlider(page: import('playwright').Page, offsetPx: number): Promise<void> {
    const box = await this.locateChallengeWidget(page).catch(() => null);
    if (!box || typeof page.mouse === 'undefined') return;
    await page.mouse.move(box.x, box.y).catch(() => {});
    await page.mouse.down().catch(() => {});
    await page.mouse.move(box.x + offsetPx, box.y, { steps: 12 }).catch(() => {});
    await page.mouse.up().catch(() => {});
  }

  /** Type the vision-read text-captcha answer into the answer field. */
  private async typeChallengeText(page: import('playwright').Page, text: string): Promise<void> {
    for (const sel of ['input[name*="captcha" i]', 'input[type="text"]']) {
      const input = page.locator(sel).first();
      const ok = await input.fill(text, { timeout: 2000 }).then(() => true).catch(() => false);
      if (ok) return;
    }
  }

  /** Press the verify/submit control of the challenge (grid + text captchas). */
  private async submitChallenge(page: import('playwright').Page): Promise<void> {
    const frame = await this.challengeSolveFrame(page);
    if (frame) {
      const verify = frame.locator('#recaptcha-verify-button, .button-submit');
      const clicked = await verify.first().click({ timeout: 2000 }).then(() => true).catch(() => false);
      if (clicked) return;
    }
    for (const sel of ['button[type="submit"]', 'input[type="submit"]', '.challenge-submit']) {
      const clicked = await page.locator(sel).first().click({ timeout: 2000 }).then(() => true).catch(() => false);
      if (clicked) return;
    }
  }

  /** Bring the browser window to the foreground (best-effort) for a human solve.
   *  A no-op on headless / stubbed pages. */
  private async bringToFront(page: import('playwright').Page): Promise<void> {
    if (typeof page.bringToFront === 'function') {
      await page.bringToFront();
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;

    for (const [type, typePool] of this.pools) {
      for (const [, timer] of typePool.idleTimers) {
        clearTimeout(timer);
      }
      typePool.idleTimers.clear();

      const closePromises = typePool.pool.map(ctx => ctx.close().catch(() => {}));
      typePool.pool = [];
      await Promise.all(closePromises);

      if (typePool.browser) {
        await typePool.browser.close().catch(() => {});
        typePool.browser = null;
      }

      typePool.activeCount = 0;
      log.debug('browser pool shut down', { type });
    }
  }
}

// Backwards-compatible wrapper for existing code
export class BrowserPool extends MultiBrowserPool {
  private readonly singleType: BrowserType;

  constructor(options?: BrowserPoolOptions) {
    const type = options?.browserType ?? 'chromium';
    super({
      browserTypes: [type],
    });
    this.singleType = type;
  }

  async acquire(): Promise<BrowserContext> {
    return this.acquireForType(this.singleType);
  }

  release(ctx: BrowserContext): void {
    this.releaseForType(this.singleType, ctx);
  }
}
