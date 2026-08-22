/**
 * Electron main for the menu-bar item's lifetime probe (issue #71).
 *
 * WHAT IS BEING MEASURED. `livingTrayPort` (src/main/tray-lifetime.ts) makes every method of a
 * destroyed `Tray` a no-op, on the premise that the real item (a) can still be ASKED whether it is
 * destroyed after it has been, and (b) throws from its setters once it is. Neither premise is
 * checkable from a unit fixture: a double answers whatever it was written to answer, so a suite built
 * only from doubles can agree with a wrong premise forever. The engine is the only witness, so this
 * asks it — and it exercises the SHIPPED guard, transpiled from the same source the app builds, not a
 * re-implementation of it that could drift.
 *
 * WHY IT IS SPAWNED RATHER THAN DRIVEN. A status-area item is not in any renderer, so there is no
 * page for an automation channel to attach to; and the thing being provoked is an uncaught
 * MAIN-process exception, which is precisely what a driven session cannot observe from the other end
 * of its own channel. This runs as a plain child process and prints one line of JSON on stdout.
 *
 * FOUR ARMS, because the claim is comparative — a guard that no-ops everything would satisfy the two
 * "no throw" arms on its own:
 *   alive             — the guard's methods reach a live item and actually redraw it
 *   raw-dead          — the UNGUARDED wrapper on a destroyed item: the negative control, and the
 *                       exact shape that shipped. Each of the three setters is tried separately,
 *                       because the crash report only ever named `setTitle`.
 *   guarded-dead      — destroy, THEN the redraw. The reported stack verbatim.
 *   guarded-teardown  — the redraw re-entered from INSIDE `destroy()`, before it returns, which is
 *                       the interleaving a socket line handler can produce during the platform's own
 *                       teardown. A guard placed after the teardown rather than at the seam would
 *                       still miss this one.
 *
 * An `uncaughtException` handler is installed because the failure the guard exists to prevent is the
 * modal dialog Electron raises for an uncaught main-process throw, and a throw that escapes an event
 * handler rather than a try block would otherwise leave no trace in this JSON at all.
 */
import { app, Tray, Menu, nativeImage } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUDGET_MS = Number(process.env.WIGOLO_PROBE_BUDGET_MS || 30000);
const GUARD_MODULE = process.env.WIGOLO_PROBE_GUARD_MODULE;

// Keep the profile out of the repo: the runner is unattended and an in-tree write stops on a prompt.
app.setPath('userData', process.env.WIGOLO_PROBE_USER_DATA || mkdtempSync(join(tmpdir(), 'wigolo-tray-probe-')));
app.disableHardwareAcceleration();

/** Anything reaching here is the uncaught main-process exception the modal dialog is made of. */
const uncaught = [];
process.on('uncaughtException', (err) => uncaught.push(String(err && err.message ? err.message : err)));

const fail = (msg) => {
  process.stderr.write(`tray-lifetime-probe: ${msg}\n`);
  process.exit(3);
};

const timer = setTimeout(() => fail(`budget of ${BUDGET_MS}ms exhausted`), BUDGET_MS);

/** Call it and say what happened — a throw here is the whole question, so it is DATA, not a failure. */
function attempt(fn) {
  try {
    fn();
    return { threw: false, message: null };
  } catch (err) {
    return { threw: true, message: String(err && err.message ? err.message : err) };
  }
}

// A 1×1 template PNG. The icon's appearance is irrelevant here; only that a real item can be created.
const ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAdElEQVR42mNgoBFwYGBg6GdgYNgPxf1QMYJAAKrhPwMDw3skA95DxfZD1eDU/B6KE7DIJyDJYzUEZpMBHhcaILkMw8//cdiMzSX/0cOkH2oyseA9VA+K8/eTYACGeooNoNgLFAcixdFIlYREcVKmSmYiGQAA+cs3RS9qrtQAAAAASUVORK5CYII=',
  'base64',
);

function newTray() {
  const icon = nativeImage.createFromBuffer(ICON, { scaleFactor: 1 });
  icon.setTemplateImage(true);
  return new Tray(icon);
}

/** The wrapper `index.ts` builds around the OS item — the shape that shipped, with no guard on it. */
const rawPort = (item) => ({
  setLabel: (text) => item.setTitle(text),
  setToolTip: (text) => item.setToolTip(text),
  setMenu: (items) => item.setContextMenu(Menu.buildFromTemplate(items)),
  destroy: () => item.destroy(),
});

const MENU = [{ label: 'No runs', enabled: false }];

function armAlive(livingTrayPort) {
  const item = newTray();
  const port = livingTrayPort(item, rawPort(item));
  const calls = {
    setLabel: attempt(() => port.setLabel('3')),
    setToolTip: attempt(() => port.setToolTip('wigolo studio — 3 runs')),
    setMenu: attempt(() => port.setMenu(MENU)),
  };
  const observed = { isDestroyed: item.isDestroyed(), title: item.getTitle ? item.getTitle() : null };
  item.destroy();
  return { arm: 'alive', calls, observed };
}

function armRawDead() {
  const item = newTray();
  const port = rawPort(item);
  item.destroy();
  return {
    arm: 'raw-dead',
    lifetimeRead: attempt(() => item.isDestroyed()),
    isDestroyed: item.isDestroyed(),
    calls: {
      setLabel: attempt(() => port.setLabel('1')),
      setToolTip: attempt(() => port.setToolTip('x')),
      setMenu: attempt(() => port.setMenu(MENU)),
      destroyAgain: attempt(() => port.destroy()),
    },
  };
}

function armGuardedDead(livingTrayPort) {
  const item = newTray();
  const port = livingTrayPort(item, rawPort(item));
  item.destroy();
  return {
    arm: 'guarded-dead',
    calls: {
      setLabel: attempt(() => port.setLabel('1')),
      setToolTip: attempt(() => port.setToolTip('x')),
      setMenu: attempt(() => port.setMenu(MENU)),
      destroyAgain: attempt(() => port.destroy()),
    },
  };
}

/**
 * The redraw re-entered from inside the teardown. `port.destroy()` is what the app calls; the nested
 * redraw runs after the native item is gone and before that call has returned.
 */
function armGuardedTeardown(livingTrayPort) {
  const item = newTray();
  const nested = [];
  const port = livingTrayPort(item, {
    ...rawPort(item),
    destroy: () => {
      item.destroy();
      nested.push(attempt(() => port.setLabel('2')));
      nested.push(attempt(() => port.setMenu(MENU)));
    },
  });
  const outer = attempt(() => port.destroy());
  return { arm: 'guarded-teardown', outer, nested };
}

app.whenReady().then(async () => {
  if (!GUARD_MODULE) fail('WIGOLO_PROBE_GUARD_MODULE was not set — there is no shipped guard to measure');
  const { livingTrayPort } = await import(GUARD_MODULE);
  if (typeof livingTrayPort !== 'function') fail('the transpiled guard module exports no livingTrayPort');

  const arms = {};
  for (const run of [() => armAlive(livingTrayPort), armRawDead, () => armGuardedDead(livingTrayPort), () => armGuardedTeardown(livingTrayPort)]) {
    const r = run();
    arms[r.arm] = r;
  }
  // Let an asynchronous uncaught exception from any arm land before the verdict is printed.
  await new Promise((resolve) => setTimeout(resolve, 500));
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify({ electron: process.versions.electron, arms, uncaught })}\n`);
  app.exit(0);
});
