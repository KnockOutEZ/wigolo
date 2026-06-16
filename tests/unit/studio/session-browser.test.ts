import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';
import { resetPersistedConfig } from '../../../src/persisted-config.js';
import { SessionBrowser, type LaunchOptions, type LaunchedSessionBrowser } from '../../../src/studio/session-browser.js';

/**
 * A fake launcher: records launch options + close calls so SessionBrowser's
 * lifecycle is testable without a real browser (the real Playwright launcher is
 * exercised by the RUN_STUDIO_HEADED integration test).
 */
function makeFake() {
  const calls = { browserClose: 0, contextClose: 0, pageClose: 0, gotos: [] as string[] };
  let launchOpts: LaunchOptions | null = null;
  let launchCount = 0;
  const page = {
    close: async () => { calls.pageClose++; },
    goto: async (url: string) => { calls.gotos.push(url); return null; },
    on: (_e: string, _cb: () => void) => {},
  };
  const cdp = { send: async () => ({}), on: (_e: string, _cb: (p: unknown) => void) => {} };
  const browser = { close: async () => { calls.browserClose++; }, on: (_e: string, _cb: () => void) => {} };
  const context = { close: async () => { calls.contextClose++; } };
  const launch = async (opts: LaunchOptions): Promise<LaunchedSessionBrowser> => {
    launchOpts = opts;
    launchCount++;
    return { browser, context, page, cdp } as unknown as LaunchedSessionBrowser;
  };
  return { calls, launch, page, cdp, getLaunchOpts: () => launchOpts, getLaunchCount: () => launchCount };
}

describe('SessionBrowser', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wigolo-sb-'));
    process.env.WIGOLO_CONFIG_PATH = join(tmp, 'config.json');
    resetPersistedConfig();
    resetConfig();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    resetPersistedConfig();
    resetConfig();
  });

  it('start() launches headed with the configured screencast viewport and exposes page + cdp', async () => {
    const fake = makeFake();
    const sb = new SessionBrowser({ sessionId: 's1', launch: fake.launch });
    await sb.start();
    expect(fake.getLaunchOpts()).toEqual({ headless: false, viewport: { width: 1280, height: 720 } });
    expect(sb.page).toBe(fake.page);
    expect(sb.cdp).toBe(fake.cdp);
  });

  it('start() is idempotent — a second call does not relaunch', async () => {
    const fake = makeFake();
    const sb = new SessionBrowser({ sessionId: 's1', launch: fake.launch });
    await sb.start();
    await sb.start();
    expect(fake.getLaunchCount()).toBe(1);
  });

  it('navigate() navigates to the url and records it as currentUrl', async () => {
    const fake = makeFake();
    const sb = new SessionBrowser({ sessionId: 's1', launch: fake.launch });
    await sb.start();
    expect(sb.currentUrl).toBe('');
    await sb.navigate('https://example.com/');
    expect(fake.calls.gotos).toEqual(['https://example.com/']);
    expect(sb.currentUrl).toBe('https://example.com/');
  });

  it('close() closes page, context, and browser exactly once and is idempotent', async () => {
    const fake = makeFake();
    const sb = new SessionBrowser({ sessionId: 's1', launch: fake.launch });
    await sb.start();
    await sb.close();
    await sb.close();
    expect(fake.calls.pageClose).toBe(1);
    expect(fake.calls.contextClose).toBe(1);
    expect(fake.calls.browserClose).toBe(1);
  });

  it('accessing page before start() throws (not a silent null)', () => {
    const sb = new SessionBrowser({ sessionId: 's1', launch: makeFake().launch });
    expect(() => sb.page).toThrow(/not_started/);
  });
});

/**
 * A fake whose browser/page expose triggerable `disconnected`/`crash` events
 * and re-register handlers on each (re)launch — so crash recovery is testable
 * without killing a real browser. `browser.close()` fires `disconnected` to
 * mirror Playwright, proving an intentional close must NOT trigger recovery.
 */
function makeCrashableFake() {
  const calls = { gotos: [] as string[], launchCount: 0 };
  let crashCb: (() => void | Promise<void>) | null = null;
  let disconnectCb: (() => void | Promise<void>) | null = null;
  const makeHandles = (): LaunchedSessionBrowser => {
    const page = {
      close: async () => {},
      goto: async (url: string) => { calls.gotos.push(url); return null; },
      on: (e: string, cb: () => void) => { if (e === 'crash') crashCb = cb; },
    };
    const cdp = { send: async () => ({}), on: () => {} };
    const browser = {
      close: async () => { if (disconnectCb) await disconnectCb(); },
      on: (e: string, cb: () => void) => { if (e === 'disconnected') disconnectCb = cb; },
    };
    const context = { close: async () => {} };
    return { browser, context, page, cdp } as unknown as LaunchedSessionBrowser;
  };
  const launch = async (): Promise<LaunchedSessionBrowser> => { calls.launchCount++; return makeHandles(); };
  return {
    calls,
    launch,
    fireCrash: async () => { if (crashCb) await crashCb(); },
  };
}

describe('SessionBrowser — crash recovery', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wigolo-sbc-'));
    process.env.WIGOLO_CONFIG_PATH = join(tmp, 'config.json');
    resetPersistedConfig();
    resetConfig();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    resetPersistedConfig();
    resetConfig();
  });

  it('recovers from a page crash: relaunches, re-navigates currentUrl, emits recovered', async () => {
    const fake = makeCrashableFake();
    const sb = new SessionBrowser({ sessionId: 's1', launch: fake.launch, maxRestarts: 2 });
    await sb.start();
    await sb.navigate('https://ex.com/');
    let recovered = 0;
    sb.onRecovered(() => { recovered++; });

    await fake.fireCrash();

    expect(fake.calls.launchCount).toBe(2); // relaunched once
    expect(fake.calls.gotos).toEqual(['https://ex.com/', 'https://ex.com/']); // re-navigated
    expect(recovered).toBe(1);
    expect(sb.running).toBe(true);
  });

  it('gives up after maxRestarts crashes: emits failed and goes terminal (no hang, no infinite relaunch)', async () => {
    const fake = makeCrashableFake();
    const sb = new SessionBrowser({ sessionId: 's1', launch: fake.launch, maxRestarts: 1 });
    await sb.start();
    let failed = 0;
    sb.onFailed(() => { failed++; });

    await fake.fireCrash(); // restart 1 — recovers
    await fake.fireCrash(); // exceeds maxRestarts — fail

    expect(failed).toBe(1);
    expect(sb.running).toBe(false);
  });

  it('does NOT trigger recovery on an intentional close()', async () => {
    const fake = makeCrashableFake();
    const sb = new SessionBrowser({ sessionId: 's1', launch: fake.launch });
    await sb.start();
    let recovered = 0;
    sb.onRecovered(() => { recovered++; });

    await sb.close(); // browser.close() fires 'disconnected'

    expect(recovered).toBe(0);
    expect(fake.calls.launchCount).toBe(1); // never relaunched
  });
});
