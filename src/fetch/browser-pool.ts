import { chromium, firefox, webkit, type Browser, type BrowserContext } from 'playwright';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { BrowserSelector, type SelectionStrategy } from './browser-selector.js';
import { executeActions } from './action-executor.js';
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
      return browser.newContext();
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

    if (options.headers) {
      await page.setExtraHTTPHeaders(options.headers);
    }

    let statusCode = 200;
    let contentType = '';
    let responseHeaders: Record<string, string> = {};
    let finalUrl = url;

    try {
      const response = await page.goto(url, {
        timeout: navTimeoutMs,
        waitUntil: 'domcontentloaded',
      });

      if (response) {
        statusCode = response.status();
        finalUrl = response.url();
        const rawHeaders = response.headers();
        responseHeaders = rawHeaders;
        contentType = rawHeaders['content-type'] ?? '';
      }

      try {
        await page.waitForLoadState('networkidle', { timeout: loadTimeoutMs });
      } catch {
        log.debug('networkidle timeout, using page content as-is', { url, type: resolvedType });
      }

      let actionResults: ActionResult[] | undefined;
      if (options.actions && options.actions.length > 0) {
        actionResults = await executeActions(page, options.actions);
      }

      const html = await page.content();

      let screenshotBase64: string | undefined;
      if (options.screenshot) {
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
      };
    } finally {
      await page.close();
      if (cdpBrowser) {
        await cdpBrowser.close().catch(() => {});
      } else {
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
