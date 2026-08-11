import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfig } from '../../../src/config.js';
import { installedSubstrateExists, studioLaunchable } from '../../../src/studio/auto-launch.js';
import { acquireSubstrate, localPathSource, resetSubstratePresenceCache, substrateRoot } from '../../../src/studio/substrate-acquire.js';

/**
 * D-S10-3's seam, made real by S10-d. Until this slice `installedSubstrateExists()` returned a
 * hardcoded `false`, so every consumer of it — the tier resolver's D13 deferral, `studioLaunchable`
 * — was exercising one branch only.
 */

let dataDir: string;
let sourceDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-ise-data-'));
  sourceDir = mkdtempSync(join(tmpdir(), 'wigolo-ise-src-'));
  writeFileSync(join(sourceDir, 'substrate.json'), JSON.stringify({ version: '3.0.0', executable: 'bin/run' }));
  mkdirSync(join(sourceDir, 'bin'), { recursive: true });
  writeFileSync(join(sourceDir, 'bin', 'run'), '#!/bin/sh\n');
  process.env.WIGOLO_DATA_DIR = dataDir;
  resetConfig();
  // The presence answer is memoized for the fetch path; each case starts from a cold one so the
  // order of cases cannot decide the result.
  resetSubstratePresenceCache();
});

afterEach(() => {
  delete process.env.WIGOLO_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
  resetConfig();
});

describe('installedSubstrateExists answers from the acquisition record', () => {
  it('is false on a machine that has acquired nothing', () => {
    expect(installedSubstrateExists()).toBe(false);
  });

  it('becomes true once a component has actually been acquired', async () => {
    // WHY: the whole point of the seam. A hardcoded `false` meant D13's deferral branch could
    // never be reached in production, so the resolver's `installed_substrate_present` reason was
    // unreachable outside a test that injected the probe.
    await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    expect(installedSubstrateExists()).toBe(true);
  });

  it('goes back to false when the component the record names is deleted', async () => {
    // WHY: this is the difference between reading the RECORD and reading the DIRECTORY. A user
    // who clears out the component leaves the record behind; treating that as installed would
    // make the resolver defer acquisition forever in favour of a rung it can never start.
    await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    rmSync(join(substrateRoot(dataDir), '3.0.0'), { recursive: true, force: true });
    expect(installedSubstrateExists()).toBe(false);
  });

  it('makes the substrate launchable without the dev-checkout opt-in', async () => {
    // WHY: `studioLaunchable()` gated everything behind WIGOLO_STUDIO_AUTO_LAUNCH because the only
    // thing to launch was a dev checkout, and starting `npm run dev` in an arbitrary repo from an
    // agent's fetch is not something to do unasked. An ACQUIRED component carries no such caveat —
    // the user installed it — so the opt-in must stop being required exactly here.
    delete process.env.WIGOLO_STUDIO_AUTO_LAUNCH;
    expect(studioLaunchable()).toBe(false);
    await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    expect(studioLaunchable()).toBe(true);
  });
});
