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
import { pollUntilCleared } from './challenge-completion.js';
import { resolveStealthUA, stealthLaunchArgs, stealthContextOptions, STEALTH_INIT_SCRIPT } from './stealth.js';
import { recordDomainClearance, clearDomainClearance } from '../cache/store.js';
import { CLEARANCE_COOKIE_NAME, clearanceExpiresIso } from './clearance-reuse.js';
import { guardResolvedHost } from '../watch/ssrf.js';
import type { RawFetchResult, BrowserType, ActionResult, BrowserAction } from '../types.js';

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
 * Thrown when the browser tier lands on a hard bot-protection challenge page
 * that does not clear within the settle window. Carries a structured code so
 * the router can map it to a `blocked_by_challenge` stage error instead of
 * hanging on the full navigation timeout. Message + hint use capability
 * language (never vendor internals).
 */
export class ChallengeBlockedError extends Error {
  readonly code = 'blocked_by_challenge' as const;
  readonly hint: string;
  constructor(
    public readonly targetUrl: string,
    message = "The site's bot protection served a challenge page that could not be cleared automatically",
    hint = 'Retry with use_auth: true using a real browser session, or fetch an alternate source for this content',
  ) {
    super(message);
    this.name = 'ChallengeBlockedError';
    this.hint = hint;
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

  async fetchWithBrowser(url: string, options: BrowserFetchOptions = {}): Promise<RawFetchResult> {
    // Bail out immediately if the caller's budget is already exhausted.
    if (options.signal?.aborted) throw options.signal.reason;

    // Monotonic start for the challenge-completion remaining-budget math below.
    const fetchStartMs = Date.now();
    const config = getConfig();
    const navTimeoutMs = options.timeoutMs ?? config.playwrightNavTimeoutMs;

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

    // Stealth applies only to the launch path — the CDP path connects to an
    // external browser that owns its own fingerprint.
    const useStealth = options.stealth === true && !options.cdpUrl;

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
        const launcher = getLauncher(resolvedType);
        const cfgProxy = getConfig();
        const proxy = playwrightProxyOption(cfgProxy.proxyUrl, cfgProxy.useProxy);
        dedicatedBrowser = await launcher.launch({
          headless: true,
          args: stealthLaunchArgs(resolvedType),
          env: sanitizedChildEnv({ stripProxy: true }),
          ...(proxy ? { proxy } : {}),
        });
        advertisedUa = resolveStealthUA();
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
            log.warn('bot-protection challenge did not clear within completion window, fast-failing', { url, statusCode });
            throw new ChallengeBlockedError(url);
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
        throw new ChallengeBlockedError(url);
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
