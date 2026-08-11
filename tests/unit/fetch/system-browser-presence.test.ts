import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { systemBrowserPresent, resolveAuthenticChrome } from '../../../src/fetch/cdp-direct.js';

/**
 * D-S10-5 makes the no-display rung "system browser detection, else the lazy engine
 * acquisition", so `warmup` needs a PRESENCE answer on a default install.
 */

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

beforeEach(() => {
  delete process.env.WIGOLO_CHROME_PATH;
  delete process.env.CHROME_PATH;
  delete process.env.WIGOLO_CDP_DIRECT;
  resetConfig();
});

afterEach(() => {
  delete process.env.WIGOLO_CHROME_PATH;
  delete process.env.CHROME_PATH;
  delete process.env.WIGOLO_CDP_DIRECT;
  resetConfig();
});

describe('systemBrowserPresent', () => {
  it('finds an authentic browser at a well-known location', () => {
    const present = systemBrowserPresent({
      platform: 'darwin',
      env: {},
      exists: (p) => p === MAC_CHROME,
    });
    expect(present).toBe(true);
  });

  it('reports absent when no candidate is on disk', () => {
    expect(systemBrowserPresent({ platform: 'linux', env: {}, exists: () => false })).toBe(false);
  });

  it('honours an explicit path override', () => {
    const present = systemBrowserPresent({
      platform: 'linux',
      env: { WIGOLO_CHROME_PATH: '/opt/mine/chrome' },
      exists: (p) => p === '/opt/mine/chrome',
    });
    expect(present).toBe(true);
  });

  it('probes even on a DEFAULT install, where the rung resolver refuses to', () => {
    // WHY THIS FUNCTION EXISTS AT ALL, and the reason it is not a duplicate of
    // `resolveAuthenticChrome`. That resolver short-circuits to `chromium-pinned` and probes
    // NOTHING unless `cdpDirect` is opted in — correct for choosing a rung, useless for reporting
    // what is on the box. Asserted as a differential: same machine, same paths, one answers and
    // the other declines. Without this, `warmup` on a default install would report "no system
    // browser" on a machine that has one.
    const deps = { platform: 'darwin' as const, env: {}, exists: (p: string) => p === MAC_CHROME };
    expect(systemBrowserPresent(deps)).toBe(true);
    const rung = resolveAuthenticChrome(deps);
    expect(rung.path).toBeNull();
    expect(rung.reason).toBe('chromium-pinned');
    expect(rung.probed).toEqual([]);
  });

  it('shares the candidate list with the rung resolver, so a new install path reaches both', () => {
    // WHY: the paths are the part that rots — a renamed package, a new install location. Two
    // copies of the list would drift and the drift would be silent. Observed by opting the rung
    // resolver in and checking it probes a path this function also accepts.
    process.env.WIGOLO_CDP_DIRECT = 'on';
    resetConfig();
    const deps = { platform: 'darwin' as const, env: {}, exists: (p: string) => p === MAC_CHROME };
    expect(resolveAuthenticChrome(deps).path).toBe(MAC_CHROME);
    expect(systemBrowserPresent(deps)).toBe(true);
  });
});
