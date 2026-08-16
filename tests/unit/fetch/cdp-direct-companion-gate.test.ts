import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { resolveAuthenticChrome } from '../../../src/fetch/cdp-direct.js';

/**
 * The second half of the D-S10-5 reachability defect.
 *
 * Wiring the companion rung into the router is not enough on its own: `resolveAuthenticChrome`
 * declines with `chromium-pinned` whenever the browser channel is pinned to the bundled engine
 * and `cdpDirect` is not opted into — and BOTH are the shipped defaults (`config.ts`). So on a
 * default install the rung probed nothing and returned null, which is indistinguishable from
 * "this host has no browser". These cases pin the exemption, and pin that it is an exemption
 * rather than a widening of the opt-in.
 */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const originalEnv = process.env;

describe('resolveAuthenticChrome — the companion-rung exemption', () => {
  beforeEach(() => {
    // The shipped defaults, stated explicitly rather than inherited from the runner: no
    // cdpDirect opt-in, channel pinned to the bundled engine.
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_CDP_DIRECT;
    delete process.env.WIGOLO_BROWSER_CHANNEL;
    delete process.env.WIGOLO_CHROME_PATH;
    delete process.env.CHROME_PATH;
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  const deps = (companionRung?: boolean) => ({
    exists: (p: string) => p === CHROME,
    platform: 'darwin' as NodeJS.Platform,
    env: {} as NodeJS.ProcessEnv,
    ...(companionRung === undefined ? {} : { companionRung }),
  });

  it('declines on a default install when it is NOT the companion rung', async () => {
    // The control. Without this case the exemption below could pass because the resolver always
    // resolves, and would say nothing about the gate it is supposed to be bypassing.
    const r = resolveAuthenticChrome(deps());

    expect(r.path).toBeNull();
    expect(r.reason).toBe('chromium-pinned');
    expect(r.probed).toHaveLength(0);
  });

  it('resolves the installed browser on that SAME default install for the companion rung', async () => {
    // Same config, same host, same probe — only the caller's identity differs. That is the whole
    // claim: the companion rung is a different rung, not a louder opt-in.
    const r = resolveAuthenticChrome(deps(true));

    expect(r.path).toBe(CHROME);
    expect(r.reason).toBeUndefined();
  });

  it('still finds nothing for the companion rung when the host genuinely has no browser', async () => {
    // The exemption changes whether the probe RUNS, never what it is allowed to conclude. A
    // chromium build is never dressed up as Chrome and an absent browser is never invented.
    const r = resolveAuthenticChrome({
      exists: () => false,
      platform: 'darwin',
      env: {} as NodeJS.ProcessEnv,
      companionRung: true,
    });

    expect(r.path).toBeNull();
    expect(r.reason).toBe('no-authentic-browser');
    expect(r.probed.length).toBeGreaterThan(0);
  });

  it('does not disturb an operator who HAS opted in', async () => {
    // Regression fence: the opt-in path resolved before this change and must still resolve,
    // with the companion flag absent entirely.
    process.env.WIGOLO_CDP_DIRECT = 'on';
    resetConfig();

    const r = resolveAuthenticChrome(deps());

    expect(r.path).toBe(CHROME);
  });
});
