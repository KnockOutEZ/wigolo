import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  getConfig: vi.fn(() => ({
    lightpandaUrl: 'http://localhost:9222',
    lightpandaEnabled: true,
    lightpandaFailureThreshold: 3,
    maxBrowsers: 3,
    playwrightNavTimeoutMs: 10000,
    playwrightLoadTimeoutMs: 15000,
    browserIdleTimeoutMs: 60000,
    browserFallbackThreshold: 3,
  })),
  resetConfig: vi.fn(),
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(),
    connectOverCDP: vi.fn(),
  },
  firefox: { launch: vi.fn() },
  webkit: { launch: vi.fn() },
}));

vi.mock('../../src/fetch/cdp-client.js', () => ({
  isCDPReachable: vi.fn(),
}));

vi.mock('../../src/cache/db.js', () => ({
  getDatabase: vi.fn(),
}));

import { isCDPReachable } from '../../src/fetch/cdp-client.js';
import { getDatabase } from '../../src/cache/db.js';
import { getConfig } from '../../src/config.js';
import { chromium } from 'playwright';
import {
  shouldUseLightpanda,
  recordSuccess,
  recordFailure,
  getDomainStats,
  LightpandaAdapter,
} from '../../src/fetch/lightpanda.js';

const mockConnectOverCDP = vi.mocked(chromium.connectOverCDP);
const mockIsCDPReachable = vi.mocked(isCDPReachable);
const mockGetDatabase = vi.mocked(getDatabase);

let mockDb: any;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      run: vi.fn(),
    }),
  };
  mockGetDatabase.mockReturnValue(mockDb);
});

describe('Lightpanda fallback flow', () => {
  it('tries Lightpanda first for new domain, falls back on failure', () => {
    expect(shouldUseLightpanda('new-site.com')).toBe(true);

    recordFailure('new-site.com');
    recordFailure('new-site.com');
    recordFailure('new-site.com');

    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({ failure_count: 3, prefer_chromium: 1 }),
      run: vi.fn(),
    });
    expect(shouldUseLightpanda('new-site.com')).toBe(false);
  });

  it('continues using Lightpanda for domains with successes', () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({ failure_count: 1, prefer_chromium: 0, success_count: 10 }),
      run: vi.fn(),
    });
    expect(shouldUseLightpanda('good-site.com')).toBe(true);
  });

  it('respects disabled flag globally', () => {
    vi.mocked(getConfig).mockReturnValue({
      lightpandaEnabled: false,
      lightpandaUrl: 'http://localhost:9222',
      lightpandaFailureThreshold: 3,
    } as any);

    expect(shouldUseLightpanda('any-site.com')).toBe(false);
  });

  it('getDomainStats returns null for untracked domains', () => {
    mockDb.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) });
    expect(getDomainStats('untracked.com')).toBeNull();
  });

  it('getDomainStats returns stats for tracked domains', () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        domain: 'tracked.com',
        success_count: 5,
        failure_count: 1,
        prefer_chromium: 0,
        last_success: '2026-04-14T12:00:00',
        last_failure: null,
      }),
    });
    const stats = getDomainStats('tracked.com');
    expect(stats).not.toBeNull();
    expect(stats!.successCount).toBe(5);
    expect(stats!.preferChromium).toBe(false);
  });

  it('LightpandaAdapter connects when CDP is reachable', async () => {
    mockIsCDPReachable.mockResolvedValue(true);
    const mockBrowser = {
      contexts: vi.fn().mockReturnValue([]),
      newContext: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
    };
    mockConnectOverCDP.mockResolvedValue(mockBrowser as any);

    const adapter = new LightpandaAdapter('http://localhost:9222');
    const result = await adapter.connect();

    expect(result.connected).toBe(true);
  });

  it('LightpandaAdapter fails gracefully when CDP unreachable', async () => {
    mockIsCDPReachable.mockResolvedValue(false);

    const adapter = new LightpandaAdapter('http://localhost:9222');
    const result = await adapter.connect();

    expect(result.connected).toBe(false);
    expect(result.error).toContain('not reachable');
  });

  it('adapter health check reflects connection state', async () => {
    mockIsCDPReachable.mockResolvedValue(false);

    const adapter = new LightpandaAdapter('http://localhost:9222');
    expect(await adapter.isHealthy()).toBe(false);
  });

  it('success recording does not throw on error', () => {
    mockDb.prepare.mockImplementation(() => { throw new Error('db locked'); });
    expect(() => recordSuccess('any.com')).not.toThrow();
  });

  it('failure recording does not throw on error', () => {
    mockDb.prepare.mockImplementation(() => { throw new Error('db locked'); });
    expect(() => recordFailure('any.com')).not.toThrow();
  });
});
