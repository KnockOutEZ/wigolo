import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../src/config.js';

// Prevent the warmup from actually installing anything heavy.
//
// This claim is about `wipeSearxngState` and nothing else: five paths under the temp data
// dir, gone. Every acquisition seam `runWarmup` walks on the way there is therefore stubbed,
// because leaving one real makes the cost of asserting a file deletion the cost of a package
// download. The searxng stub below used to be the whole of this — but the sidecar became
// opt-in (D1), so a bare `--force` skips that phase anyway, while the browser phase became
// UNCONDITIONAL. That left the one genuinely expensive path unstubbed:
//
//   src/cli/warmup.ts:188  runCommand(node, [cli, 'install', 'chromium'])   — 300s budget, 2 attempts
//   src/cli/warmup.ts:103  runCommand('sudo', [..., 'install-deps', ...])   — apt-get update + install
//   src/cli/warmup.ts:206  probeBrowser('chromium')                         — real headless launch
//
// The middle one is Linux-only (`process.platform !== 'linux'` returns early elsewhere), which
// is exactly why only the ubuntu leg timed out: `install-deps` shells out to apt-get, whose
// duration is network-bound and varies run to run well past any per-test budget.
vi.mock('../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false }),
}));

vi.mock('../../src/fetch/browser-probe.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/fetch/browser-probe.js')>('../../src/fetch/browser-probe.js');
  return {
    ...actual,
    probeBrowser: vi.fn().mockResolvedValue({ onDisk: true, launchable: true, execPath: '/stub/chromium' }),
  };
});

vi.mock('../../src/fetch/driver-acquire.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/fetch/driver-acquire.js')>('../../src/fetch/driver-acquire.js');
  return {
    ...actual,
    acquireBrowserDriver: vi.fn().mockResolvedValue({
      outcome: 'already_present',
      detail: 'browser engine driver already available',
    }),
  };
});

// `no_source` is what a real host reports today, so the branch runWarmup takes is unchanged —
// this only guarantees a published component can never turn this test into a download.
vi.mock('../../src/companion/substrate-acquire.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/companion/substrate-acquire.js')>('../../src/companion/substrate-acquire.js');
  return {
    ...actual,
    acquireSubstrate: vi.fn().mockResolvedValue({
      outcome: 'no_source',
      detail: 'no desktop component is published for this platform yet, so none was downloaded',
    }),
  };
});

vi.mock('../../src/searxng/bootstrap.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/searxng/bootstrap.js')>('../../src/searxng/bootstrap.js');
  return {
    ...actual,
    bootstrapNativeSearxng: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
    spawnSync: vi.fn(),
  };
});

import { runWarmup } from '../../src/cli/warmup.js';

describe('warmup --force (integration)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-warmupforce-'));
    process.env.WIGOLO_DATA_DIR = dataDir;
    resetConfig();
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.WIGOLO_DATA_DIR;
    resetConfig();
  });

  it('wipes a pre-existing failed state and re-bootstraps', async () => {
    mkdirSync(join(dataDir, 'searxng'), { recursive: true });
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ status: 'failed', attempts: 3 }));
    writeFileSync(join(dataDir, 'bootstrap.lock'), JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }));
    writeFileSync(join(dataDir, 'searxng.lock'), JSON.stringify({ pid: 999999999, port: 8888 }));
    writeFileSync(join(dataDir, 'searxng.port'), '8888');

    await runWarmup(['--force']);

    expect(existsSync(join(dataDir, 'state.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'searxng'))).toBe(false);
    expect(existsSync(join(dataDir, 'searxng.lock'))).toBe(false);
    expect(existsSync(join(dataDir, 'searxng.port'))).toBe(false);
    expect(existsSync(join(dataDir, 'bootstrap.lock'))).toBe(false);
  });
});
