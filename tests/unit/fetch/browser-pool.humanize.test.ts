import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// Tracks whether the human-like interaction pass touched the page: mouse moves
// + a scroll evaluate. A benign (non-stealth) fetch under default `auto` MUST
// leave these at zero (the must-not-over-fire guard).
interface HumanizeState {
  mouseMoves: number;
  scrollEvals: number;
}

const state: HumanizeState = { mouseMoves: 0, scrollEvals: 0 };

function makePage() {
  return {
    goto: vi.fn().mockResolvedValue({
      status: () => 200,
      url: () => 'https://example.com',
      headers: () => ({ 'content-type': 'text/html' }),
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    // The settle probe + the humanize scroll both go through evaluate. Only the
    // scroll (a function argument, not the settle DOM-verdict source string)
    // counts as a humanize scroll.
    evaluate: vi.fn().mockImplementation((src: unknown) => {
      if (typeof src === 'function') {
        state.scrollEvals++;
        return Promise.resolve(undefined);
      }
      return typeof src === 'string' && src.includes('hasContent')
        ? Promise.resolve({ hasContent: true, hasSpaRoot: false, nearEmpty: false })
        : Promise.resolve({ textLen: 1000, nodes: 8 });
    }),
    content: vi.fn().mockResolvedValue('<html><body>ok</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    viewportSize: vi.fn(() => ({ width: 1280, height: 800 })),
    mouse: {
      move: vi.fn(() => {
        state.mouseMoves++;
        return Promise.resolve(undefined);
      }),
    },
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

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
    newContext: vi.fn().mockResolvedValue(makeContext()),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation(() => Promise.resolve(makeBrowser()));
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

function resetState() {
  state.mouseMoves = 0;
  state.scrollEvals = 0;
}

describe('browser-pool human-like interaction gating', () => {
  beforeEach(() => {
    resetConfig();
    resetState();
  });
  afterEach(() => {
    delete process.env.WIGOLO_HUMANIZE;
    resetConfig();
  });

  it('humanize=off: NEVER engages, even on a stealth fetch', async () => {
    process.env.WIGOLO_HUMANIZE = 'off';
    resetConfig();
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://blocked.example', { stealth: true });
    expect(result.method).toBe('browser');
    expect(state.mouseMoves).toBe(0);
    expect(state.scrollEvals).toBe(0);
    await pool.shutdown();
  });

  it('humanize=on: engages on a plain browser fetch (no stealth)', async () => {
    process.env.WIGOLO_HUMANIZE = 'on';
    resetConfig();
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://plain.example', {});
    expect(result.method).toBe('browser');
    expect(state.mouseMoves).toBeGreaterThan(0);
    expect(state.scrollEvals).toBeGreaterThan(0);
    await pool.shutdown();
  });

  it('humanize=auto: engages on the stealth/escalation path', async () => {
    process.env.WIGOLO_HUMANIZE = 'auto';
    resetConfig();
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://blocked.example', { stealth: true });
    expect(result.method).toBe('browser');
    expect(state.mouseMoves).toBeGreaterThan(0);
    expect(state.scrollEvals).toBeGreaterThan(0);
    await pool.shutdown();
  });

  it('MUST-NOT-OVER-FIRE — humanize=auto: a benign non-stealth fetch does NO interaction', async () => {
    process.env.WIGOLO_HUMANIZE = 'auto';
    resetConfig();
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://plain.example', {});
    expect(result.method).toBe('browser');
    // The escalation gate did not fire → zero behavioral cost on the benign path.
    expect(state.mouseMoves).toBe(0);
    expect(state.scrollEvals).toBe(0);
    await pool.shutdown();
  });

  it('MUST-NOT-REGRESS — default (no env) auto: benign browser fetch stays interaction-free', async () => {
    delete process.env.WIGOLO_HUMANIZE;
    resetConfig();
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://plain.example', {});
    expect(result.method).toBe('browser');
    expect(state.mouseMoves).toBe(0);
    expect(state.scrollEvals).toBe(0);
    await pool.shutdown();
  });

  it('explicit options.humanize=true overrides config off', async () => {
    process.env.WIGOLO_HUMANIZE = 'off';
    resetConfig();
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://plain.example', { humanize: true });
    expect(result.method).toBe('browser');
    expect(state.mouseMoves).toBeGreaterThan(0);
    await pool.shutdown();
  });

  it('explicit options.humanize=false overrides config on', async () => {
    process.env.WIGOLO_HUMANIZE = 'on';
    resetConfig();
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://plain.example', { humanize: false });
    expect(result.method).toBe('browser');
    expect(state.mouseMoves).toBe(0);
    expect(state.scrollEvals).toBe(0);
    await pool.shutdown();
  });
});
