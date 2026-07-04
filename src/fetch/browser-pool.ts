import { chromium, firefox, webkit, type Browser, type BrowserContext, type Download } from 'playwright';
import { readFile } from 'node:fs/promises';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { BrowserSelector, type SelectionStrategy } from './browser-selector.js';
import { executeActions } from './action-executor.js';
import { HYDRATION_PROBE_SOURCE } from './hydration-probe.js';
import { abortRejection } from '../util/abort.js';
import type { RawFetchResult, BrowserType, ActionResult, BrowserAction } from '../types.js';

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
      log.debug('launching browser', { type });
      typePool.browser = await launcher.launch({ headless: true });
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

  async fetchWithBrowser(url: string, options: BrowserFetchOptions = {}): Promise<RawFetchResult> {
    // Bail out immediately if the caller's budget is already exhausted.
    if (options.signal?.aborted) throw options.signal.reason;

    const config = getConfig();
    const navTimeoutMs = options.timeoutMs ?? config.playwrightNavTimeoutMs;
    const loadTimeoutMs = config.playwrightLoadTimeoutMs;

    let ctx: BrowserContext;
    let cdpBrowser: Browser | null = null;
    let resolvedType: BrowserType;

    if (options.cdpUrl) {
      // CDP is always Chromium
      resolvedType = 'chromium';
      try {
        log.info('connecting via CDP', { cdpUrl: options.cdpUrl });
        cdpBrowser = await chromium.connectOverCDP(options.cdpUrl);
        const contexts = cdpBrowser.contexts();
        ctx = contexts.length > 0 ? contexts[0] : await cdpBrowser.newContext();
      } catch (err) {
        log.warn('CDP connection failed, falling back to launch', {
          cdpUrl: options.cdpUrl,
          error: err instanceof Error ? err.message : String(err),
        });
        ctx = await this.acquireForType(resolvedType);
      }
    } else {
      resolvedType = this.resolveType(options.browserType, url);
      log.debug('fetching with browser', { url, type: resolvedType });
      ctx = await this.acquireForType(resolvedType);
    }

    const page = await ctx.newPage();

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

    try {
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
                method: 'playwright',
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

      // A fast goto can win its race while the budget is already exhausted —
      // bail before entering the post-goto waits so a never-networkidle SPA
      // can't hold the slot past the stage budget.
      if (options.signal?.aborted) throw options.signal.reason;

      try {
        // Race the networkidle wait against abort so an abort DURING the wait
        // is honored deterministically (not via page.close-propagation timing).
        // The normal timeout still resolves through waitForLoadState; only the
        // abort reason propagates out (rethrown below).
        await Promise.race([
          page.waitForLoadState('networkidle', { timeout: loadTimeoutMs }),
          abortRejection(options.signal),
        ]);
      } catch (err) {
        if (options.signal?.aborted) throw err;
        log.debug('networkidle timeout, using page content as-is', { url, type: resolvedType });
      }

      // SPAs (React Router, VitePress, Docusaurus, ...) ship a populated
      // nav-shell that clears networkidle while the article body is empty.
      // Wait briefly for hydrated content per the shared probe so search +
      // crawl + find_similar fetches don't leak nav-only shells. See
      // src/fetch/hydration-probe.ts for the predicate + selector set.
      if (typeof page.waitForFunction === 'function') {
        const hydrationBudget = Math.min(8000, Math.max(1500, Math.floor(navTimeoutMs / 4)));
        // Swallow the normal hydration-probe timeout (best-effort wait), but
        // race against abort so an abort here rejects promptly. Re-throw only
        // when the signal aborted.
        await Promise.race([
          page.waitForFunction(HYDRATION_PROBE_SOURCE, undefined, {
            timeout: hydrationBudget,
          }).catch(() => undefined),
          abortRejection(options.signal),
        ]).catch((err) => {
          if (options.signal?.aborted) throw err;
        });
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
        method: 'playwright',
        headers: responseHeaders,
        screenshot: screenshotBase64,
        actionResults,
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
