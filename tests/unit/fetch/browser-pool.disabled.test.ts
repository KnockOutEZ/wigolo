import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

/**
 * WHY (PR #724, CodeRabbit 4710534113): acquireForType must (1) reject a
 * disabled burst BEFORE reserving a slot, and (2) settle queued waiters when a
 * reservation fails — the old waitQueue only held resolve callbacks, so a
 * failed launch under maxBrowsers=1 left the head waiter hanging forever.
 */

const launchCalls: Array<Record<string, unknown>> = [];
let launchGate: Promise<never> | null = null;

function makeContext() {
  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(undefined),
    cookies: vi.fn().mockResolvedValue([]),
    addCookies: vi.fn().mockResolvedValue(undefined),
  };
}

function makeBrowser() {
  return {
    newContext: vi.fn().mockResolvedValue(makeContext()),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn(() => {
    launchCalls.push({});
    if (launchGate) return launchGate;
    return Promise.resolve(makeBrowser());
  });
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';
import type { BrowserType } from '../../../src/types.js';

/** Expose the protected acquire seam so queue/settle behaviour is assertable. */
class AcquireProbe extends MultiBrowserPool {
  acquire(type: BrowserType = 'chromium') {
    return this.acquireForType(type);
  }
}

const originalEnv = process.env;

describe('browser-pool acquire queue: disabled burst + launch failure (PR #724)', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, MAX_BROWSERS: '1', WIGOLO_BROWSER: 'auto' };
    launchCalls.length = 0;
    launchGate = null;
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  it('WIGOLO_BROWSER=off: concurrent acquires all reject browser_disabled without hanging', async () => {
    process.env.WIGOLO_BROWSER = 'off';
    resetConfig();
    const pool = new AcquireProbe();

    // Would hit the vitest timeout (hang) if a waiter was left unsettled.
    const results = await Promise.allSettled([pool.acquire(), pool.acquire(), pool.acquire()]);

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r.reason as { code?: string }).code).toBe('browser_disabled');
    }
    expect(launchCalls.length).toBe(0); // disabled never even tried to launch
    expect(pool.getStats()[0].activeCount).toBe(0); // no slot was reserved
  });

  it('a failed launch settles the queued waiter instead of hanging it (maxBrowsers=1)', async () => {
    let failLaunch!: (err: Error) => void;
    launchGate = new Promise<never>((_, reject) => {
      failLaunch = reject;
    });
    const pool = new AcquireProbe();

    const p1 = pool.acquire(); // reserves the single slot, blocks inside launch
    const p2 = pool.acquire(); // pool full -> queued waiter
    failLaunch(new Error('launch boom'));

    await expect(p1).rejects.toThrow('launch boom');
    // Without the settle fix this waiter never resolves and the test times out.
    await expect(p2).rejects.toThrow('launch boom');
    expect(pool.getStats()[0].activeCount).toBe(0); // slot rolled back, no leak
  });
});
