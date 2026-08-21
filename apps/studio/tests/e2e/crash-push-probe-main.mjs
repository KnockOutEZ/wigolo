/**
 * Electron main for the destroyed-guard crash-path probe (issue #67).
 *
 * WHAT IS BEING MEASURED. `stateBroadcaster` (src/main/ipc-host.ts) guards its state push with
 * `win.isDestroyed() || win.webContents.isDestroyed()`. Its comment claimed that check also covered a
 * CRASHED render process. In Electron a crashed webContents is not destroyed — `isCrashed()` and
 * `render-process-gone` exist precisely because the object survives the renderer for reload — so on
 * the crash path the guard evaluates false and the send is attempted anyway. Whether that send throws
 * decides whether the comment was merely wrong or the #394 uncaught-main-exception hang class is
 * still live behind it. Neither answer is derivable from the docs; only the real browser engine knows.
 *
 * WHY IT IS SPAWNED RATHER THAN DRIVEN. `forcefullyCrashRenderer()` kills the render process this
 * app's own automation would be talking through. A Playwright-attached run would lose its connection
 * at the exact moment the measurement starts and report a harness failure instead of a verdict, so
 * this runs as a plain child process and prints its result as one line of JSON on stdout.
 *
 * THREE ARMS, because the claim under test is comparative — the comment lumped three lifetimes
 * together and the code only ever handled two:
 *   crash       — renderer killed with `forcefullyCrashRenderer()`, window and contents both alive
 *   close       — `webContents.close()`, the shape the existing unit fixture already models
 *   windestroy  — `win.destroy()`, where the PROPERTY ACCESS is what throws
 *
 * Every arm records the guard's own inputs (`win.isDestroyed`, `wc.isDestroyed`, `wc.isCrashed`)
 * alongside the observed send outcome, so the JSON says both what the guard would decide and what
 * actually happens when it decides to proceed. An `uncaughtException` handler is installed because
 * the failure this whole guard exists to prevent is asynchronous and uncaught, not a rejected promise.
 */
import { app, BrowserWindow } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUDGET_MS = Number(process.env.WIGOLO_PROBE_BUDGET_MS || 30000);
const PAGE = 'data:text/html,<html><body>probe</body></html>';

// Keep the profile out of the repo: the runner is unattended and an in-tree write stops on a prompt.
app.setPath('userData', process.env.WIGOLO_PROBE_USER_DATA || mkdtempSync(join(tmpdir(), 'wigolo-crash-probe-')));
app.disableHardwareAcceleration();

/** Anything reaching here is the uncaught main-process exception the guard exists to prevent. */
const uncaught = [];
process.on('uncaughtException', (err) => uncaught.push(String(err && err.message ? err.message : err)));

const fail = (msg) => {
  process.stderr.write(`crash-push-probe: ${msg}\n`);
  process.exit(3);
};

const timer = setTimeout(() => fail(`budget of ${BUDGET_MS}ms exhausted`), BUDGET_MS);

function newWindow() {
  return new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: false },
  });
}

/** Call it and say what happened — a throw here is the whole question, so it is DATA, not a failure. */
function attemptSend(fn) {
  try {
    fn();
    return { threw: false, message: null };
  } catch (err) {
    return { threw: true, message: String(err && err.message ? err.message : err) };
  }
}

/** Guard inputs read defensively: on the windestroy arm the read itself is what throws. */
function readFlags(win) {
  const flags = { winDestroyed: null, wcDestroyed: null, wcCrashed: null, readThrew: false, readMessage: null };
  try {
    flags.winDestroyed = win.isDestroyed();
    const wc = win.webContents;
    flags.wcDestroyed = wc.isDestroyed();
    flags.wcCrashed = wc.isDestroyed() ? null : wc.isCrashed();
  } catch (err) {
    flags.readThrew = true;
    flags.readMessage = String(err && err.message ? err.message : err);
  }
  return flags;
}

/** What the SHIPPED guard would decide from those flags — recorded, not re-derived by the reader. */
function guardWouldSkip(flags) {
  if (flags.winDestroyed === true) return true;
  return flags.wcDestroyed === true;
}

async function armCrash() {
  const win = newWindow();
  await win.webContents.loadURL(PAGE);
  const wc = win.webContents;
  const gone = new Promise((resolve) => wc.once('render-process-gone', (_e, details) => resolve(details)));
  wc.forcefullyCrashRenderer();
  const details = await gone;
  const flags = readFlags(win);
  const send = attemptSend(() => wc.send('wigolo:state-changed', { sessionName: 's', tabs: [] }));
  return { arm: 'crash', gone: { reason: details.reason, exitCode: details.exitCode }, flags, guardWouldSkip: guardWouldSkip(flags), send };
}

async function armClose() {
  const win = newWindow();
  await win.webContents.loadURL(PAGE);
  const wc = win.webContents;
  const destroyed = new Promise((resolve) => wc.once('destroyed', () => resolve(true)));
  wc.close();
  await destroyed;
  const flags = readFlags(win);
  const send = attemptSend(() => wc.send('wigolo:state-changed', { sessionName: 's', tabs: [] }));
  return { arm: 'close', flags, guardWouldSkip: guardWouldSkip(flags), send };
}

async function armWindowDestroy() {
  const win = newWindow();
  await win.webContents.loadURL(PAGE);
  win.destroy();
  const flags = readFlags(win);
  // The unguarded shape: reach for `.webContents` on a dead window, which is the access that throws.
  const send = attemptSend(() => win.webContents.send('wigolo:state-changed', { sessionName: 's', tabs: [] }));
  return { arm: 'windestroy', flags, guardWouldSkip: guardWouldSkip(flags), send };
}

app.whenReady().then(async () => {
  const arms = {};
  for (const run of [armCrash, armClose, armWindowDestroy]) {
    const r = await run();
    arms[r.arm] = r;
  }
  // Let an asynchronous uncaught exception from any send land before the verdict is printed.
  await new Promise((resolve) => setTimeout(resolve, 500));
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, arms, uncaught })}\n`);
  app.exit(0);
});
