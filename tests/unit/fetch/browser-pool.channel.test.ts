import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// Shared mock state. Captures EVERY launch option object so the tests can
// assert the exact channel + headless flags the dedicated stealth path passes,
// and can simulate a machine with no installed authentic browser (the
// channel:'chrome' launch throws, the bundled launch succeeds).
interface ChannelState {
  launchCalls: Array<Record<string, unknown>>;
  // When true, a launch whose options carry `channel:'chrome'` rejects
  // (simulates no installed Chrome); a launch WITHOUT channel succeeds.
  chromeChannelUnavailable: boolean;
  // Version string the launched browser reports (drives the coherence contract).
  browserVersion: string;
}

const state: ChannelState = {
  launchCalls: [],
  chromeChannelUnavailable: false,
  browserVersion: '142.0.7444.0',
};

function makePage() {
  return {
    goto: vi.fn().mockResolvedValue({
      status: () => 200,
      url: () => 'https://example.com',
      headers: () => ({ 'content-type': 'text/html' }),
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation((src: string) =>
      typeof src === 'string' && src.includes('hasContent')
        ? Promise.resolve({ hasContent: true, hasSpaRoot: false, nearEmpty: false })
        : Promise.resolve({ textLen: 1000, nodes: 8 })),
    content: vi.fn().mockResolvedValue('<html><body>ok</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

let lastContextOptions: Record<string, unknown> | undefined;

function makeContext() {
  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(makePage()),
    cookies: vi.fn().mockResolvedValue([]),
  };
}

function makeBrowser() {
  return {
    version: vi.fn().mockImplementation(() => state.browserVersion),
    newContext: vi.fn().mockImplementation((opts?: Record<string, unknown>) => {
      lastContextOptions = opts;
      return Promise.resolve(makeContext());
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    state.launchCalls.push(opts);
    if (state.chromeChannelUnavailable && opts.channel === 'chrome') {
      return Promise.reject(new Error('Chromium distribution "chrome" is not found'));
    }
    return Promise.resolve(makeBrowser());
  });
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

function channelLaunches(): Array<Record<string, unknown>> {
  return state.launchCalls.filter((o) => o.channel === 'chrome');
}

function resetState() {
  state.launchCalls = [];
  state.chromeChannelUnavailable = false;
  state.browserVersion = '142.0.7444.0';
  lastContextOptions = undefined;
}

describe('dedicated stealth launch: authentic-browser channel (T1-A)', () => {
  beforeEach(() => {
    resetState();
    // Probing for an installed browser is OPT-IN — the default is the pinned
    // bundled engine so behaviour does not vary per host. This describe covers
    // the opted-in path; the chromium-pin test below overrides it back.
    process.env.WIGOLO_BROWSER_CHANNEL = 'auto';
    resetConfig();
  });
  afterEach(() => {
    delete process.env.WIGOLO_BROWSER_CHANNEL;
    delete process.env.WIGOLO_BROWSER_HEADFUL;
    resetConfig();
  });

  it('prefers channel:chrome, then falls back to bundled when Chrome is not installed', async () => {
    state.chromeChannelUnavailable = true;
    const pool = new MultiBrowserPool();

    const result = await pool.fetchWithBrowser('https://blocked.example', { stealth: true });
    expect(result.method).toBe('browser');

    // It attempted the authentic browser first...
    expect(channelLaunches().length).toBe(1);
    // ...then relaunched WITHOUT a channel (bundled engine) after the failure.
    const bundled = state.launchCalls.filter((o) => o.channel === undefined);
    expect(bundled.length).toBe(1);

    await pool.shutdown();
  });

  it('caches the failed probe: channel:chrome is attempted ONCE across two fetches', async () => {
    state.chromeChannelUnavailable = true;
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });
    await pool.fetchWithBrowser('https://b.example', { stealth: true });

    // The failed channel:'chrome' attempt is not repaid on the second fetch.
    expect(channelLaunches().length).toBe(1);
    // Both fetches still launched (each via the cached bundled decision).
    expect(state.launchCalls.length).toBe(3); // 1 chrome-attempt + 2 bundled

    await pool.shutdown();
  });

  it('caches the successful probe: still uses channel:chrome on the second fetch (no bundled relaunch)', async () => {
    state.chromeChannelUnavailable = false; // Chrome IS installed
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });
    await pool.fetchWithBrowser('https://b.example', { stealth: true });

    // Both fetches used the authentic channel; no bundled launch ever happened.
    expect(channelLaunches().length).toBe(2);
    expect(state.launchCalls.every((o) => o.channel === 'chrome')).toBe(true);

    await pool.shutdown();
  });

  it('WIGOLO_BROWSER_CHANNEL=chromium NEVER attempts channel:chrome', async () => {
    process.env.WIGOLO_BROWSER_CHANNEL = 'chromium';
    resetConfig();
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });

    expect(channelLaunches().length).toBe(0);
    expect(state.launchCalls.length).toBe(1);
    expect(state.launchCalls[0].channel).toBeUndefined();

    await pool.shutdown();
  });
});

describe('dedicated stealth launch: headful escape (T1-B)', () => {
  beforeEach(() => {
    resetState();
    resetConfig();
  });
  afterEach(() => {
    delete process.env.WIGOLO_BROWSER_HEADFUL;
    resetConfig();
  });

  it('default (browserHeadful=false) launches WITHOUT a visible window (headless:true)', async () => {
    delete process.env.WIGOLO_BROWSER_HEADFUL;
    resetConfig();
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });

    // Every stealth launch must be headless — a background server never pops a
    // window by default.
    expect(state.launchCalls.length).toBeGreaterThan(0);
    for (const opts of state.launchCalls) {
      expect(opts.headless).toBe(true);
    }

    await pool.shutdown();
  });

  it('WIGOLO_BROWSER_HEADFUL=1 launches with headless:false (visible window)', async () => {
    process.env.WIGOLO_BROWSER_HEADFUL = '1';
    resetConfig();
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });

    expect(state.launchCalls.length).toBeGreaterThan(0);
    for (const opts of state.launchCalls) {
      expect(opts.headless).toBe(false);
    }

    await pool.shutdown();
  });
});

describe('pooled (non-stealth) path is byte-unchanged (MUST-NOT-REGRESS)', () => {
  beforeEach(() => {
    resetState();
    resetConfig();
  });
  afterEach(() => {
    delete process.env.WIGOLO_BROWSER_CHANNEL;
    delete process.env.WIGOLO_BROWSER_HEADFUL;
    resetConfig();
  });

  it('the pooled launch still passes headless:true and NEVER a channel', async () => {
    // Even with knobs that would change the stealth path, the pooled fast path
    // must be unaffected: it launches headless, bundled, no channel.
    process.env.WIGOLO_BROWSER_CHANNEL = 'chrome';
    process.env.WIGOLO_BROWSER_HEADFUL = '1';
    resetConfig();
    const pool = new MultiBrowserPool();

    const result = await pool.fetchWithBrowser('https://plain.example', {}); // no stealth
    expect(result.method).toBe('browser');

    expect(state.launchCalls.length).toBe(1);
    const opts = state.launchCalls[0];
    expect(opts.headless).toBe(true);
    expect(opts.channel).toBeUndefined();
    // The pooled launch does not carry the stealth hardening args either.
    expect(opts.args).toBeUndefined();

    await pool.shutdown();
  });
});

describe('dedicated stealth launch: UA/platform coherence (T1-C)', () => {
  beforeEach(() => {
    resetState();
    resetConfig();
  });
  afterEach(() => {
    resetConfig();
  });

  it('advertises a UA whose platform token matches the runtime OS and whose major equals browser.version()', async () => {
    state.browserVersion = '137.0.1234.5';
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });

    expect(lastContextOptions).toBeDefined();
    const ua = String((lastContextOptions as Record<string, unknown>).userAgent);
    // Major MUST reflect the ACTUALLY launched browser, not a hardcoded pin.
    expect(ua).toContain('Chrome/137.');
    // Platform token MUST reflect the real runtime OS (the top cross-layer tell).
    const expectedToken =
      process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X'
        : process.platform === 'win32'
          ? 'Windows NT 10.0; Win64; x64'
          : 'X11; Linux x86_64';
    expect(ua).toContain(expectedToken);
    // Never a headless tell.
    expect(ua).not.toContain('HeadlessChrome');

    await pool.shutdown();
  });

  it('falls back to the pinned major when browser.version() is unparseable', async () => {
    state.browserVersion = 'unknown';
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });

    const ua = String((lastContextOptions as Record<string, unknown>).userAgent);
    expect(ua).toContain('Chrome/142.');

    await pool.shutdown();
  });
});
