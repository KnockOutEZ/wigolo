/**
 * How a broker child is stopped — one mechanism, every platform.
 *
 * The broker's graceful door is `process.exit(0)`, because that is what fires the `exit` hook that
 * drains the queued `events.jsonl` tail (`drainRunProjectionsOnExit` in `run-store.ts`). Law 11 says
 * the run is readable on disk without our tooling, so a quit that skips that hook silently truncates
 * the human-readable log.
 *
 * A signal cannot carry that on Windows: `child.kill('SIGTERM')` there is a `TerminateProcess`, so
 * the broker's `process.on('SIGTERM')` handler never runs, `process.exit(0)` never fires, and the
 * tail dies in the queue. Nothing about that is fixable inside the handler — the process is gone
 * before any JavaScript observes the signal.
 *
 * Ending the child's stdin is the door that works everywhere: EOF on a pipe is delivered on POSIX and
 * on Windows alike, and the broker turns it into an ordinary in-process `readline` `close` event that
 * reaches the same `process.exit(0)`. So stop = end stdin, wait a bounded time for `exit`, and only
 * then escalate to a kill. There is no per-platform branch — the POSIX signal handlers stay purely as
 * no-orphan insurance for a signal somebody ELSE sends us, never as our own stop path.
 */
import type { ChildProcess } from 'node:child_process';

/**
 * How long the graceful door gets before the kill. The exit drain is synchronous file I/O behind an
 * in-process event, so a healthy broker is gone in milliseconds and the only thing that can eat this
 * budget is a machine under real load — killing a broker that was about to land its tail is the exact
 * failure this module exists to remove.
 *
 * Sized against the app's quit, not in the abstract. `before-quit` bounds the whole shutdown at 10s
 * and a healthy quit already costs ~4.15s of that, so this budget plus {@link BROKER_KILL_REAP_MS}
 * has to leave the wedged-broker case comfortably inside it. Otherwise a broker that stops answering
 * would push the quit past its deadline and cost the app the teardown that runs AFTER the stop.
 */
export const BROKER_STOP_GRACE_MS = 3_000;

/**
 * How long to wait for the corpse after the escalation. A SIGKILLed process is reaped promptly or not
 * at all, so this is a reap window rather than a second grace period — spending the full grace again
 * here would double the wedged-broker cost for nothing.
 */
export const BROKER_KILL_REAP_MS = 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the parent's loop open on our own escalation timer.
    timer.unref?.();
  });

/**
 * Stop a broker child gracefully, resolving once it is actually gone (or once the escalation has been
 * sent and given its own grace period). Safe to call on an already-dead or never-started child.
 */
export async function stopBrokerChild(
  child: ChildProcess | null | undefined,
  graceMs: number = BROKER_STOP_GRACE_MS,
): Promise<void> {
  if (!child) return;
  // Already reaped: `exit` has fired and will not fire again, so waiting on it would burn the full
  // grace period and then SIGKILL a pid we no longer own.
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
  try {
    child.stdin?.end();
  } catch {
    // The pipe was already destroyed — the child either saw its EOF or is beyond talking to. Either
    // way the escalation below settles it.
  }

  if (await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)])) return;

  // The graceful door did not land. SIGKILL, not SIGTERM: SIGTERM is the door we just found closed on
  // Windows, and on POSIX it would only re-enter the handler this child has evidently stopped serving.
  try { child.kill('SIGKILL'); } catch { /* raced its own exit */ }
  await Promise.race([exited, sleep(BROKER_KILL_REAP_MS)]);
}
