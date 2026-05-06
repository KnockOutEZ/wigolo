import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { contentAppearsEmpty } from './content-check.js';
import { getAuthOptions } from './auth.js';
import { fetchWithPlaywright, shouldEscalate } from './playwright-tier.js';
import type { RawFetchResult, BrowserAction, Mode, StageError } from '../types.js';

export interface RouterFetchOptions {
  renderJs?: 'auto' | 'always' | 'never';
  useAuth?: boolean;
  headers?: Record<string, string>;
  screenshot?: boolean;
  actions?: BrowserAction[];
  force_refresh?: boolean;
  mode?: Mode;
}

export interface HttpClient {
  fetch(
    url: string,
    options?: { headers?: Record<string, string>; timeoutMs?: number },
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
    options?: { headers?: Record<string, string>; storageStatePath?: string; userDataDir?: string; screenshot?: boolean; actions?: BrowserAction[]; cdpUrl?: string },
  ): Promise<RawFetchResult>;
}

export type HttpFetcher = (
  url: string,
  options?: { headers?: Record<string, string>; timeoutMs?: number },
) => Promise<{ url: string; html: string; text: string }>;

export type PlaywrightFetcher = (
  url: string,
  options?: { timeoutMs?: number },
) => Promise<{ html: string; text: string }>;

export interface SmartRouterOptions {
  httpClient?: HttpClient;
  browserPool?: BrowserPoolInterface;
  httpFetcher?: HttpFetcher;
  playwrightFetcher?: PlaywrightFetcher;
}

interface DomainStats {
  failureCount: number;
  preferPlaywright: boolean;
}

export class SmartRouter {
  private readonly domainMap = new Map<string, DomainStats>();
  private readonly httpClient?: HttpClient;
  private readonly browserPool?: BrowserPoolInterface;
  private readonly httpFetcher: HttpFetcher;
  private readonly playwrightFetcher: PlaywrightFetcher;

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
        'playwrightFetcher' in httpClientOrOptions)
    ) {
      const opts = httpClientOrOptions as SmartRouterOptions;
      this.httpClient = opts.httpClient;
      this.browserPool = opts.browserPool;
      this.httpFetcher = opts.httpFetcher ?? this.makeDefaultHttpFetcher();
      this.playwrightFetcher = opts.playwrightFetcher ?? fetchWithPlaywright;
      return;
    } else {
      // Backwards-compat: single HttpClient positional (unusual but safe)
      this.httpClient = httpClientOrOptions as HttpClient;
    }
    this.httpFetcher = this.makeDefaultHttpFetcher();
    this.playwrightFetcher = fetchWithPlaywright;
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
    const { renderJs = 'auto', useAuth = false, headers, screenshot, actions, mode } = options;
    const config = getConfig();
    const logger = createLogger('fetch');
    const threshold = config.browserFallbackThreshold;
    const domain = new URL(url).hostname;

    // Stealth mode: static fetch first, escalate to Playwright when content is thin.
    if (mode === 'stealth') {
      logger.debug('routing to stealth (static then escalate)', { url });
      const staticResult = await this.httpFetcher(url, { headers });
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
        const pw = await this.playwrightFetcher(url);
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
        throw err;
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
      });
      this.ensureStats(domain);
      const raw = this.toRawFetchResult(result);
      raw.jsRequired = contentAppearsEmpty(result.html);
      return raw;
    }

    // Actions always force Playwright --- actions need a live browser page
    if (actions && actions.length > 0) {
      if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
      const authOptions = useAuth ? (await getAuthOptions() ?? {}) : {};
      logger.debug('routing to playwright', { url, reason: 'actions present' });
      return this.browserPool.fetchWithBrowser(url, { headers, screenshot, actions, ...authOptions });
    }

    // Always Playwright for auth or explicit override
    if (renderJs === 'always' || useAuth) {
      if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
      const authOptions = useAuth ? (await getAuthOptions() ?? {}) : {};
      logger.debug('routing to playwright', { url, reason: useAuth ? 'auth' : 'render_js=always' });
      return this.browserPool.fetchWithBrowser(url, { headers, screenshot, ...authOptions });
    }

    // HTTP only, no fallback
    if (renderJs === 'never') {
      if (!this.httpClient) throw new Error('SmartRouter: httpClient not configured');
      logger.debug('routing to http (never)', { url });
      const result = await this.httpClient.fetch(url, { headers });
      this.ensureStats(domain);
      return this.toRawFetchResult(result);
    }

    // auto: check if domain is already marked for Playwright
    const stats = this.ensureStats(domain);

    if (stats.preferPlaywright) {
      if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
      logger.debug('routing to playwright (domain marked)', { url, domain });
      return this.browserPool.fetchWithBrowser(url, { headers, screenshot });
    }

    // Try HTTP first
    try {
      if (!this.httpClient) throw new Error('SmartRouter: httpClient not configured');
      const result = await this.httpClient.fetch(url, { headers });

      // Check for SPA shell / empty content
      if (contentAppearsEmpty(result.html)) {
        if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
        logger.info('SPA shell detected, marking domain for playwright', { url, domain });
        stats.preferPlaywright = true;
        return this.browserPool.fetchWithBrowser(url, { headers, screenshot });
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

      if (stats.failureCount >= threshold) {
        if (!this.browserPool) throw new Error('SmartRouter: browserPool not configured');
        logger.info('failure threshold reached, marking domain for playwright', { url, domain, threshold });
        stats.preferPlaywright = true;
        return this.browserPool.fetchWithBrowser(url, { headers, screenshot });
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
      stats = { failureCount: 0, preferPlaywright: false };
      this.domainMap.set(domain, stats);
    }
    return stats;
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
}
