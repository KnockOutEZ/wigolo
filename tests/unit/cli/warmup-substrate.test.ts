import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * EXTRACT C6 — the §2.2 table's claim for `warmup` is that the desktop component is STILL
 * acquired after the extraction: the acquisition did not leave with the domain layer, it moved to
 * `src/companion/substrate-acquire.ts` and warmup still drives it.
 *
 * `warmup-tier-acquisition.test.ts` proves the BYTES land on disk, using the real module against a
 * local source directory. That test would stay green against any acquisition implementation, so it
 * cannot say WHICH module warmup called. This file is the complementary half: `acquireSubstrate`
 * is mocked at the companion path, and the assertions are about warmup calling it and reporting
 * what it returned. Together they pin both halves of the claim — it really acquires, and it
 * acquires through the companion module.
 */

vi.mock('../../../src/cli/tui/run-command.js', () => ({ runCommand: vi.fn() }));
vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
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

const { acquireSubstrateMock } = vi.hoisted(() => ({ acquireSubstrateMock: vi.fn() }));

// The seam under test. Mocked at the companion path: if warmup's import moved elsewhere, this
// mock would never be consulted and every assertion below would miss.
vi.mock('../../../src/companion/substrate-acquire.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/companion/substrate-acquire.js')>()),
  acquireSubstrate: acquireSubstrateMock,
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand } from '../../../src/cli/tui/run-command.js';
import { runWarmup, warmupResultToJson } from '../../../src/cli/warmup.js';
import { resetConfig } from '../../../src/config.js';
import {
  resetBrowserTierAnnouncements,
  BROWSER_TIER_ENV,
} from '../../../src/fetch/browser-tier.js';
import {
  SUBSTRATE_PATH_ENV,
  resetSubstratePresenceCache,
} from '../../../src/companion/substrate-acquire.js';

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };
let dataDir: string;

/** A silent reporter: warmup's default one paints a TUI we have no interest in here. */
const quiet = {
  note: () => {},
  start: () => {},
  success: () => {},
  fail: () => {},
  finish: () => {},
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-warmup-substrate-'));
  process.env.WIGOLO_DATA_DIR = dataDir;
  process.env[BROWSER_TIER_ENV] = 'desktop';
  delete process.env[SUBSTRATE_PATH_ENV];
  resetConfig();
  resetBrowserTierAnnouncements();
  resetSubstratePresenceCache();
  vi.mocked(runCommand).mockReset().mockResolvedValue(ok);
  acquireSubstrateMock.mockReset().mockResolvedValue({
    outcome: 'acquired',
    detail: 'desktop component ready',
  });
});

afterEach(() => {
  delete process.env.WIGOLO_DATA_DIR;
  delete process.env[BROWSER_TIER_ENV];
  rmSync(dataDir, { recursive: true, force: true });
  resetConfig();
});

describe('warmup still acquires the desktop component, through the companion module', () => {
  it('calls the companion acquisition on the desktop rung', async () => {
    // The §2.2 claim in one assertion: the acquisition survived the extraction.
    await runWarmup(['--browser-only'], quiet);
    expect(acquireSubstrateMock).toHaveBeenCalledTimes(1);
  });

  it('reports the outcome the companion module returned, not a fixed string', async () => {
    acquireSubstrateMock.mockResolvedValue({ outcome: 'acquired', detail: 'fetched' });
    const result = await runWarmup(['--browser-only'], quiet);
    expect(result.substrate).toBe('acquired');
  });

  it('distinguishes an already-installed component from a fresh acquisition (D13)', async () => {
    // The two states cost very different amounts of network, and an operator who cannot tell
    // them apart cannot tell a slow warmup from a broken one.
    acquireSubstrateMock.mockResolvedValue({ outcome: 'already_present', detail: 'on disk' });
    const result = await runWarmup(['--browser-only'], quiet);
    expect(result.substrate).toBe('already_present');
    expect(result.substrateError).toBeUndefined();
  });

  it('carries the companion module\'s error text through to the result', async () => {
    acquireSubstrateMock.mockResolvedValue({
      outcome: 'unavailable',
      detail: 'nothing published for this platform',
      error: 'no artifact for darwin-arm64',
    });
    const result = await runWarmup(['--browser-only'], quiet);
    expect(result.substrate).toBe('unavailable');
    expect(result.substrateError).toBe('no artifact for darwin-arm64');
  });

  it('degrades to the browser rung instead of failing the run when acquisition fails', async () => {
    // Failure degrades LOUDLY but never takes warmup down: a machine left with no working rung
    // because a component was missing is the regression this branch exists to prevent.
    acquireSubstrateMock.mockResolvedValue({
      outcome: 'unavailable',
      detail: 'nothing published',
      error: 'unavailable',
    });
    const result = await runWarmup(['--browser-only'], quiet);
    // The engine install runs after all — the machine is left with a rung that works — and the
    // reason is carried rather than swallowed. (The resolved tier itself is not asserted here:
    // this arm forces the tier through the env override, which by design outranks the
    // unavailable-component re-resolution.)
    expect(result.playwright).not.toBe('skipped');
    expect(result.substrateError).toBe('unavailable');
  });

  it('skips the browser-engine install when the component took its slot (assertion 11)', async () => {
    // The component TAKES the engine's slot rather than being added alongside it — acquiring
    // both is the doubling regression the tier-conditional design prevents.
    acquireSubstrateMock.mockResolvedValue({ outcome: 'acquired', detail: 'ready' });
    const result = await runWarmup(['--browser-only'], quiet);
    expect(result.playwright).toBe('skipped');
  });

  it('never asks the companion module for a component on a rung that cannot run one', async () => {
    // no-display acquires ZERO component bytes. Asserted as "was never called", because a call
    // that returns early still spends the round trip that this rung exists to avoid.
    process.env[BROWSER_TIER_ENV] = 'no-display';
    resetBrowserTierAnnouncements();
    resetConfig();
    await runWarmup(['--browser-only'], quiet);
    expect(acquireSubstrateMock).not.toHaveBeenCalled();
  });

  it('names the component under a capability-named key in the --json contract', async () => {
    // User-facing machine output: it reports a desktop component, never a library or product name.
    acquireSubstrateMock.mockResolvedValue({ outcome: 'acquired', detail: 'ready' });
    const result = await runWarmup(['--browser-only'], quiet);
    const json = warmupResultToJson(result) as Record<string, unknown>;
    expect(json.desktopComponent).toBe('acquired');
    expect(Object.keys(json).join(' ')).not.toMatch(/substrate|electron|studio/i);
  });
});
