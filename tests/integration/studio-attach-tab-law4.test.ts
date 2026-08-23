import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { resetConfig } from '../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../src/cache/db.js';
import {
  appendEvent,
  createRun,
  eventsSince,
  getRun,
  listRuns,
  type CreateRunInput,
  type ListRunsOptions,
  type Run,
  type RunEvent,
  type RunEventInput,
} from '../../src/studio/run-store.js';

/**
 * The app's main-process module, loaded through a COMPUTED specifier.
 *
 * `apps/studio` is a Bundler-resolution project: its relative imports carry no extension and its
 * `wigolo/studio` specifier resolves through the BUILT package. Naming it in a static import here
 * would pull it into the root type-check program, which resolves as nodenext — and the type-gate
 * CI job deliberately does not build, so `wigolo/studio` would not resolve there and this arm would
 * fail a gate it has nothing to do with. The runtime import is the same module the app loads; what
 * the computed specifier costs is the static type, which the two shapes below restore at the seam
 * this arm actually drives.
 */
interface RunViewModelLike {
  createRun(input: CreateRunInput): Promise<Run>;
  attachTab(runId: string, tabId: string, url?: string): Promise<void>;
  detachTab(tabId: string, reason: 'closed' | 'run_ended'): Promise<void>;
  endRun(runId: string, terminal: 'completed' | 'failed' | 'cancelled', detail?: string): Promise<void>;
  ownerOf(tabId: string): string | undefined;
  tabsOf(runId: string): string[];
}
interface TabOwnedErrorLike extends Error { readonly tabId: string; readonly ownerRunId: string }
const { RunViewModel, TabOwnedError } = (await import(
  new URL('../../apps/studio/src/main/run-view-model.ts', import.meta.url).href
)) as {
  RunViewModel: new (store: unknown) => RunViewModelLike;
  TabOwnedError: new (tabId: string, ownerRunId: string) => TabOwnedErrorLike;
};

/** A latch a test can hold an append on, and open when the race it is staging is set up. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = () => { resolve(); }; });
  return { wait, release };
}

/** A losing arm for `Promise.race` — never the reason the process stays alive. */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const handle = setTimeout(() => { resolve(value); }, ms);
    handle.unref?.();
  });
}

/**
 * Law 4 — "a tab belongs to exactly one run" — where the only place it can actually be checked is:
 * the durable log.
 *
 * The app's refusal is a check-then-act across an await. `ownerOf` is answered from the in-process
 * projection and the append is a round-trip to the store, so two attaches of one tab issued in the
 * same turn both read "nobody owns it" and both commit. The log is append-only: what lands there
 * lands there, nothing detects the pair afterwards, and every surface that replays it — this app,
 * REST, a replay, the audit — reads one tab owned by two runs. An agent then drives another agent's
 * page.
 *
 * The app's unit suite cannot see this. It binds an in-memory fake whose append commits
 * synchronously, which closes the window by accident. So the arm lives here, against the store the
 * daemon actually writes, reached through the same port the app binds — and it asserts on
 * `eventsSince`, the store's own read, not on the projection that was fooled in the first place.
 */
describe('law 4 at the durable log — two runs racing for one tab', () => {
  let dataDir: string;
  let db: Database.Database;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = process.env;
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-attach-law4-'));
    process.env = { ...originalEnv, LOG_LEVEL: 'error', WIGOLO_DATA_DIR: dataDir };
    resetConfig();
    initDatabase(':memory:');
    db = getDatabase();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * The real store behind the app's port.
   *
   * The two things this reproduces from the broker client, because the race is made of them: the
   * append is a ROUND-TRIP — it crosses a pipe before the child commits, so a caller that has asked
   * for one has not yet changed anything — and the store fans a committed envelope out to the live
   * tail BEFORE the call that caused it resolves.
   */
  /**
   * `park` holds an append on the wire for as long as the test wants, which is what turns a race that
   * needs a slow broker into a deterministic one. Returning `undefined` lets the append through.
   */
  type Park = (runId: string, event: RunEventInput) => Promise<void> | undefined;

  function bindStore(park?: Park) {
    const handlers: Array<(runId: string, event: RunEvent) => void> = [];
    const fan = (runId: string, event: RunEvent): void => { for (const h of handlers) h(runId, event); };
    return {
      async createRun(input: CreateRunInput) {
        const run = createRun(db, input, { dataDir });
        for (const event of eventsSince(db, run.id, 0)) fan(run.id, event);
        return run;
      },
      async appendEvent(runId: string, event: RunEventInput) {
        await Promise.resolve();
        await park?.(runId, event);
        const committed = appendEvent(db, runId, event, { dataDir });
        fan(runId, committed);
        return committed;
      },
      async getRun(runId: string) { return getRun(db, runId); },
      async listRuns(opts: ListRunsOptions = {}) { return listRuns(db, opts); },
      async eventsSince(runId: string, since: number, limit: number) { return eventsSince(db, runId, since, limit); },
      onRunEvent(handler: (runId: string, event: RunEvent) => void) { handlers.push(handler); },
    };
  }

  /** Who the STORE says owns this tab — every run that ever committed an attach for it. */
  const ownersInLog = (runIds: string[], tabId: string): string[] =>
    runIds.filter((id) => eventsSince(db, id, 0).some((e) => e.type === 'tab.attached' && e.payload.tabId === tabId));

  it('commits exactly one owner, and refuses the loser rather than stealing the page', async () => {
    const vm = new RunViewModel(bindStore());
    const alpha = await vm.createRun({ task: 'book the flight' });
    const beta = await vm.createRun({ task: 'file the return' });

    // Both issued in the same turn, which is what two drivers reaching for one tab looks like.
    const settled = await Promise.allSettled([
      vm.attachTab(alpha.id, 'tab-contested'),
      vm.attachTab(beta.id, 'tab-contested'),
    ]);

    const winners = [alpha.id, beta.id].filter((_, i) => settled[i]!.status === 'fulfilled');
    const losers = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(winners, 'both attaches were allowed to commit').toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason, 'the loser got something other than the designed refusal').toBeInstanceOf(TabOwnedError);
    expect((losers[0]!.reason as TabOwnedErrorLike).ownerRunId).toBe(winners[0]);

    // The claim that matters is about the LOG, not about this process's answer: a projection can be
    // corrected on the next replay, a committed envelope cannot.
    expect(ownersInLog([alpha.id, beta.id], 'tab-contested'), 'the append-only log records two owners for one tab')
      .toEqual([winners[0]]);
    expect(vm.ownerOf('tab-contested')).toBe(winners[0]);
  });

  it('still treats the owner re-attaching as a no-op', async () => {
    const vm = new RunViewModel(bindStore());
    const run = await vm.createRun({ task: 'read the docs' });

    await Promise.all([vm.attachTab(run.id, 'tab-a'), vm.attachTab(run.id, 'tab-b')]);
    await vm.attachTab(run.id, 'tab-a');

    const attaches = eventsSince(db, run.id, 0).filter((e) => e.type === 'tab.attached');
    expect(attaches.map((e) => e.payload.tabId), 're-attaching the owner wrote a duplicate fact').toEqual(['tab-a', 'tab-b']);
    expect(vm.tabsOf(run.id)).toEqual(['tab-a', 'tab-b']);
  });

  /**
   * The claim the row above cannot make. Two attaches that both succeed prove nothing about WHICH
   * queue they went through: a single global FIFO lock passes that row, and every other arm here,
   * while making one slow broker append block every tab in the app. So the falsifier has to be a tab
   * whose append never lands: under a per-tab queue the other tab is unaffected, under a global one
   * it never resolves.
   */
  it('serialises per TAB, not globally — tab-b lands while tab-a’s append is parked', async () => {
    const held = gate();
    const vm = new RunViewModel(bindStore((_runId, event) =>
      event.type === 'tab.attached' && event.payload?.tabId === 'tab-a' ? held.wait : undefined));
    const run = await vm.createRun({ task: 'read the docs' });

    const slow = vm.attachTab(run.id, 'tab-a');
    const other = vm.attachTab(run.id, 'tab-b');

    expect(
      await Promise.race([other.then(() => 'landed' as const), after(250, 'held' as const)]),
      'tab-b waited on tab-a — the queue is global, so one slow broker append stalls every tab',
    ).toBe('landed');

    held.release();
    await Promise.all([slow, other]);
    expect(vm.tabsOf(run.id)).toEqual(['tab-b', 'tab-a']);
  });

  /**
   * Law 4's other half, and the one the enforcement seam was missing: a tab a run owns has to STOP
   * being owned when it stops existing.
   *
   * `detachTab` read `ownerOf` the moment it was called, off the queue the attach was on. A broker
   * append can take seconds, so the ordinary sequence — agent attaches, human closes the tab before
   * the append lands — found no owner, returned, and let the attach commit behind it. The durable log
   * then says the run owns a destroyed tab, permanently: `agentVisibleTabs` lists it and `promote()`
   * focuses a dead id, and no replay can tell that tab from a live one.
   */
  it('releases a tab the human closed while its attach was still on the wire', async () => {
    const held = gate();
    const vm = new RunViewModel(bindStore((_runId, event) =>
      event.type === 'tab.attached' ? held.wait : undefined));
    const run = await vm.createRun({ task: 'book the flight' });

    const attach = vm.attachTab(run.id, 'tab-slow');
    const detach = vm.detachTab('tab-slow', 'closed'); // the human closed it mid-flight
    held.release();
    await Promise.all([attach, detach]);

    expect(
      eventsSince(db, run.id, 0).filter((e) => e.type.startsWith('tab.')).map((e) => e.type),
      'the log ends with the run still owning a tab that no longer exists',
    ).toEqual(['tab.attached', 'tab.detached']);
    expect(vm.ownerOf('tab-slow')).toBeUndefined();
    expect(vm.tabsOf(run.id)).toEqual([]);
  });

  /**
   * The same read, from the other side. `endRun` releases the run's tabs before it writes the terminal
   * event, and a human closing one of them at that moment is not exotic — ending a run is exactly when
   * a human reaches for its window. Both detaches read the owner before either folded, so the
   * append-only record took two `tab.detached` facts for one detachment, and every later replay counts
   * a release the run never made.
   */
  it('records exactly one tab.detached when a human close races the run ending', async () => {
    const held = gate();
    let parked = false;
    const vm = new RunViewModel(bindStore((_runId, event) => {
      if (event.type !== 'tab.detached' || parked) return undefined;
      parked = true;
      return held.wait;
    }));
    const run = await vm.createRun({ task: 'file the return' });
    await vm.attachTab(run.id, 'tab-shared');

    const byHuman = vm.detachTab('tab-shared', 'closed');
    const ended = vm.endRun(run.id, 'completed');
    held.release();
    await Promise.all([byHuman, ended]);

    const log = eventsSince(db, run.id, 0);
    expect(
      log.filter((e) => e.type === 'tab.detached'),
      'one detachment was written to the append-only log twice',
    ).toHaveLength(1);
    expect(log.map((e) => e.type)).toEqual(['run.created', 'tab.attached', 'tab.detached', 'run.completed']);
  });
});
