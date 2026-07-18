import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// Shared mock state. Tracks dedicated-context lifecycle (created/closed) and
// lets a test hold goto open so two concurrent stealth fetches overlap.
interface StealthState {
  contextsCreated: number;
  contextsClosed: number;
  liveContexts: number;
  peakLiveContexts: number;
  addInitScriptCalls: number;
  browsersLaunched: number;
  browsersClosed: number;
  gotoHang: boolean;
  // When set, launcher.launch throws AFTER incrementing browsersLaunched=false
  // (no browser created) — simulates a launch failure during stealth setup.
  launchThrows: boolean;
  // When set, newContext throws after the browser is launched — simulates a
  // setup failure with a live throwaway browser that must be closed.
  newContextThrows: boolean;
  // Set by a test to be notified each time a context is created (so it can
  // sequence a second concurrent fetch precisely).
  onContextCreated?: () => void;
}

const state: StealthState = {
  contextsCreated: 0,
  contextsClosed: 0,
  liveContexts: 0,
  peakLiveContexts: 0,
  addInitScriptCalls: 0,
  browsersLaunched: 0,
  browsersClosed: 0,
  gotoHang: false,
  launchThrows: false,
  newContextThrows: false,
};

function makePage() {
  return {
    goto: vi.fn().mockImplementation(() => {
      if (state.gotoHang) return new Promise<never>(() => {});
      return Promise.resolve({
        status: () => 200,
        url: () => 'https://example.com',
        headers: () => ({ 'content-type': 'text/html' }),
      });
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue('<html><body>ok</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext() {
  state.contextsCreated++;
  state.liveContexts++;
  state.peakLiveContexts = Math.max(state.peakLiveContexts, state.liveContexts);
  state.onContextCreated?.();
  return {
    addInitScript: vi.fn().mockImplementation(() => {
      state.addInitScriptCalls++;
      return Promise.resolve(undefined);
    }),
    close: vi.fn().mockImplementation(() => {
      state.contextsClosed++;
      state.liveContexts--;
      return Promise.resolve(undefined);
    }),
    newPage: vi.fn().mockResolvedValue(makePage()),
    cookies: vi.fn().mockResolvedValue([]),
  };
}

function makeBrowser() {
  state.browsersLaunched++;
  return {
    newContext: vi.fn().mockImplementation(() => {
      if (state.newContextThrows) return Promise.reject(new Error('newContext boom'));
      return Promise.resolve(makeContext());
    }),
    close: vi.fn().mockImplementation(() => {
      state.browsersClosed++;
      return Promise.resolve(undefined);
    }),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation(() => {
    if (state.launchThrows) return Promise.reject(new Error('launch boom'));
    return Promise.resolve(makeBrowser());
  });
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

function resetState() {
  state.contextsCreated = 0;
  state.contextsClosed = 0;
  state.liveContexts = 0;
  state.peakLiveContexts = 0;
  state.addInitScriptCalls = 0;
  state.browsersLaunched = 0;
  state.browsersClosed = 0;
  state.gotoHang = false;
  state.launchThrows = false;
  state.newContextThrows = false;
  state.onContextCreated = undefined;
}

describe('browser-pool dedicated stealth context', () => {
  beforeEach(() => {
    resetConfig();
    resetState();
  });
  afterEach(async () => {
    resetConfig();
  });

  it('stealth:true creates a DEDICATED context that is CLOSED (not returned to the pool) at end', async () => {
    const pool = new MultiBrowserPool();
    // releaseForType is the pooled-return path — a dedicated stealth context
    // must never touch it.
    const proto = Object.getPrototypeOf(pool) as {
      releaseForType: (...args: unknown[]) => void;
    };
    const releaseSpy = vi.spyOn(proto, 'releaseForType');

    const result = await pool.fetchWithBrowser('https://blocked.example', { stealth: true });
    expect(result.method).toBe('browser');

    // The dedicated context was created, patched with the init script, then closed.
    expect(state.addInitScriptCalls).toBe(1);
    expect(state.contextsCreated).toBe(1);
    expect(state.contextsClosed).toBe(1);
    // Never handed back to the shared pool.
    expect(releaseSpy).not.toHaveBeenCalled();
    // No pooled context lingers.
    const stats = pool.getStats();
    expect(stats[0].pooledCount).toBe(0);

    releaseSpy.mockRestore();
    await pool.shutdown();
  });

  it('closes the dedicated context even when the fetch is aborted mid-goto (no leak)', async () => {
    state.gotoHang = true;
    const pool = new MultiBrowserPool();
    const ac = new AbortController();

    const p = pool.fetchWithBrowser('https://slow.example', { stealth: true, signal: ac.signal });
    await new Promise<void>((r) => setTimeout(r, 10));
    ac.abort(new DOMException('stage_timeout', 'AbortError'));

    await expect(p).rejects.toBeTruthy();
    // The dedicated context created for this fetch was closed on the abort path.
    expect(state.contextsCreated).toBe(1);
    expect(state.contextsClosed).toBe(1);
    expect(state.liveContexts).toBe(0);

    await pool.shutdown();
  });

  it('bounds concurrent dedicated contexts to the semaphore limit (limit=1 → second waits)', async () => {
    process.env.MAX_BROWSERS = '1';
    resetConfig();
    state.gotoHang = true;

    const pool = new MultiBrowserPool();
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const p1 = pool.fetchWithBrowser('https://a.example', { stealth: true, signal: ac1.signal });
    // Let the first fetch acquire its dedicated slot + create its context.
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(state.contextsCreated).toBe(1);

    const p2 = pool.fetchWithBrowser('https://b.example', { stealth: true, signal: ac2.signal });
    // Give the second fetch a chance to (wrongly) create a context. With the
    // semaphore at limit=1 it must WAIT on the slot — no second context yet.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(state.contextsCreated).toBe(1);
    expect(state.peakLiveContexts).toBe(1);

    // Free the first: its close releases the slot, the second proceeds.
    ac1.abort(new DOMException('stage_timeout', 'AbortError'));
    await expect(p1).rejects.toBeTruthy();
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(state.contextsCreated).toBe(2);

    // Two dedicated contexts NEVER lived at the same time.
    expect(state.peakLiveContexts).toBe(1);

    ac2.abort(new DOMException('stage_timeout', 'AbortError'));
    await expect(p2).rejects.toBeTruthy();

    delete process.env.MAX_BROWSERS;
    await pool.shutdown();
  });

  it('non-stealth fetch still uses the pooled path (release, not close)', async () => {
    const pool = new MultiBrowserPool();
    const proto = Object.getPrototypeOf(pool) as {
      releaseForType: (...args: unknown[]) => void;
    };
    const releaseSpy = vi.spyOn(proto, 'releaseForType');

    const result = await pool.fetchWithBrowser('https://plain.example', {});
    expect(result.method).toBe('browser');

    // Pooled path: the context is RELEASED (kept warm), never init-scripted,
    // and the dedicated close path is not taken.
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(state.addInitScriptCalls).toBe(0);
    expect(state.contextsClosed).toBe(0);
    const stats = pool.getStats();
    expect(stats[0].pooledCount).toBe(1);

    releaseSpy.mockRestore();
    await pool.shutdown();
  });

  it('releases the stealth slot when launch throws during setup (no semaphore leak)', async () => {
    process.env.MAX_BROWSERS = '1';
    resetConfig();
    state.launchThrows = true;

    const pool = new MultiBrowserPool();
    // A launch failure must reject...
    await expect(
      pool.fetchWithBrowser('https://blocked.example', { stealth: true }),
    ).rejects.toThrow(/launch boom/);
    // ...and the throwaway browser was never created (throw was at launch).
    expect(state.browsersLaunched).toBe(0);

    // Regression: with limit=1, a SECOND stealth fetch must NOT be blocked by a
    // leaked slot. Let it succeed this time.
    state.launchThrows = false;
    const result = await pool.fetchWithBrowser('https://ok.example', { stealth: true });
    expect(result.method).toBe('browser');
    expect(state.contextsCreated).toBe(1);

    delete process.env.MAX_BROWSERS;
    await pool.shutdown();
  });

  it('N failed stealth setups do not exhaust the semaphore (slot always freed)', async () => {
    process.env.MAX_BROWSERS = '1';
    resetConfig();
    state.launchThrows = true;

    const pool = new MultiBrowserPool();
    // More failures than the slot count — a leaked slot would make the 2nd hang.
    for (let i = 0; i < 5; i++) {
      await expect(
        pool.fetchWithBrowser('https://blocked.example', { stealth: true }),
      ).rejects.toThrow(/launch boom/);
    }

    // The pool is still usable after N failures.
    state.launchThrows = false;
    const result = await pool.fetchWithBrowser('https://ok.example', { stealth: true });
    expect(result.method).toBe('browser');

    delete process.env.MAX_BROWSERS;
    await pool.shutdown();
  });

  it('closes the throwaway browser when newContext throws after launch', async () => {
    process.env.MAX_BROWSERS = '1';
    resetConfig();
    state.newContextThrows = true;

    const pool = new MultiBrowserPool();
    await expect(
      pool.fetchWithBrowser('https://blocked.example', { stealth: true }),
    ).rejects.toThrow(/newContext boom/);
    // The browser WAS launched, so it must have been closed on the error path.
    expect(state.browsersLaunched).toBe(1);
    expect(state.browsersClosed).toBe(1);

    // Slot is free — a subsequent stealth fetch proceeds.
    state.newContextThrows = false;
    const result = await pool.fetchWithBrowser('https://ok.example', { stealth: true });
    expect(result.method).toBe('browser');

    delete process.env.MAX_BROWSERS;
    await pool.shutdown();
  });
});
