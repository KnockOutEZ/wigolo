import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import electronPath from 'electron';
import { linuxSpawnArgs } from '../helpers/parity-expectations';

/**
 * THE DESTROYED-GUARD'S LIFETIME PREMISES, measured against the real browser engine (issue #67).
 *
 * `stateBroadcaster` skips its push on `win.isDestroyed() || win.webContents.isDestroyed()`. Its
 * comment used to claim that also covered a crashed render process, and that claim is not checkable
 * from any unit fixture: a fake answers whatever it was written to answer, so a suite built only from
 * fakes can agree with a wrong comment forever. The engine is the only witness to which lifetimes
 * actually move together, so this spec asks it and pins the answers the comment is allowed to make.
 *
 * WHAT IT ESTABLISHES, and why each one is load-bearing rather than trivia:
 *
 *  - CRASH. A crashed webContents is NOT destroyed — Electron keeps the object alive for reload,
 *    which is why `isCrashed()` and `render-process-gone` exist at all. So the guard's second clause
 *    cannot cover the crash path: it evaluates false and the send goes ahead. That send is BENIGN —
 *    it posts into a dead channel and returns — so the #394 uncaught-main-exception hang class is not
 *    reachable this way. If a future engine version makes it throw, this reds and the guard needs the
 *    crash condition the comment once implied it already had.
 *
 *  - CLOSE. `webContents.close()` leaves the window alive with its contents destroyed, and the send
 *    then throws `Object has been destroyed`. This is the NEGATIVE CONTROL for the whole guard: it is
 *    the one measurement proving the second clause is load-bearing rather than decorative. Delete
 *    `|| win.webContents.isDestroyed()` and this arm is what the app hits.
 *
 *  - WINDESTROY. On a destroyed window the PROPERTY ACCESS throws before any call happens, which is
 *    why `win.isDestroyed()` has to be first and why the two clauses are joined by `||` rather than
 *    evaluated together. A reordered guard would throw from the guard itself.
 *
 * The probe is a plain child process, not a driven one: `forcefullyCrashRenderer()` kills the render
 * process an automation channel would be attached to, so a driven run would lose its connection at
 * the moment of measurement and report a harness failure instead of a verdict.
 */
const RUN = !!process.env.RUN_STUDIO_E2E;
const PROBE_MAIN = join(import.meta.dirname, 'crash-push-probe-main.mjs');

interface ArmFlags {
  winDestroyed: boolean | null;
  wcDestroyed: boolean | null;
  wcCrashed: boolean | null;
  readThrew: boolean;
  readMessage: string | null;
}
interface Arm {
  arm: string;
  gone?: { reason: string; exitCode: number };
  flags: ArmFlags;
  guardWouldSkip: boolean;
  send: { threw: boolean; message: string | null };
}
interface ProbeResult {
  electron: string;
  chrome: string;
  arms: Record<string, Arm>;
  uncaught: string[];
}

describe.skipIf(!RUN)('destroyed-guard lifetimes — what the browser engine actually does', () => {
  let profile = '';
  let probe: ProbeResult;

  beforeAll(async () => {
    // Unattended runner: the app profile goes under $TMPDIR, never inside the working tree.
    profile = mkdtempSync(join(tmpdir(), 'wigolo-crash-probe-'));
    // `linuxSpawnArgs` is not cosmetic on CI: without `--no-sandbox` a directly-spawned Electron dies
    // on the SUID sandbox helper under the runners' xvfb display, which reads as "the probe crashed"
    // rather than as a missing switch.
    const { stdout } = await promisify(execFile)(electronPath as unknown as string, [PROBE_MAIN, ...linuxSpawnArgs()], {
      env: { ...process.env, WIGOLO_PROBE_USER_DATA: profile },
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    });
    probe = JSON.parse(stdout.trim().split('\n').pop()!) as ProbeResult;
  }, 120_000);

  afterAll(() => {
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it('kills the renderer for real — a probe that never crashed anything measures nothing', () => {
    expect(probe.arms.crash!.gone, 'render-process-gone never fired; the crash arm proves nothing').toBeDefined();
    // WHICH abnormal reason the engine reports is platform detail — macOS says `killed` — so the
    // assertion is that it was not an orderly one. `isCrashed()` below is what pins the crash state.
    expect(probe.arms.crash!.gone!.reason, 'the renderer exited cleanly, so nothing was crashed').not.toBe('clean-exit');
  });

  it('a crashed webContents is alive and not destroyed, so the guard cannot see the crash', () => {
    const { flags } = probe.arms.crash!;
    expect(flags.wcDestroyed, 'a crashed contents reported destroyed — the guard would now cover the crash path and the comment may be rewritten').toBe(false);
    expect(flags.wcCrashed, 'isCrashed() was false right after render-process-gone — the arm did not measure the crash state').toBe(true);
  });

  it('the shipped guard proceeds on the crash path rather than skipping', () => {
    // This is the exact sentence the file comment is allowed to make. If it ever flips, the comment
    // is wrong again in the other direction.
    expect(probe.arms.crash!.guardWouldSkip).toBe(false);
  });

  it('pushing state into a crashed contents is benign — no throw, no uncaught main-process exception', () => {
    expect(probe.arms.crash!.send.threw, `send into a crashed contents threw: ${probe.arms.crash!.send.message} — the guard now needs the crash condition`).toBe(false);
    expect(probe.uncaught, 'an uncaught main-process exception landed — that is the modal-dialog hang class, asynchronously').toEqual([]);
  });

  it('after webContents.close() the window is still alive while its contents are destroyed', () => {
    const { flags } = probe.arms.close!;
    expect(flags.winDestroyed, 'the window died with its contents — then the window clause alone would suffice').toBe(false);
    expect(flags.wcDestroyed).toBe(true);
  });

  it('the second clause is load-bearing: without it, close() reaches a send that throws', () => {
    // The negative control. `guardWouldSkip` is true here only BECAUSE of the wcDestroyed clause, and
    // the send that clause prevents is the one that throws.
    expect(probe.arms.close!.guardWouldSkip).toBe(true);
    expect(probe.arms.close!.send.threw, 'send through a destroyed contents no longer throws — the second clause would be dead code').toBe(true);
    expect(probe.arms.close!.send.message).toMatch(/destroyed/i);
  });

  it('on a destroyed window the property access itself throws, which is why the window check is first', () => {
    const { flags } = probe.arms.windestroy!;
    expect(flags.winDestroyed).toBe(true);
    expect(flags.readThrew, 'reading .webContents on a dead window no longer throws — the || ordering would stop mattering').toBe(true);
    expect(flags.readMessage).toMatch(/destroyed/i);
  });
});
