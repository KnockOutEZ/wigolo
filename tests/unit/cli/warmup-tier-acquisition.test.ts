import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfig } from '../../../src/config.js';

/**
 * S10-d — tier-conditional acquisition, asserted at the `runWarmup` boundary.
 *
 * ⚠ `node:fs` is deliberately NOT mocked here. The claim under test is about BYTES ON DISK —
 * "a no-display host acquires zero component bytes" — and a mocked filesystem turns that into a
 * claim about which mock was called, which is exactly the substitution that lets a suite stay
 * green while the production path writes somewhere else. So the component directory is real,
 * the copies are real, and the assertions are `existsSync` on the directory the budget gates
 * measure. Only the browser-engine install and the search sidecar are stubbed, because those
 * are network downloads and neither is what these tests are about.
 */

vi.mock('../../../src/cli/tui/run-command.js', () => ({ runCommand: vi.fn() }));

vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  // A REAL path, because `node:fs` is real here: the install's smoke-test probes the executable
  // on disk, and the sibling suites only get away with `/fake/chromium` because they mock
  // `existsSync` to true. `process.execPath` is simply a file that is certain to exist.
  const real = () => process.execPath;
  return {
    chromium: { executablePath: vi.fn(real), launch: vi.fn(okLaunch) },
    firefox: { executablePath: vi.fn(real), launch: vi.fn(okLaunch) },
    webkit: { executablePath: vi.fn(real), launch: vi.fn(okLaunch) },
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
import { SUBSTRATE_PATH_ENV, resetSubstratePresenceCache, substrateRoot } from '../../../src/studio/substrate-acquire.js';

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };

let dataDir: string;
let sourceDir: string;

/** True when any component byte landed in the directory the budget gates measure. */
function componentBytesAcquired(): boolean {
  return existsSync(join(substrateRoot(dataDir), '2.0.0', 'bin', 'run'));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-warmup-tier-'));
  sourceDir = mkdtempSync(join(tmpdir(), 'wigolo-warmup-src-'));
  writeFileSync(join(sourceDir, 'substrate.json'), JSON.stringify({ version: '2.0.0', executable: 'bin/run' }));
  mkdirSync(join(sourceDir, 'bin'), { recursive: true });
  writeFileSync(join(sourceDir, 'bin', 'run'), '#!/bin/sh\n');

  process.env.WIGOLO_DATA_DIR = dataDir;
  delete process.env[BROWSER_TIER_ENV];
  delete process.env[SUBSTRATE_PATH_ENV];
  resetConfig();
  resetBrowserTierAnnouncements();
  resetSubstratePresenceCache();
  vi.mocked(runCommand).mockReset().mockResolvedValue(ok);
});

afterEach(() => {
  delete process.env.WIGOLO_DATA_DIR;
  delete process.env[BROWSER_TIER_ENV];
  delete process.env[SUBSTRATE_PATH_ENV];
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
  resetConfig();
});

describe('desktop tier — the component TAKES the browser engine\'s slot (assertion 11)', () => {
  beforeEach(() => {
    process.env[BROWSER_TIER_ENV] = 'desktop';
    process.env[SUBSTRATE_PATH_ENV] = sourceDir;
    resetConfig();
  });

  it('acquires the desktop component', async () => {
    const r = await runWarmup([]);
    expect(r.substrate).toBe('acquired');
    expect(componentBytesAcquired()).toBe(true);
  });

  it('does NOT also acquire the browser engine', async () => {
    // WHY: this is amended-D1's doubling regression, and it is the single assertion the whole
    // flip turns on. Acquiring both lands at 300 + 546 + 218 = 1064 MiB against G-ACQUIRE's 880.
    // `skipped` rather than `ok` is what says the slot was taken, not shared.
    const r = await runWarmup([]);
    expect(r.playwright).toBe('skipped');
  });

  it('does not re-acquire a component that is already installed (D13)', async () => {
    // WHY: the resolver's `deferAcquisition` and the acquirer read the SAME record, so this is
    // where that single seam is observed end to end — a second probe is how the two could
    // disagree about whether to spend 300 MiB.
    await runWarmup([]);
    resetBrowserTierAnnouncements();
    const second = await runWarmup([]);
    expect(second.substrate).toBe('already_present');
  });
});

describe('desktop tier with nothing to acquire — degrades, loudly, and warmup survives', () => {
  beforeEach(() => {
    process.env[BROWSER_TIER_ENV] = 'desktop';
    resetConfig();
  });

  it('reports the component as unavailable rather than failing the run', async () => {
    // WHY (assertion 14): a failed or absent optional component must not take warmup down. This
    // is also today's DEFAULT path on every machine — no artifact is published yet — so a
    // regression here breaks every install, not an edge case.
    const r = await runWarmup([]);
    expect(r.substrate).toBe('no_source');
  });

  it('still acquires the browser engine, so the machine is left with a rung that works', async () => {
    const r = await runWarmup([]);
    expect(r.playwright).toBe('ok');
  });

  it('acquires no component bytes when there is no component to acquire', async () => {
    await runWarmup([]);
    expect(existsSync(substrateRoot(dataDir))).toBe(false);
  });
});

describe('no-display tier — ZERO component bytes (assertion 12, D-S10-5)', () => {
  beforeEach(() => {
    process.env[BROWSER_TIER_ENV] = 'no-display';
    resetConfig();
  });

  it('acquires zero component bytes even when a component IS available to acquire', async () => {
    // WHY THIS IS THE STRONGEST FORM OF THE ASSERTION: with no source configured, "acquired
    // nothing" is true for a reason that has nothing to do with the tier, and the test would
    // pass on a build whose no-display branch was never written. So the source is put right
    // there, ready to install, and the tier is what must refuse it. A machine that cannot map a
    // window cannot run the component at all, so any byte spent on it is pure waste.
    process.env[SUBSTRATE_PATH_ENV] = sourceDir;
    resetConfig();
    await runWarmup([]);
    expect(existsSync(substrateRoot(dataDir))).toBe(false);
  });

  it('never even reports a component outcome, because it does not attempt one', async () => {
    process.env[SUBSTRATE_PATH_ENV] = sourceDir;
    resetConfig();
    const r = await runWarmup([]);
    expect(r.substrate).toBeUndefined();
  });

  it('acquires the browser engine eagerly, because that is this host\'s rung', async () => {
    // WHY: `warmup` exists to pre-download what the machine will use. The no-display rung is the
    // browser engine, so leaving it lazy here would trade 300 MiB of waste for a slow first fetch.
    //
    // ⚠ THE SOURCE IS SET DELIBERATELY, and a probe is why. Without it this test passed even
    // when the no-display branch was mutated to acquire the component — because with nothing to
    // acquire the run degrades and installs the engine anyway, so "engine acquired" was true for
    // a reason that had nothing to do with the tier. With a component sitting there ready, the
    // engine can only be acquired if the tier actually refused the component.
    process.env[SUBSTRATE_PATH_ENV] = sourceDir;
    resetConfig();
    const r = await runWarmup([]);
    expect(r.playwright).toBe('ok');
  });

  it('reports whether an authentic system browser is present (assertion 13)', async () => {
    process.env[SUBSTRATE_PATH_ENV] = sourceDir;
    resetConfig();
    const r = await runWarmup([]);
    expect(['present', 'absent']).toContain(r.systemBrowser);
  });
});

describe('the browser rung keeps working now that acquisition is conditional (D-S10-8)', () => {
  it('acquires the engine and no component when --browser selects the rung', async () => {
    // WHY (assertion 16): `browser-acquire.ts` drives `runWarmup(['--browser'])` from the fetch
    // hot path and gates on `playwright === 'ok'`. Making acquisition conditional is exactly what
    // could have silently stopped that path acquiring anything.
    process.env[SUBSTRATE_PATH_ENV] = sourceDir;
    resetConfig();
    const r = await runWarmup(['--browser']);
    expect(r.playwright).toBe('ok');
    expect(existsSync(substrateRoot(dataDir))).toBe(false);
  });

  it('keeps the explicit environment override above the flag, and above the degradation', async () => {
    // WHY: pins a precedence that is otherwise only visible by reading three branches. An
    // operator who forced `desktop` keeps it even when the component could not be acquired —
    // the resolver ranks an explicit instruction above its own detection, and `doctor` is what
    // then reports the component as missing.
    process.env[BROWSER_TIER_ENV] = 'desktop';
    resetConfig();
    const r = await runWarmup(['--browser']);
    expect(r.browserTier).toBe('desktop');
    expect(r.browserTierReason).toBe('explicit_override');
  });
});

describe('the --json contract carries the component under capability-named keys', () => {
  it('renames the component and system-browser fields and names no library', async () => {
    const json = warmupResultToJson({
      playwright: 'skipped',
      searxng: 'skipped',
      browserTier: 'desktop',
      browserTierReason: 'platform_display_always',
      substrate: 'acquired',
      systemBrowser: 'present',
    });
    expect(json.desktopComponent).toBe('acquired');
    expect(json.systemBrowser).toBe('present');
    expect(json.browserEngine).toBe('skipped');
    expect(JSON.stringify(json)).not.toMatch(/playwright|searxng|electron|chromium|substrate/i);
  });

  it('omits the component keys entirely on a rung that never attempts one', async () => {
    // WHY: absent and "not acquired" are different states, and a consumer that sees
    // `desktopComponent: "no_source"` on a no-display host would read a failure where there was
    // never an attempt.
    const json = warmupResultToJson({
      playwright: 'ok',
      searxng: 'skipped',
      browserTier: 'no-display',
      browserTierReason: 'no_display_server',
    });
    expect('desktopComponent' in json).toBe(false);
  });
});
