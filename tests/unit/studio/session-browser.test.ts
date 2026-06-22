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

  it('fires onBeforeReNav on the FRESH cdp BEFORE the recovery goto (Finding A)', async () => {
    // Finding A: the nav interceptor rebinds via onBeforeReNav so it is live on the
    // fresh CDP BEFORE the recovery re-navigation — otherwise a redirect hop during
    // recovery is unguarded on the agent path.
    const fake = makeCrashableFake();
    const sb = new SessionBrowser({ sessionId: 's1', launch: fake.launch, maxRestarts: 2 });
    let hookCalls = 0;
    let hookCdp: unknown = null;
    let gotosWhenHookRan = -1;
    sb.onBeforeReNav(async (cdp) => {
      hookCalls++;
      hookCdp = cdp;
      gotosWhenHookRan = fake.calls.gotos.length; // the recovery goto must NOT have run yet
    });
    await sb.start();
    await sb.navigate('https://ex.com/');
    const firstCdp = sb.cdp;
    expect(hookCalls).toBe(0); // not fired on initial start/navigate — only on recovery re-nav

    await fake.fireCrash();

    expect(hookCalls).toBe(1);
    expect(gotosWhenHookRan).toBe(1); // only the original navigate; recovery goto comes AFTER the hook
    expect(fake.calls.gotos).toEqual(['https://ex.com/', 'https://ex.com/']); // recovery goto did run
    expect(hookCdp).toBe(sb.cdp); // hook received the fresh post-relaunch cdp
    expect(hookCdp).not.toBe(firstCdp); // not the dead one
  });

  it('fails recovery CLOSED when an onBeforeReNav hook throws (no unguarded re-nav)', async () => {
    // A pre-nav guard that cannot arm (e.g. the nav interceptor's Fetch.enable
    // rejects on the fresh cdp) must NOT let recovery proceed into an unguarded
    // re-navigation — the session goes terminal instead (fail-closed).
    const fake = makeCrashableFake();
    const sb = new SessionBrowser({ sessionId: 's1', launch: fake.launch, maxRestarts: 3 });
    sb.onBeforeReNav(async () => { throw new Error('rebind failed'); });
    let failed = 0;
    sb.onFailed(() => { failed++; });
    await sb.start();
    await sb.navigate('https://ex.com/');

    await fake.fireCrash();

    expect(fake.calls.gotos).toEqual(['https://ex.com/']); // recovery goto did NOT run
    expect(failed).toBe(1); // session went terminal
    expect(sb.running).toBe(false);
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

/**
 * Slice 5d — named-profile attach. A stored profile's storageState is resolved FRESH per launch via
 * the injected `loadProfile` and loaded into the context at BOTH launch sites (start + crash
 * recovery), so a crash never loses the login. `storageState()` is the HOST-ONLY read-back accessor
 * for 5e (never agent-reachable, never logged). A crashable fake that records LaunchOptions per
 * launch proves the crash-recovery site (:191) carries the profile, not just start (:130).
 */
const STORED_STATE = {
  cookies: [{ name: 'sid', value: 's3cr3t-token', domain: 'acme.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }],
  origins: [],
};

function makeProfileFake() {
  const launches: LaunchOptions[] = [];
  let crashCb: (() => void | Promise<void>) | null = null;
  let disconnectCb: (() => void | Promise<void>) | null = null;
  const makeHandles = (opts: LaunchOptions): LaunchedSessionBrowser => {
    const page = {
      close: async () => {},
      goto: async () => null,
      on: (e: string, cb: () => void) => { if (e === 'crash') crashCb = cb; },
      url: () => 'about:blank',
    };
    const cdp = { send: async () => ({}), on: () => {}, off: () => {} };
    const browser = {
      close: async () => { if (disconnectCb) await disconnectCb(); },
      on: (e: string, cb: () => void) => { if (e === 'disconnected') disconnectCb = cb; },
    };
    // The context reflects the storageState the launcher was given — proving the profile attached.
    const context = { close: async () => {}, storageState: async () => opts.storageState ?? { cookies: [], origins: [] } };
    return { browser, context, page, cdp } as unknown as LaunchedSessionBrowser;
  };
  const launch = async (opts: LaunchOptions): Promise<LaunchedSessionBrowser> => { launches.push(opts); return makeHandles(opts); };
  return { launches, launch, fireCrash: async () => { if (crashCb) await crashCb(); } };
}

describe('SessionBrowser — 5d named-profile attach', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wigolo-sbp-'));
    process.env.WIGOLO_CONFIG_PATH = join(tmp, 'config.json');
    resetPersistedConfig();
    resetConfig();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    resetPersistedConfig();
    resetConfig();
  });

  it('PRIMARY: a stored named profile attaches on start AND survives a crash relaunch (BOTH launch sites)', async () => {
    const fake = makeProfileFake();
    const sb = new SessionBrowser({ sessionId: 's1', launch: fake.launch, maxRestarts: 2, loadProfile: async () => STORED_STATE });
    await sb.start();
    expect(fake.launches[0].storageState, 'start() loads the profile').toEqual(STORED_STATE);

    await sb.navigate('https://acme.example/');
    await fake.fireCrash(); // → handleCrash (:191) relaunches

    expect(fake.launches.length, 'handleCrash actually relaunched (the :191 path ran, not vacuous)').toBe(2);
    // MUTATION (drop the profile at the crash-recovery launch site :191) → launches[1].storageState undefined → THIS REDs.
    expect(fake.launches[1].storageState, 'crash relaunch keeps the login').toEqual(STORED_STATE);
    expect(await sb.storageState(), 'the relaunched context still carries the cookies').toEqual(STORED_STATE);
  });

  it('profile_absent (opted-in, not-yet-stored): session starts CLEAN — no profile loaded, no crash', async () => {
    const fake = makeProfileFake();
    const sb = new SessionBrowser({ sessionId: 's1', launch: fake.launch, loadProfile: async () => undefined });
    await sb.start();
    expect(fake.launches[0].storageState, 'profile_absent → no storageState loaded (clean)').toBeUndefined();
    expect(sb.running).toBe(true); // no crash, no block
  });

  it('default session (no opt-in): clean — no profile resolver, no storageState', async () => {
    const fake = makeProfileFake();
    const sb = new SessionBrowser({ sessionId: 's1', launch: fake.launch }); // no loadProfile
    await sb.start();
    expect(fake.launches[0].storageState).toBeUndefined();
  });

  it('the host-only storageState() accessor throws before start (not a silent null)', async () => {
    const sb = new SessionBrowser({ sessionId: 's1', launch: makeProfileFake().launch });
    await expect(sb.storageState()).rejects.toThrow(/not_started/);
  });
});
