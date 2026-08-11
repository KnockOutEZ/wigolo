import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/cli/tui/run-command.js', () => ({ runCommand: vi.fn() }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    createWriteStream: vi.fn(),
    chmodSync: vi.fn(),
  };
});

vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  return {
    chromium: { executablePath: vi.fn(() => '/fake/chromium'), launch: vi.fn(okLaunch) },
    firefox: { executablePath: vi.fn(() => '/fake/firefox'), launch: vi.fn(okLaunch) },
    webkit: { executablePath: vi.fn(() => '/fake/webkit'), launch: vi.fn(okLaunch) },
  };
});

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  checkPythonAvailable: vi.fn().mockReturnValue(false),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn().mockReturnValue(null),
}));

import { runCommand } from '../../../src/cli/tui/run-command.js';
import { runWarmup, warmupResultToJson } from '../../../src/cli/warmup.js';
import { resetBrowserTierAnnouncements, BROWSER_TIER_ENV } from '../../../src/fetch/browser-tier.js';

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };

beforeEach(() => {
  resetConfig();
  resetBrowserTierAnnouncements();
  vi.mocked(runCommand).mockReset().mockResolvedValue(ok);
  delete process.env[BROWSER_TIER_ENV];
});

afterEach(() => {
  delete process.env[BROWSER_TIER_ENV];
  resetConfig();
});

describe('warmup reads --browser (D-S10-8)', () => {
  it('selects the browser rung deterministically when --browser is passed', async () => {
    // WHY: the flag was documented in `help.ts` and passed from `browser-acquire.ts` on the
    // fetch hot path, while `runWarmup` inspected twelve other flags and never this one. It
    // appeared to work only because the browser install is unconditional — so the moment
    // S10-d gates that install on the tier, the lazy acquisition path silently stops
    // acquiring. This is the assertion that makes the flag load-bearing NOW, before the flip.
    const result = await runWarmup(['--browser']);
    expect(result.browserTier).toBe('browser');
    expect(result.browserTierReason).toBe('flag_override');
  });

  it('resolves a tier by detection when --browser is absent', async () => {
    const result = await runWarmup([]);
    expect(result.browserTierReason).not.toBe('flag_override');
    expect(result.browserTier).toBeTruthy();
  });

  it('still acquires the browser on the lazy path that browser-acquire.ts drives', async () => {
    // WHY (assertion 16): `browser-acquire.ts` calls runWarmup(['--browser']) and gates on
    // `playwright === 'ok'`. Making the flag meaningful must not make it exclusive — the rung
    // it selects is exactly the one whose binary has to be fetched.
    const result = await runWarmup(['--browser']);
    expect(result.playwright).toBe('ok');
  });

  it('lets the environment override beat the flag, in the resolver and in the result', async () => {
    process.env[BROWSER_TIER_ENV] = 'desktop';
    const result = await runWarmup(['--browser']);
    expect(result.browserTier).toBe('desktop');
    expect(result.browserTierReason).toBe('explicit_override');
  });
});

describe('warmup --json carries the tier under capability-named keys', () => {
  it('reports the tier and the reason without naming a library', async () => {
    const json = warmupResultToJson({
      playwright: 'ok',
      searxng: 'skipped',
      browserTier: 'no-display',
      browserTierReason: 'no_display_server',
    });
    expect(json.browserTier).toBe('no-display');
    expect(json.browserTierReason).toBe('no_display_server');
    expect(JSON.stringify(json)).not.toMatch(/playwright|searxng|electron|chromium/i);
  });
});

describe('the --browser flag is not a phantom in either of its two homes', () => {
  it('is read by runWarmup wherever it is documented or passed', async () => {
    // WHY (assertion 15): D-S10-8 permits exactly two end states — a real flag, or one deleted
    // from BOTH `help.ts` and `browser-acquire.ts`. What it forbids is the third, which is
    // what shipped: documented in one place, passed from another, read nowhere. Asserted over
    // both files so deleting it from one and not the other still reds.
    // A URL, not a `.pathname` string: on win32 `.pathname` yields `/C:/...` and every fs call
    // rejects it, so the check would fail on exactly one platform.
    const src = (rel: string) => new URL(`../../../src/${rel}`, import.meta.url);
    const [help, acquire, warmup] = await Promise.all([
      readFile(src('cli/help.ts'), 'utf8'),
      readFile(src('fetch/browser-acquire.ts'), 'utf8'),
      readFile(src('cli/warmup.ts'), 'utf8'),
    ]);

    const documented = help.includes('--browser');
    const passed = acquire.includes("'--browser'");
    const read = /flagSet\.has\('--browser'\)/.test(warmup);

    expect(read || (!documented && !passed)).toBe(true);
    // Control: the sweep is looking at the right files — the flag really is in both homes
    // today, so a green above means "read", not "nothing to find".
    expect(documented && passed).toBe(true);
  });
});
