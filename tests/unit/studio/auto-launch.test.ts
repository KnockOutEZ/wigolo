import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureStudioRunning, resetAutoLaunchState } from '../../../src/studio/auto-launch.js';
import type { SessionHandle } from '../../../src/studio/handle.js';

/**
 * S9 — amended-D4 auto-launch.
 *
 * The ruling this implements: starting a process is not a consent event, so a clean-profile launch is free and
 * prompt-less; spending the human's identity IS, and D9's card gates that. So the tests here are about
 * mechanics rather than permission — that a launch happens at most once, that nothing hangs, and that a
 * machine with no substrate degrades to the pre-S9 decline instead of a confusing failure.
 */

let dir: string;
let originalEnv: NodeJS.ProcessEnv;

const HANDLE: SessionHandle = { id: 's1', endpoint: 'http://127.0.0.1:1/mcp', token: 't', pid: 1, instanceId: 'other' };

function publishHandle(): void {
  mkdirSync(join(dir, 'studio'), { recursive: true });
  writeFileSync(join(dir, 'studio', 'current.json'), JSON.stringify(HANDLE));
}

beforeEach(() => {
  originalEnv = process.env;
  process.env = { ...originalEnv };
  dir = mkdtempSync(join(tmpdir(), 'wig-launch-'));
  resetAutoLaunchState();
});
afterEach(() => {
  process.env = originalEnv;
  resetAutoLaunchState();
  rmSync(dir, { recursive: true, force: true });
});

const noSleep = async (): Promise<void> => {};

describe('ensureStudioRunning', () => {
  it('returns the existing handle without launching anything', async () => {
    publishHandle();
    const launch = vi.fn();
    const h = await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep });
    expect(h?.endpoint).toBe(HANDLE.endpoint);
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches, then returns the handle once the host publishes one', async () => {
    // The handle is written LAST, after the host's handlers are wired, so its appearance is the only honest
    // "ready" signal — watching the child process would report ready before the gateway could answer.
    const launch = vi.fn(() => publishHandle());
    const h = await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(h?.endpoint).toBe(HANDLE.endpoint);
  });

  it('is prompt-less — nothing in the module asks for a decision', async () => {
    const src = readFileSync(new URL('../../../src/studio/auto-launch.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/approval|confirm|prompt\(|readline/i);
  });

  it('declines when the substrate is not present, instead of shelling at an app that is not there', async () => {
    const launch = vi.fn();
    expect(await ensureStudioRunning({ dataDir: dir, launch, launchable: () => false, sleep: noSleep })).toBeNull();
    expect(launch).not.toHaveBeenCalled();
  });

  it('honours the operator kill switch', async () => {
    process.env.WIGOLO_STUDIO_AUTO_LAUNCH = '0';
    const launch = vi.fn();
    expect(await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep })).toBeNull();
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns null on a launch that never publishes, rather than hanging', async () => {
    // A blocked page must not turn into a stalled tool call. The budget is bounded and the caller degrades.
    const launch = vi.fn();
    const h = await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, timeoutMs: 0, pollMs: 1, sleep: noSleep });
    expect(h).toBeNull();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('returns null when the spawn itself throws — a launch problem is never the user-visible error', async () => {
    const launch = vi.fn(() => { throw new Error('ENOENT npm'); });
    expect(await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep })).toBeNull();
  });

  it('is SINGLE-FLIGHT: several blocked pages at once start ONE app, not one each', async () => {
    // A challenge wall usually blocks a handful of URLs in the same breath. Without this, each of them races
    // to spawn its own Electron app and the user gets a pile of windows for one wall.
    let ticks = 0;
    const launch = vi.fn(() => { /* publishes on the third poll below */ });
    const sleep = async (): Promise<void> => { if (++ticks === 3) publishHandle(); };
    const results = await Promise.all([
      ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, pollMs: 1, sleep }),
      ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, pollMs: 1, sleep }),
      ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, pollMs: 1, sleep }),
    ]);
    expect(launch).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r?.endpoint).toBe(HANDLE.endpoint);
  });

  it('a later call can launch again after the first attempt settled', async () => {
    const launch = vi.fn();
    await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, timeoutMs: 0, sleep: noSleep });
    await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, timeoutMs: 0, sleep: noSleep });
    expect(launch).toHaveBeenCalledTimes(2);
  });
});

describe('studioLaunchable — the recorded distribution ceiling', () => {
  it('is FALSE by default in a repo checkout — the test suite must not spawn a desktop app', async () => {
    // This is how the ceiling was found: with the dev launcher unconditional, a challenge-blocked fetch in
    // this repo's own suite really did try to run `npm run dev -w apps/studio` and then wait out its budget.
    // Until the app ships as an installable, an unasked `npm run dev` in someone's checkout is not acceptable.
    delete process.env.WIGOLO_STUDIO_AUTO_LAUNCH;
    const { studioLaunchable } = await import('../../../src/studio/auto-launch.js');
    expect(studioLaunchable()).toBe(false);
  });

  it('is TRUE in a checkout once the dev launcher is explicitly opted in', async () => {
    process.env.WIGOLO_STUDIO_AUTO_LAUNCH = '1';
    const { studioLaunchable } = await import('../../../src/studio/auto-launch.js');
    expect(studioLaunchable()).toBe(true);
  });

  it('the explicit disable still wins over the opt-in', async () => {
    process.env.WIGOLO_STUDIO_AUTO_LAUNCH = '0';
    const launch = vi.fn();
    expect(await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep })).toBeNull();
    expect(launch).not.toHaveBeenCalled();
  });
});
