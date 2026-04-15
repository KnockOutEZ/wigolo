import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({
    lightpandaUrl: 'http://localhost:9222',
    lightpandaEnabled: true,
    lightpandaFailureThreshold: 3,
  })),
}));

vi.mock('playwright', () => ({
  chromium: {
    connectOverCDP: vi.fn(),
  },
}));

vi.mock('../../../src/cache/db.js', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../../../src/fetch/cdp-client.js', () => ({
  isCDPReachable: vi.fn(),
}));

import { chromium } from 'playwright';
import { getConfig } from '../../../src/config.js';
import { getDatabase } from '../../../src/cache/db.js';
import { isCDPReachable } from '../../../src/fetch/cdp-client.js';
import {
  LightpandaAdapter,
  shouldUseLightpanda,
  recordSuccess,
  recordFailure,
  getDomainStats,
} from '../../../src/fetch/lightpanda.js';

const mockConnectOverCDP = vi.mocked(chromium.connectOverCDP);
const mockIsCDPReachable = vi.mocked(isCDPReachable);
const mockGetConfig = vi.mocked(getConfig);
const mockGetDatabase = vi.mocked(getDatabase);

let mockDb: any;

beforeEach(() => {
  vi.clearAllMocks();

  mockDb = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      run: vi.fn(),
    }),
  };
  mockGetDatabase.mockReturnValue(mockDb);
  mockGetConfig.mockReturnValue({
    lightpandaUrl: 'http://localhost:9222',
    lightpandaEnabled: true,
    lightpandaFailureThreshold: 3,
  } as any);
});

describe('shouldUseLightpanda', () => {
  it('returns false when lightpanda is disabled', () => {
    mockGetConfig.mockReturnValue({ lightpandaEnabled: false } as any);
    expect(shouldUseLightpanda('example.com')).toBe(false);
  });

  it('returns false when lightpandaUrl is null', () => {
    mockGetConfig.mockReturnValue({
      lightpandaEnabled: true,
      lightpandaUrl: null,
      lightpandaFailureThreshold: 3,
    } as any);
    expect(shouldUseLightpanda('example.com')).toBe(false);
  });

  it('returns true for a new domain', () => {
    mockDb.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) });
    expect(shouldUseLightpanda('new-domain.com')).toBe(true);
  });

  it('returns false for domain with prefer_chromium flag', () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({ prefer_chromium: 1, failure_count: 5 }),
    });
    expect(shouldUseLightpanda('bad-domain.com')).toBe(false);
  });

  it('returns true for domain with low failure count', () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({ prefer_chromium: 0, failure_count: 1 }),
    });
    expect(shouldUseLightpanda('ok-domain.com')).toBe(true);
  });

  it('returns false when failure count >= threshold', () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({ prefer_chromium: 0, failure_count: 3 }),
    });
    expect(shouldUseLightpanda('failing-domain.com')).toBe(false);
  });

  it('handles DB read errors gracefully (returns false)', () => {
    mockDb.prepare.mockImplementation(() => { throw new Error('db error'); });
    expect(shouldUseLightpanda('any.com')).toBe(false);
  });
});

describe('recordSuccess', () => {
  it('upserts success count for domain', () => {
    const mockRun = vi.fn();
    mockDb.prepare.mockReturnValue({ run: mockRun });

    recordSuccess('example.com');
    expect(mockDb.prepare).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledWith('example.com');
  });

  it('does not throw on DB error', () => {
    mockDb.prepare.mockImplementation(() => { throw new Error('db'); });
    expect(() => recordSuccess('example.com')).not.toThrow();
  });
});

describe('recordFailure', () => {
  it('upserts failure count for domain with threshold', () => {
    const mockRun = vi.fn();
    mockDb.prepare.mockReturnValue({ run: mockRun });

    recordFailure('example.com');
    expect(mockDb.prepare).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledWith('example.com', 3);
  });

  it('does not throw on DB error', () => {
    mockDb.prepare.mockImplementation(() => { throw new Error('db'); });
    expect(() => recordFailure('example.com')).not.toThrow();
  });
});

describe('getDomainStats', () => {
  it('returns stats for tracked domain', () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        domain: 'example.com',
        success_count: 10,
        failure_count: 2,
        prefer_chromium: 0,
        last_success: '2026-04-14T12:00:00',
        last_failure: null,
      }),
    });

    const stats = getDomainStats('example.com');
    expect(stats).not.toBeNull();
    expect(stats!.successCount).toBe(10);
    expect(stats!.failureCount).toBe(2);
    expect(stats!.preferChromium).toBe(false);
  });

  it('returns null for untracked domain', () => {
    mockDb.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) });
    expect(getDomainStats('unknown.com')).toBeNull();
  });

  it('returns null on DB error', () => {
    mockDb.prepare.mockImplementation(() => { throw new Error('db'); });
    expect(getDomainStats('any.com')).toBeNull();
  });
});

describe('LightpandaAdapter', () => {
  it('connects via CDP when available', async () => {
    const mockBrowser = {
      contexts: vi.fn().mockReturnValue([]),
      newContext: vi.fn().mockResolvedValue({ newPage: vi.fn() }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockConnectOverCDP.mockResolvedValue(mockBrowser as any);
    mockIsCDPReachable.mockResolvedValue(true);

    const adapter = new LightpandaAdapter();
    const result = await adapter.connect();

    expect(result.connected).toBe(true);
    expect(mockConnectOverCDP).toHaveBeenCalledWith('http://localhost:9222');
  });

  it('returns connected=false when CDP is unreachable', async () => {
    mockIsCDPReachable.mockResolvedValue(false);

    const adapter = new LightpandaAdapter();
    const result = await adapter.connect();

    expect(result.connected).toBe(false);
    expect(mockConnectOverCDP).not.toHaveBeenCalled();
  });

  it('returns connected=false when connectOverCDP throws', async () => {
    mockIsCDPReachable.mockResolvedValue(true);
    mockConnectOverCDP.mockRejectedValue(new Error('connection refused'));

    const adapter = new LightpandaAdapter();
    const result = await adapter.connect();

    expect(result.connected).toBe(false);
  });

  it('disconnects cleanly', async () => {
    const mockClose = vi.fn().mockResolvedValue(undefined);
    const mockBrowser = {
      contexts: vi.fn().mockReturnValue([]),
      newContext: vi.fn().mockResolvedValue({ newPage: vi.fn() }),
      close: mockClose,
    };
    mockConnectOverCDP.mockResolvedValue(mockBrowser as any);
    mockIsCDPReachable.mockResolvedValue(true);

    const adapter = new LightpandaAdapter();
    await adapter.connect();
    await adapter.disconnect();

    expect(mockClose).toHaveBeenCalled();
  });

  it('disconnect is safe to call when not connected', async () => {
    const adapter = new LightpandaAdapter();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it('isHealthy returns false when not connected', async () => {
    const adapter = new LightpandaAdapter();
    expect(await adapter.isHealthy()).toBe(false);
  });

  it('isHealthy checks CDP reachability', async () => {
    mockIsCDPReachable.mockResolvedValue(true);
    const mockBrowser = {
      contexts: vi.fn().mockReturnValue([]),
      newContext: vi.fn().mockResolvedValue({ newPage: vi.fn() }),
      close: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
    };
    mockConnectOverCDP.mockResolvedValue(mockBrowser as any);

    const adapter = new LightpandaAdapter();
    await adapter.connect();

    mockIsCDPReachable.mockResolvedValue(true);
    expect(await adapter.isHealthy()).toBe(true);
  });

  it('getContext returns context from connected browser', async () => {
    const mockPage = { goto: vi.fn() };
    const mockContext = { newPage: vi.fn().mockResolvedValue(mockPage) };
    const mockBrowser = {
      contexts: vi.fn().mockReturnValue([mockContext]),
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn(),
    };
    mockConnectOverCDP.mockResolvedValue(mockBrowser as any);
    mockIsCDPReachable.mockResolvedValue(true);

    const adapter = new LightpandaAdapter();
    await adapter.connect();
    const ctx = await adapter.getContext();
    expect(ctx).toBe(mockContext);
  });

  it('getContext creates new context when none exist', async () => {
    const mockContext = { newPage: vi.fn() };
    const mockBrowser = {
      contexts: vi.fn().mockReturnValue([]),
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn(),
    };
    mockConnectOverCDP.mockResolvedValue(mockBrowser as any);
    mockIsCDPReachable.mockResolvedValue(true);

    const adapter = new LightpandaAdapter();
    await adapter.connect();
    const ctx = await adapter.getContext();
    expect(ctx).toBe(mockContext);
    expect(mockBrowser.newContext).toHaveBeenCalled();
  });

  it('getContext returns null when not connected and connect fails', async () => {
    mockIsCDPReachable.mockResolvedValue(false);
    const adapter = new LightpandaAdapter();
    const ctx = await adapter.getContext();
    expect(ctx).toBeNull();
  });

  it('getBrowser returns null when not connected', () => {
    const adapter = new LightpandaAdapter();
    expect(adapter.getBrowser()).toBeNull();
  });

  it('getBrowser returns browser after connect', async () => {
    const mockBrowser = {
      contexts: vi.fn().mockReturnValue([]),
      newContext: vi.fn(),
      close: vi.fn(),
    };
    mockConnectOverCDP.mockResolvedValue(mockBrowser as any);
    mockIsCDPReachable.mockResolvedValue(true);

    const adapter = new LightpandaAdapter();
    await adapter.connect();
    expect(adapter.getBrowser()).toBe(mockBrowser);
  });

  it('uses custom URL when provided', async () => {
    mockIsCDPReachable.mockResolvedValue(true);
    const mockBrowser = {
      contexts: vi.fn().mockReturnValue([]),
      newContext: vi.fn(),
      close: vi.fn(),
    };
    mockConnectOverCDP.mockResolvedValue(mockBrowser as any);

    const adapter = new LightpandaAdapter('http://custom:9333');
    await adapter.connect();
    expect(mockConnectOverCDP).toHaveBeenCalledWith('http://custom:9333');
  });
});
