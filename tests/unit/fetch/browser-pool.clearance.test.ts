import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { resolveStealthUA } from '../../../src/fetch/stealth.js';

// --- store mock: capture recordDomainClearance calls without a DB ---
const recordDomainClearance = vi.fn();
const clearDomainClearance = vi.fn();
vi.mock('../../../src/cache/store.js', () => ({
  recordDomainClearance: (...a: unknown[]) => recordDomainClearance(...a),
  clearDomainClearance: (...a: unknown[]) => clearDomainClearance(...a),
}));

// --- programmable page/context behaviour ---
interface State {
  status: number;
  bodies: string[];
  contentCalls: number;
  cookies: Array<{ name: string; value: string; domain: string; expires: number }>;
  addCookiesCalls: Array<Array<{ name: string; value: string; domain: string; path?: string }>>;
}
const state: State = {
  status: 200,
  bodies: ['<html><body>ok</body></html>'],
  contentCalls: 0,
  cookies: [],
  addCookiesCalls: [],
};

function makePage() {
  return {
    goto: vi.fn().mockImplementation(() =>
      Promise.resolve({
        status: () => state.status,
        url: () => 'https://blocked.example/',
        headers: () => ({ 'content-type': 'text/html' }),
      }),
    ),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    // settlePage reads content metrics + the final DOM verdict via evaluate.
    evaluate: vi.fn().mockImplementation((src: string) =>
      typeof src === 'string' && src.includes('hasContent')
        ? Promise.resolve({ hasContent: true, hasSpaRoot: false, nearEmpty: false })
        : Promise.resolve({ textLen: 1000, nodes: 8 })),
    content: vi.fn().mockImplementation(() => {
      const idx = Math.min(state.contentCalls, state.bodies.length - 1);
      state.contentCalls += 1;
      return Promise.resolve(state.bodies[idx]);
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    context: () => ({ cookies: () => Promise.resolve(state.cookies) }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext() {
  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    addCookies: vi.fn().mockImplementation((c: State['addCookiesCalls'][number]) => {
      state.addCookiesCalls.push(c);
      return Promise.resolve(undefined);
    }),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(makePage()),
    cookies: vi.fn().mockImplementation(() => Promise.resolve(state.cookies)),
  };
}

function makeBrowser() {
  return {
    newContext: vi.fn().mockImplementation(() => Promise.resolve(makeContext())),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation(() => Promise.resolve(makeBrowser()));
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

// The browser tier's pre-navigation SSRF re-check (guardResolvedHost) resolves
// the target host via `node:dns`. Mock it to resolve SYNCHRONOUSLY to a benign
// public IP: this file drives `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`
// against a fully-mocked Playwright chain, and a REAL (unmocked) async DNS
// lookup inserts a genuine, non-fake-timer-controlled async gap ahead of the
// challenge-completion poll's setTimeout registration — the poll's timer then
// registers AFTER the test's `advanceTimersByTimeAsync` call has already run,
// so it never fires and the test hangs to the real 20s timeout.
vi.mock('node:dns', () => ({
  lookup: (
    _hostname: string,
    _options: unknown,
    callback: (err: null, addrs: { address: string; family: number }[]) => void,
  ) => callback(null, [{ address: '203.0.113.10', family: 4 }]),
}));

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

const CHALLENGE =
  '<html><head><title>Just a moment...</title></head><body>' +
  '<div class="cf-browser-verification"></div><div class="cf-turnstile"></div></body></html>';
const REAL = '<html><body><article>' + 'Real hydrated content here. '.repeat(50) + '</article></body></html>';

function reset() {
  state.status = 200;
  state.bodies = ['<html><body>ok</body></html>'];
  state.contentCalls = 0;
  state.cookies = [];
  state.addCookiesCalls = [];
  recordDomainClearance.mockClear();
  clearDomainClearance.mockClear();
}

describe('browser-pool clearance persistence (S-A2 mint)', () => {
  beforeEach(() => {
    resetConfig();
    reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetConfig();
  });

  it('persists a minted cf_clearance with the STEALTH UA + tier:browser after a challenge clears', async () => {
    vi.useFakeTimers();
    state.status = 403;
    // First read = challenge; the poll then reads the clearance cookie.
    state.bodies = [CHALLENGE, REAL];
    state.cookies = [{ name: 'cf_clearance', value: 'TOKEN123', domain: 'blocked.example', expires: 1893456000 }];

    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/', { stealth: true });
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    expect(recordDomainClearance).toHaveBeenCalledTimes(1);
    const [host, clearance] = recordDomainClearance.mock.calls[0];
    expect(host).toBe('blocked.example');
    expect(clearance.cookie).toBe('cf_clearance=TOKEN123');
    expect(clearance.tier).toBe('browser');
    expect(clearance.ua).toBe(resolveStealthUA());
    expect(Date.parse(clearance.expiresAt)).toBe(1893456000 * 1000);

    await pool.shutdown();
  });

  it('does NOT persist when the challenge clears WITHOUT a clearance cookie', async () => {
    vi.useFakeTimers();
    state.status = 403;
    state.bodies = [CHALLENGE, REAL];
    state.cookies = []; // cleared by DOM, no cf_clearance minted

    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/', { stealth: true });
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    expect(recordDomainClearance).not.toHaveBeenCalled();
    await pool.shutdown();
  });
});

describe('browser-pool injected clearance reuse (S-A2 inject + re-validate)', () => {
  beforeEach(() => {
    resetConfig();
    reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetConfig();
  });

  it('applies injectedCookies via context.addCookies before navigation', async () => {
    state.status = 200;
    state.bodies = [REAL];

    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://blocked.example/', {
      injectedCookies: [{ name: 'cf_clearance', value: 'REUSED', domain: 'blocked.example', path: '/' }],
    });

    expect(state.addCookiesCalls.length).toBe(1);
    expect(state.addCookiesCalls[0]).toEqual([
      { name: 'cf_clearance', value: 'REUSED', domain: 'blocked.example', path: '/' },
    ]);
    await pool.shutdown();
  });

  it('re-validation: an injected clearance that STILL yields a challenge purges the stored clearance (clearDomainClearance)', async () => {
    vi.useFakeTimers();
    state.status = 403;
    // Injected cookie did not help — stays a challenge across the whole poll.
    state.bodies = [CHALLENGE, CHALLENGE, CHALLENGE];
    state.cookies = [];
    process.env.WIGOLO_CHALLENGE_COMPLETION_MS = '2000';
    resetConfig();

    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/', {
      stealth: true,
      injectedCookies: [{ name: 'cf_clearance', value: 'STALE', domain: 'blocked.example', path: '/' }],
    });
    const captured = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(3000);
    const err = await captured;
    // Escalation proceeds via the challenge error — the shell is NOT returned as content.
    expect((err as Error).name).toBe('ChallengeBlockedError');
    expect(clearDomainClearance).toHaveBeenCalledWith('blocked.example');

    delete process.env.WIGOLO_CHALLENGE_COMPLETION_MS;
    await pool.shutdown();
  });
});
