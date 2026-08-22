import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import electronPath from 'electron';
import { linuxSpawnArgs } from '../helpers/parity-expectations';

/**
 * THE MENU-BAR ITEM'S LIFETIME PREMISES, measured against the real browser engine (issue #71).
 *
 * `livingTrayPort` makes every method of a destroyed `Tray` a no-op. That guard rests on two claims
 * about the engine which no unit fixture can settle, because a double answers whatever it was written
 * to answer: that a destroyed item can still be ASKED whether it is destroyed, and that its setters
 * throw once it is. If the first were false the guard would throw from the guard itself; if the
 * second were false the guard would be decorative. So the engine is asked, and its answers are pinned
 * here — and the guard the probe runs is TRANSPILED FROM THE SHIPPED SOURCE, not restated, so it
 * cannot drift away from what the app actually loads.
 *
 * WHAT IT ESTABLISHES:
 *
 *  - LIFETIME IS READABLE. Unlike `BrowserWindow`, where reading `.webContents` on a dead window
 *    throws and forces the `||` ordering in `ipc-host.ts`, `tray.isDestroyed()` survives its own
 *    object. One plain read is enough, which is why the guard has one clause and not two.
 *
 *  - ALL THREE SETTERS THROW. The crash report named only `setTitle`. `setToolTip` and
 *    `setContextMenu` are on the same redraw and throw the same way, so a guard on `setLabel` alone
 *    would have moved the outage one line down. This is the arm that says so.
 *
 *  - THE UNGUARDED WRAPPER IS THE OUTAGE. `raw-dead` is the negative control: it is the exact shape
 *    that shipped, and it is what the guarded arms are measured against. Without it "no throw" would
 *    be a sentence about a situation that never throws anyway.
 *
 *  - BOTH ORDERINGS ARE COVERED. The reported stack arrives through a socket line handler, so the
 *    redraw can land after `destroy()` returned OR nested inside it, before it returned. Only a guard
 *    at the seam catches the second.
 *
 * The probe is a plain child process, not a driven one: a status-area item lives in no renderer, so
 * there is no page to attach to, and an uncaught MAIN-process exception is exactly what a driven
 * session cannot see from the far end of its own channel.
 */
const RUN = !!process.env.RUN_STUDIO_E2E;
const PROBE_MAIN = join(import.meta.dirname, 'tray-lifetime-probe-main.mjs');
const GUARD_SRC = join(import.meta.dirname, '../../src/main/tray-lifetime.ts');

interface Attempt {
  threw: boolean;
  message: string | null;
}
interface Arm {
  arm: string;
  calls?: Record<string, Attempt>;
  observed?: { isDestroyed: boolean; title: string | null };
  lifetimeRead?: Attempt;
  isDestroyed?: boolean;
  outer?: Attempt;
  nested?: Attempt[];
}
interface ProbeResult {
  electron: string;
  arms: Record<string, Arm>;
  uncaught: string[];
}

describe.skipIf(!RUN)('menu-bar item lifetimes — what the browser engine actually does', () => {
  let dir = '';
  let probe: ProbeResult;

  beforeAll(async () => {
    // Unattended runner: the app profile and the transpiled guard go under $TMPDIR, never in the tree.
    dir = mkdtempSync(join(tmpdir(), 'wigolo-tray-probe-'));

    // Electron cannot load TypeScript, and bundling the guard would drag the whole app in behind it.
    // `tray-lifetime.ts` has exactly one import and it is type-only, so a transpile with no resolution
    // is enough — and the emitted module is asserted below to be free of runtime imports, so an
    // accidental value import in a future edit fails here rather than silently pulling the app in.
    const emitted = ts.transpileModule(readFileSync(GUARD_SRC, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
    }).outputText;
    expect(emitted, 'the shipped guard no longer exports livingTrayPort under that name').toContain('livingTrayPort');
    expect(emitted, 'the guard grew a runtime import; the probe would measure a different module than the app loads').not.toMatch(/^\s*import\s/m);
    const guardModule = join(dir, 'tray-lifetime.mjs');
    writeFileSync(guardModule, emitted);

    // `linuxSpawnArgs` is not cosmetic on CI: without `--no-sandbox` a directly-spawned Electron dies
    // on the SUID sandbox helper under the runners' xvfb display, which reads as "the probe crashed".
    const { stdout } = await promisify(execFile)(electronPath as unknown as string, [PROBE_MAIN, ...linuxSpawnArgs()], {
      env: { ...process.env, WIGOLO_PROBE_USER_DATA: join(dir, 'profile'), WIGOLO_PROBE_GUARD_MODULE: guardModule },
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    });
    probe = JSON.parse(stdout.trim().split('\n').pop()!) as ProbeResult;
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('created a real item that the guard let through — otherwise every no-op below is vacuous', () => {
    const alive = probe.arms.alive!;
    for (const [name, call] of Object.entries(alive.calls!)) {
      expect(call.threw, `${name} threw on a LIVE item: ${call.message}`).toBe(false);
    }
    expect(alive.observed!.isDestroyed, 'the item reported itself destroyed while alive').toBe(false);
  });

  it('a destroyed item can still be asked whether it is destroyed, which is why one clause suffices', () => {
    const raw = probe.arms['raw-dead']!;
    expect(raw.lifetimeRead!.threw, 'isDestroyed() now throws on a dead item — the guard would throw from the guard itself').toBe(false);
    expect(raw.isDestroyed).toBe(true);
  });

  // The negative control, and the reason the guard covers three setters rather than the one the crash
  // report happened to name.
  it('every setter on a destroyed item throws — this is the outage, unguarded', () => {
    const calls = probe.arms['raw-dead']!.calls!;
    for (const name of ['setLabel', 'setToolTip', 'setMenu']) {
      expect(calls[name]!.threw, `${name} no longer throws on a dead item — that clause of the guard would be dead code`).toBe(true);
      expect(calls[name]!.message).toMatch(/destroyed/i);
    }
  });

  // Pinned because `tray-lifetime.ts` says so in prose and the double in the unit suite reproduces it.
  it('a second destroy is a no-op on the real item, not a throw', () => {
    expect(probe.arms['raw-dead']!.calls!.destroyAgain!.threw).toBe(false);
  });

  it('the guard absorbs a redraw that arrives after the item was destroyed', () => {
    const calls = probe.arms['guarded-dead']!.calls!;
    for (const [name, call] of Object.entries(calls)) {
      expect(call.threw, `${name} threw through the guard: ${call.message}`).toBe(false);
    }
  });

  it('the guard absorbs a redraw re-entered from inside the teardown itself', () => {
    const arm = probe.arms['guarded-teardown']!;
    expect(arm.outer!.threw, `destroy() threw: ${arm.outer!.message}`).toBe(false);
    expect(arm.nested!.length, 'the teardown never re-entered, so the interleaving was not measured').toBe(2);
    for (const call of arm.nested!) expect(call.threw, `a nested redraw threw: ${call.message}`).toBe(false);
  });

  // The whole point. A throw on the main process's stack becomes a modal dialog, and a modal is a
  // process that can never exit — twenty-one orphans, oldest alive two hours, ignoring SIGTERM.
  it('leaves no uncaught main-process exception behind — that is the modal-dialog hang class', () => {
    expect(probe.uncaught).toEqual([]);
  });
});
