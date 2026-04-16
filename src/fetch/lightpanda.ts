import { chromium, type Browser, type BrowserContext } from 'playwright';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { isCDPReachable } from './cdp-client.js';
import { getDatabase } from '../cache/db.js';

const log = createLogger('fetch');

export interface DomainRoutingStats {
  domain: string;
  successCount: number;
  failureCount: number;
  preferChromium: boolean;
  lastSuccess?: string;
  lastFailure?: string;
}

export interface ConnectionResult {
  connected: boolean;
  error?: string;
}

export function shouldUseLightpanda(domain: string): boolean {
  try {
    const config = getConfig();
    if (!config.lightpandaEnabled || !config.lightpandaUrl) {
      return false;
    }

    const db = getDatabase();
    const row = db.prepare(
      'SELECT failure_count, prefer_chromium FROM lightpanda_routing WHERE domain = ?',
    ).get(domain) as { failure_count: number; prefer_chromium: number } | undefined;

    if (!row) return true;

    if (row.prefer_chromium === 1) {
      log.debug('domain prefers chromium over lightpanda', { domain });
      return false;
    }

    if (row.failure_count >= config.lightpandaFailureThreshold) {
      log.debug('domain failure threshold reached for lightpanda', {
        domain,
        failures: row.failure_count,
        threshold: config.lightpandaFailureThreshold,
      });
      return false;
    }

    return true;
  } catch (err) {
    log.warn('shouldUseLightpanda check failed, defaulting to chromium', {
      domain,
      error: String(err),
    });
    return false;
  }
}

export function recordSuccess(domain: string): void {
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO lightpanda_routing (domain, success_count, last_success, last_updated)
      VALUES (?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(domain) DO UPDATE SET
        success_count = success_count + 1,
        last_success = datetime('now'),
        last_updated = datetime('now')
    `).run(domain);

    log.debug('recorded lightpanda success', { domain });
  } catch (err) {
    log.warn('failed to record lightpanda success', { domain, error: String(err) });
  }
}

export function recordFailure(domain: string): void {
  try {
    const config = getConfig();
    const db = getDatabase();

    db.prepare(`
      INSERT INTO lightpanda_routing (domain, failure_count, last_failure, last_updated)
      VALUES (?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(domain) DO UPDATE SET
        failure_count = failure_count + 1,
        last_failure = datetime('now'),
        last_updated = datetime('now'),
        prefer_chromium = CASE
          WHEN failure_count + 1 >= ?
          THEN 1
          ELSE prefer_chromium
        END
    `).run(domain, config.lightpandaFailureThreshold);

    log.debug('recorded lightpanda failure', { domain });
  } catch (err) {
    log.warn('failed to record lightpanda failure', { domain, error: String(err) });
  }
}

export function getDomainStats(domain: string): DomainRoutingStats | null {
  try {
    const db = getDatabase();
    const row = db.prepare(
      'SELECT * FROM lightpanda_routing WHERE domain = ?',
    ).get(domain) as {
      domain: string;
      success_count: number;
      failure_count: number;
      prefer_chromium: number;
      last_success: string | null;
      last_failure: string | null;
    } | undefined;

    if (!row) return null;

    return {
      domain: row.domain,
      successCount: row.success_count,
      failureCount: row.failure_count,
      preferChromium: row.prefer_chromium === 1,
      lastSuccess: row.last_success ?? undefined,
      lastFailure: row.last_failure ?? undefined,
    };
  } catch (err) {
    log.warn('getDomainStats failed', { domain, error: String(err) });
    return null;
  }
}

export class LightpandaAdapter {
  private browser: Browser | null = null;
  private url: string;

  constructor(url?: string) {
    const config = getConfig();
    this.url = url ?? config.lightpandaUrl ?? 'http://localhost:9222';
  }

  async connect(): Promise<ConnectionResult> {
    try {
      const reachable = await isCDPReachable(this.url);
      if (!reachable) {
        log.debug('lightpanda CDP not reachable', { url: this.url });
        return { connected: false, error: 'CDP endpoint not reachable' };
      }

      this.browser = await chromium.connectOverCDP(this.url);
      log.info('connected to lightpanda via CDP', { url: this.url });
      return { connected: true };
    } catch (err) {
      log.warn('lightpanda connection failed', {
        url: this.url,
        error: err instanceof Error ? err.message : String(err),
      });
      this.browser = null;
      return {
        connected: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        log.debug('disconnected from lightpanda');
      }
    } catch (err) {
      log.warn('lightpanda disconnect error', { error: String(err) });
      this.browser = null;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      if (!this.browser) return false;

      if ('isConnected' in this.browser && typeof this.browser.isConnected === 'function') {
        if (!this.browser.isConnected()) return false;
      }

      return await isCDPReachable(this.url);
    } catch {
      return false;
    }
  }

  async getContext(): Promise<BrowserContext | null> {
    try {
      if (!this.browser) {
        const result = await this.connect();
        if (!result.connected || !this.browser) return null;
      }

      const contexts = this.browser.contexts();
      if (contexts.length > 0) return contexts[0];
      return await this.browser.newContext();
    } catch (err) {
      log.warn('failed to get lightpanda context', { error: String(err) });
      return null;
    }
  }

  getBrowser(): Browser | null {
    return this.browser;
  }
}
