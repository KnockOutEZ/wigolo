import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveBrowserTier,
  resetBrowserTierAnnouncements,
  BROWSER_TIER_ENV,
  TIER_USER_STRINGS,
  NO_DISPLAY_CEILING,
  type BrowserTierInputs,
  type BrowserTierResolution,
} from '../../../src/fetch/browser-tier.js';

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ warn: warnMock, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

/**
 * Every case injects platform + env rather than mutating `process.env`. The resolver's whole
 * point is that ONE function decides from an environment; a test that has to mutate the real
 * process to reach a branch is testing the ambient environment as much as the resolver.
 */
function resolve(inputs: BrowserTierInputs): BrowserTierResolution {
  return resolveBrowserTier({ env: {}, substrateInstalled: () => false, ...inputs });
}

beforeEach(() => {
  resetBrowserTierAnnouncements();
  warnMock.mockReset();
});

describe('resolveBrowserTier — display detection', () => {
  it('resolves darwin with no DISPLAY to the desktop tier', () => {
    // WHY: macOS never sets DISPLAY. Reading its absence as "no display server" is the exact
    // bug that would classify every Mac as a headless server and stop it acquiring a desktop
    // rung — so the platform must answer before either variable is consulted.
    const r = resolve({ platform: 'darwin' });
    expect(r.tier).toBe('desktop');
    expect(r.reason).toBe('platform_display_always');
  });

  it('resolves win32 with no DISPLAY to the desktop tier', () => {
    const r = resolve({ platform: 'win32' });
    expect(r.tier).toBe('desktop');
    expect(r.reason).toBe('platform_display_always');
  });

  it('resolves linux with DISPLAY to the desktop tier', () => {
    const r = resolve({ platform: 'linux', env: { DISPLAY: ':0' } });
    expect(r.tier).toBe('desktop');
    expect(r.reason).toBe('x11_display');
  });

  it('resolves linux with only WAYLAND_DISPLAY to the desktop tier', () => {
    // WHY: a resolver that checks only DISPLAY calls a Wayland desktop headless. Wayland
    // sessions routinely run with no DISPLAY at all.
    const r = resolve({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } });
    expect(r.tier).toBe('desktop');
    expect(r.reason).toBe('wayland_display');
  });

  it('resolves linux with neither variable to the no-display tier', () => {
    const r = resolve({ platform: 'linux' });
    expect(r.tier).toBe('no-display');
    expect(r.reason).toBe('no_display_server');
  });

  it('resolves a CI runner with a virtual display per the display, and says so', () => {
    // WHY: this repo's own Studio jobs run under a virtual display. Special-casing CI into
    // no-display would make them unroutable while CI is exactly where they run.
    const r = resolve({ platform: 'linux', env: { DISPLAY: ':99', CI: 'true' } });
    expect(r.tier).toBe('desktop');
    expect(r.reason).toBe('virtual_display_ci');
    expect(r.detail).toMatch(/xvfb/i);
  });
});

describe('resolveBrowserTier — overrides', () => {
  it('lets the environment override win in both directions', () => {
    // WHY: a one-way override is a half-measure. An operator on a headless box that DOES have
    // a usable display needs to force desktop, and an operator on a desktop who wants the
    // lighter rung needs to force the other way.
    const forcedDown = resolve({ platform: 'darwin', env: { [BROWSER_TIER_ENV]: 'no-display' } });
    expect(forcedDown.tier).toBe('no-display');
    expect(forcedDown.reason).toBe('explicit_override');

    const forcedUp = resolve({ platform: 'linux', env: { [BROWSER_TIER_ENV]: 'desktop' } });
    expect(forcedUp.tier).toBe('desktop');
    expect(forcedUp.reason).toBe('explicit_override');
  });

  it('ignores an unrecognised override value rather than inventing a tier', () => {
    const r = resolve({ platform: 'linux', env: { [BROWSER_TIER_ENV]: 'turbo' } });
    expect(r.tier).toBe('no-display');
    expect(r.reason).toBe('no_display_server');
  });

  it('lets a flag-selected rung beat detection but lose to the environment override', () => {
    const flagged = resolve({ platform: 'darwin', requestedTier: 'browser' });
    expect(flagged.tier).toBe('browser');
    expect(flagged.reason).toBe('flag_override');

    const envWins = resolve({
      platform: 'darwin',
      requestedTier: 'browser',
      env: { [BROWSER_TIER_ENV]: 'desktop' },
    });
    expect(envWins.tier).toBe('desktop');
    expect(envWins.reason).toBe('explicit_override');
  });
});

describe('resolveBrowserTier — degradation and deferral', () => {
  it('degrades a failed substrate acquisition to the browser rung WITH a reason', () => {
    // WHY: the failure this prevents is a substrate download that fails and degrades to the
    // lazy rung with no message — indistinguishable from a broken install.
    const r = resolve({ platform: 'darwin', substrateUnavailable: true });
    expect(r.tier).toBe('browser');
    expect(r.reason).toBe('substrate_unavailable');
    expect(r.remedy).toBeTruthy();
  });

  it('defers acquisition when a substrate is already installed (D13)', () => {
    const r = resolve({ platform: 'darwin', substrateInstalled: () => true });
    expect(r.tier).toBe('desktop');
    expect(r.reason).toBe('installed_substrate_present');
    expect(r.deferAcquisition).toBe(true);
  });

  it('does not defer acquisition when no substrate is installed', () => {
    expect(resolve({ platform: 'darwin' }).deferAcquisition).toBe(false);
  });

  it('lets physics beat an installed substrate: a no-display host still resolves no-display', () => {
    // WHY: a mapped window needs a display server. An installed component on a host that
    // cannot map a window is still unusable, so detection must not be short-circuited by it.
    const r = resolve({ platform: 'linux', substrateInstalled: () => true });
    expect(r.tier).toBe('no-display');
  });
});

describe('resolveBrowserTier — the reason is produced by the branch', () => {
  it('gives every tier more than one reason, so a reason cannot be read off the tier', () => {
    // WHY (probe P-6): if `reason` were derived from `tier`, every assertion about it would be
    // self-satisfying. Two distinct reasons landing on ONE tier is what makes that impossible.
    const desktopReasons = new Set([
      resolve({ platform: 'darwin' }).reason,
      resolve({ platform: 'linux', env: { DISPLAY: ':0' } }).reason,
      resolve({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }).reason,
      resolve({ platform: 'darwin', substrateInstalled: () => true }).reason,
    ]);
    expect(desktopReasons.size).toBe(4);

    const browserReasons = new Set([
      resolve({ platform: 'darwin', requestedTier: 'browser' }).reason,
      resolve({ platform: 'darwin', substrateUnavailable: true }).reason,
      resolve({ platform: 'darwin', env: { [BROWSER_TIER_ENV]: 'browser' } }).reason,
    ]);
    expect(browserReasons.size).toBe(3);
  });

  it('never returns an empty reason or an empty detail, on any branch', () => {
    const cases: BrowserTierInputs[] = [
      { platform: 'darwin' },
      { platform: 'win32' },
      { platform: 'linux', env: { DISPLAY: ':0' } },
      { platform: 'linux', env: { DISPLAY: ':99', CI: '1' } },
      { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } },
      { platform: 'linux' },
      { platform: 'darwin', requestedTier: 'browser' },
      { platform: 'darwin', substrateUnavailable: true },
      { platform: 'darwin', substrateInstalled: () => true },
      { platform: 'darwin', env: { [BROWSER_TIER_ENV]: 'no-display' } },
    ];
    for (const input of cases) {
      const r = resolve(input);
      expect(r.reason, JSON.stringify(input)).toBeTruthy();
      expect(r.detail, JSON.stringify(input)).toBeTruthy();
    }
  });
});

describe('resolveBrowserTier — no decision is silent (D-S10-9)', () => {
  it('warns once, with a reason and a remedy, when the tier is below the desktop default', () => {
    resolve({ platform: 'linux' });
    resolve({ platform: 'linux' });
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [, data] = warnMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(data.reason).toBe('no_display_server');
    expect(data.remedy).toBeTruthy();
    expect(data.ceiling).toBe(NO_DISPLAY_CEILING);
  });

  it('stays quiet on the plain detected desktop default', () => {
    // WHY: a warn on the healthy majority path is noise, and noise is what gets filtered out
    // right before it matters.
    resolve({ platform: 'darwin' });
    resolve({ platform: 'linux', env: { DISPLAY: ':0' } });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('warns separately for each distinct decision rather than latching on the first', () => {
    resolve({ platform: 'linux' });
    resolve({ platform: 'darwin', substrateUnavailable: true });
    expect(warnMock).toHaveBeenCalledTimes(2);
  });
});

describe('the stated no-display ceiling', () => {
  it('names all four signals, not one example of them', () => {
    // WHY (tracker rule 7): a ceiling described by ONE example reads narrower than it is. Each
    // clause is asserted on its own so deleting any single one reds.
    expect(NO_DISPLAY_CEILING).toMatch(/throwaway profile/i);
    expect(NO_DISPLAY_CEILING).toMatch(/fresh fingerprint/i);
    expect(NO_DISPLAY_CEILING).toMatch(/automation-launched/i);
    expect(NO_DISPLAY_CEILING).toMatch(/datacenter IP/i);
  });

  it('is attached to the no-display resolution, not merely exported', () => {
    expect(resolve({ platform: 'linux' }).ceiling).toBe(NO_DISPLAY_CEILING);
    expect(resolve({ platform: 'darwin' }).ceiling).toBeUndefined();
  });
});

describe('the resolver is the only display probe in src/ (D-S10-2)', () => {
  it('leaves no second reader of the display environment anywhere else', async () => {
    // WHY: this is the decision D-S10-2 exists to enforce, and it is not enforceable by a unit
    // test of the resolver alone — a second probe added elsewhere would leave every test here
    // green while the download decision and the routing decision quietly diverged. The repo
    // has already paid for that twice.
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = new URL('../../../src/', import.meta.url).pathname;

    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        if (full.endsWith('browser-tier.ts')) continue;
        const text = await readFile(full, 'utf8');
        if (/\bWAYLAND_DISPLAY\b/.test(text)) offenders.push(full.slice(root.length));
      }
    };
    await walk(root);

    expect(offenders).toEqual([]);
    // Control: the sweep can see the file it deliberately skips, so an empty result means
    // "nothing found" rather than "nothing looked at".
    const own = await readFile(join(root, 'fetch', 'browser-tier.ts'), 'utf8');
    expect(/\bWAYLAND_DISPLAY\b/.test(own)).toBe(true);
  });
});

describe('capability language in tier strings', () => {
  it('keeps every rendered tier string free of implementation and product names', () => {
    // WHY: these strings reach agents and users. The rule is capability language — "browser
    // engine", not the library. Asserted over the RENDERED strings, not the source file, whose
    // comments legitimately name the implementation.
    const banned = /electron|chromium|playwright|\bCDP\b|puppeteer|webkit/i;
    for (const [key, value] of Object.entries(TIER_USER_STRINGS)) {
      expect(value, `${key}: ${value}`).not.toMatch(banned);
    }
  });

  it('renders a string for every reason the resolver can return', () => {
    // WHY: `detail` is looked up by reason. A reason with no entry would render `undefined` to
    // the user, and a missing key is exactly what a new branch forgets.
    const reasons = [
      'explicit_override', 'flag_override', 'substrate_unavailable', 'installed_substrate_present',
      'platform_display_always', 'x11_display', 'wayland_display', 'virtual_display_ci', 'no_display_server',
    ];
    for (const reason of reasons) {
      expect(TIER_USER_STRINGS[`detail_${reason}`], reason).toBeTruthy();
    }
  });
});
