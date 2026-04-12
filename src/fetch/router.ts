import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { contentAppearsEmpty } from './content-check.js';
import { getAuthOptions } from './auth.js';
import type { RawFetchResult } from '../types.js';

export interface RouterFetchOptions {
  renderJs?: 'auto' | 'always' | 'never';
  useAuth?: boolean;
  headers?: Record<string, string>;
  screenshot?: boolean;
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
    options?: { headers?: Record<string, string>; storageStatePath?: string; userDataDir?: string; screenshot?: boolean },
  ): Promise<RawFetchResult>;
}

interface DomainStats {
  failureCount: number;
  preferPlaywright: boolean;
}

export class SmartRouter {
  private readonly domainMap = new Map<string, DomainStats>();

  constructor(
    private readonly httpClient: HttpClient,
    private readonly browserPool: BrowserPoolInterface,
  ) {}

  async fetch(url: string, options: RouterFetchOptions = {}): Promise<RawFetchResult> {
    const { renderJs = 'auto', useAuth = false, headers, screenshot } = options;
    const config = getConfig();
    const logger = createLogger('fetch');
    const threshold = config.browserFallbackThreshold;
    const domain = new URL(url).hostname;

    // Always Playwright for auth or explicit override
    if (renderJs === 'always' || useAuth) {
      const authOptions = useAuth ? (getAuthOptions() ?? {}) : {};
      logger.debug('routing to playwright', { url, reason: useAuth ? 'auth' : 'render_js=always' });
      return this.browserPool.fetchWithBrowser(url, { headers, screenshot, ...authOptions });
    }

    // HTTP only, no fallback
    if (renderJs === 'never') {
      logger.debug('routing to http (never)', { url });
      const result = await this.httpClient.fetch(url, { headers });
      this.ensureStats(domain);
      return this.toRawFetchResult(result);
    }

    // auto: check if domain is already marked for Playwright
    const stats = this.ensureStats(domain);

    if (stats.preferPlaywright) {
      logger.debug('routing to playwright (domain marked)', { url, domain });
      return this.browserPool.fetchWithBrowser(url, { headers, screenshot });
    }

    // Try HTTP first
    try {
      const result = await this.httpClient.fetch(url, { headers });

      // Check for SPA shell / empty content
      if (contentAppearsEmpty(result.html)) {
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
