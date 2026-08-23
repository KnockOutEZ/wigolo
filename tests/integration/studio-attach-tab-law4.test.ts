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
  function bindStore() {
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

  it('still treats the owner re-attaching as a no-op, and never serialises one tab behind another', async () => {
    const vm = new RunViewModel(bindStore());
    const run = await vm.createRun({ task: 'read the docs' });

    await Promise.all([vm.attachTab(run.id, 'tab-a'), vm.attachTab(run.id, 'tab-b')]);
    await vm.attachTab(run.id, 'tab-a');

    const attaches = eventsSince(db, run.id, 0).filter((e) => e.type === 'tab.attached');
    expect(attaches.map((e) => e.payload.tabId), 're-attaching the owner wrote a duplicate fact').toEqual(['tab-a', 'tab-b']);
    expect(vm.tabsOf(run.id)).toEqual(['tab-a', 'tab-b']);
  });
});
