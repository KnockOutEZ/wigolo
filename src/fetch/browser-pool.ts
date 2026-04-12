import { chromium, firefox, webkit, type Browser, type BrowserContext } from 'playwright';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { RawFetchResult, BrowserType } from '../types.js';

export interface BrowserFetchOptions {
  timeoutMs?: number;
  storageStatePath?: string;
  userDataDir?: string;
  headers?: Record<string, string>;
  screenshot?: boolean;
}

export interface BrowserPoolOptions {
  browserType?: BrowserType;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private pool: BrowserContext[] = [];
  private activeCount = 0;
  private waitQueue: Array<(ctx: BrowserContext) => void> = [];
  private idleTimers = new Map<BrowserContext, ReturnType<typeof setTimeout>>();
  private shutdownCalled = false;
  private readonly browserType: BrowserType;

  constructor(options?: BrowserPoolOptions) {
    this.browserType = options?.browserType ?? 'chromium';
  }

  private async launchBrowser(): Promise<Browser> {
    if (!this.browser) {
      const launcher = this.browserType === 'firefox' ? firefox
        : this.browserType === 'webkit' ? webkit
        : chromium;
      this.browser = await launcher.launch({ headless: true });
    }
    return this.browser;
  }

  async acquire(): Promise<BrowserContext> {
    const config = getConfig();
    const maxBrowsers = config.maxBrowsers;

    if (this.pool.length > 0) {
      const ctx = this.pool.pop()!;
      const timer = this.idleTimers.get(ctx);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.idleTimers.delete(ctx);
      }
      return ctx;
    }

    if (this.activeCount < maxBrowsers) {
      this.activeCount++;
      const browser = await this.launchBrowser();
      return browser.newContext();
    }

    return new Promise<BrowserContext>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(ctx: BrowserContext): void {
    const config = getConfig();
    const idleTimeoutMs = config.browserIdleTimeoutMs;

    if (this.waitQueue.length > 0) {
      const resolve = this.waitQueue.shift()!;
      resolve(ctx);
      return;
    }

    this.pool.push(ctx);

    const timer = setTimeout(() => {
      const idx = this.pool.indexOf(ctx);
      if (idx !== -1) {
        this.pool.splice(idx, 1);
        this.idleTimers.delete(ctx);
        this.activeCount = Math.max(0, this.activeCount - 1);
        ctx.close().catch(() => {});
      }
    }, idleTimeoutMs);

    this.idleTimers.set(ctx, timer);
  }

  async fetchWithBrowser(url: string, options: BrowserFetchOptions = {}): Promise<RawFetchResult> {
    const config = getConfig();
    const logger = createLogger('fetch');
    const navTimeoutMs = options.timeoutMs ?? config.playwrightNavTimeoutMs;
    const loadTimeoutMs = config.playwrightLoadTimeoutMs;

    const ctx = await this.acquire();
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
        // networkidle timeout is non-fatal — page content is still usable
        logger.debug('networkidle timeout, using page content as-is', { url });
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
      };
    } finally {
      await page.close();
      this.release(ctx);
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;

    for (const [, timer] of this.idleTimers) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    const closePromises = this.pool.map((ctx) => ctx.close().catch(() => {}));
    this.pool = [];
    await Promise.all(closePromises);

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    this.activeCount = 0;
  }
}
