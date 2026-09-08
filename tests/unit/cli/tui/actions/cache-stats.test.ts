/**
 * Tests for the cacheStats action.
 *
 * Why: cacheStats wraps the public cache API and must return the same shape
 * so the Dashboard can display accurate entry counts and age without
 * reaching into SQLite directly (SP5 spec constraint).
 * These tests stub the module-level import to avoid spinning up a real DB.
 *
 * The open-the-database arms cover K13: `wigolo config --cache-stats` reported
 * "Database not initialized" and exited 1 on the same data directory where
 * `wigolo cache --stats` succeeded, purely because nothing on the config path
 * had opened the database. The action opens it, so both callers work.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Stub the cache store module BEFORE importing the action
vi.mock('../../../../../src/cache/store.js', () => ({
  getCacheStats: vi.fn(() => ({
    total_urls: 42,
    total_size_mb: 1.5,
    oldest: '2025-01-01 00:00:00',
    newest: '2025-06-01 00:00:00',
  })),
}));

// The action opens the database when the process has not; stub the module so a
// unit test never creates a real SQLite file.
vi.mock('../../../../../src/cache/db.js', () => ({
  isDatabaseInitialized: vi.fn(() => false),
  initDatabase: vi.fn(),
}));

import {
  getCacheStatsAction,
  type CacheStatsResult,
} from '../../../../../src/cli/tui/actions/cache-stats.js';
import { getCacheStats } from '../../../../../src/cache/store.js';
import { isDatabaseInitialized } from '../../../../../src/cache/db.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getCacheStatsAction — normal path', () => {
  it('returns totalEntries, sizeMb, oldest, newest', async () => {
    const result = await getCacheStatsAction({ dataDir: '/tmp/sd34-unused', openDatabase: () => {} });
    expect(result.totalEntries).toBe(42);
    expect(result.sizeMb).toBeCloseTo(1.5);
    expect(result.oldest).toBe('2025-01-01 00:00:00');
    expect(result.newest).toBe('2025-06-01 00:00:00');
    expect(result.error).toBeUndefined();
  });

  it('delegates to getCacheStats from cache/store (public API — no internal SQLite)', async () => {
    await getCacheStatsAction({ dataDir: '/tmp/sd34-unused', openDatabase: () => {} });
    expect(getCacheStats).toHaveBeenCalledOnce();
  });
});

describe('getCacheStatsAction — empty cache', () => {
  it('returns zero counts when cache is empty', async () => {
    vi.mocked(getCacheStats).mockReturnValueOnce({
      total_urls: 0,
      total_size_mb: 0,
      oldest: '',
      newest: '',
    });
    const result = await getCacheStatsAction({ dataDir: '/tmp/sd34-unused', openDatabase: () => {} });
    expect(result.totalEntries).toBe(0);
    expect(result.sizeMb).toBe(0);
  });
});

describe('getCacheStatsAction — error path', () => {
  it('returns an error result when getCacheStats throws', async () => {
    vi.mocked(getCacheStats).mockImplementationOnce(() => {
      throw new Error('db locked');
    });
    const result = await getCacheStatsAction({ dataDir: '/tmp/sd34-unused', openDatabase: () => {} });
    expect(result.error).toMatch(/db locked/);
    expect(result.totalEntries).toBe(0);
  });
});

describe('getCacheStatsAction — opening the database (K13)', () => {
  it('opens the database at the given data directory when none is open', async () => {
    const openDatabase = vi.fn();
    const result = await getCacheStatsAction({ dataDir: '/tmp/sd34-datadir', openDatabase });
    expect(openDatabase).toHaveBeenCalledOnce();
    expect(openDatabase).toHaveBeenCalledWith('/tmp/sd34-datadir');
    // The whole point: no "Database not initialized" and no non-zero exit.
    expect(result.error).toBeUndefined();
  });

  it('leaves an already-open database alone', async () => {
    vi.mocked(isDatabaseInitialized).mockReturnValueOnce(true);
    const openDatabase = vi.fn();
    await getCacheStatsAction({ dataDir: '/tmp/sd34-datadir', openDatabase });
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('reports a failure to open rather than pretending the cache is empty', async () => {
    const result = await getCacheStatsAction({
      dataDir: '/tmp/sd34-datadir',
      openDatabase: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(result.error).toMatch(/EACCES/);
    expect(result.totalEntries).toBe(0);
  });
});

describe('CacheStatsResult shape', () => {
  it('result has expected fields', async () => {
    const result: CacheStatsResult = await getCacheStatsAction({ dataDir: '/tmp/sd34-unused', openDatabase: () => {} });
    expect(typeof result.totalEntries).toBe('number');
    expect(typeof result.sizeMb).toBe('number');
    expect(typeof result.oldest).toBe('string');
    expect(typeof result.newest).toBe('string');
  });
});
