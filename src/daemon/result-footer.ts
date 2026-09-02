/**
 * The §4.4 footer's PROJECTION — where the numbers on every studio result come from (#56).
 *
 * `studio-footer.ts` renders; this reads. The split is the point: the renderer is loadable in the
 * Electron main (better-sqlite3 cannot load there), and everything that touches the run log lives
 * here, behind the `FooterSource` seam `DaemonHttpServer.setStudioHost` installs — the same moment,
 * and for the same reason, as the baton gate and the delivery hooks. Only the live host process can
 * read the log, so only it can source a footer.
 *
 * NO BOOKKEEPING (the #56 acceptance criterion, and law 1). Every field is a fold over the append-only
 * log and nothing else:
 *
 *   run · driver · tab   → the `Run` projection (the store port's `get`)
 *   approval             → the run's oldest unanswered, unexpired `PendingDecision`
 *   cost                 → the run's aggregated `cost.recorded` rows
 *   human msgs           → the `message.delivered` rows THIS call appended (seq > the head at entry)
 *   page changed         → the newest of {`snapshot.invalidated`, `snapshot.read`} being the former
 *   assertion failed     → the newest of {`assertion.failed`, `assertion.cleared`} being the former
 *
 * There is no counter, no cache and no map here. Two calls that see the same log render the same
 * footer, and a replay of the log reproduces both.
 *
 * WHY `snapshot.read` EXISTS. §4.2 words the condition as "an invalidation newer than the driver's
 * last read", and a log with no read row cannot answer that question — it can only answer "was there
 * ever an invalidation", which never clears and would nail `page changed: yes` to every subsequent
 * result. So the driver's re-read is recorded, and recorded ONLY when there is a pending
 * invalidation to clear: the row is written at most once per invalidation, never once per call, so
 * an agent that observes in a loop on an untouched page writes nothing at all. It mirrors
 * `HeldSnapshot.hold()` session-side (§5: "the agent re-reading the page is exactly what makes
 * re-read satisfied") — one rule, two places it has to be true, the log being the durable one.
 */
import type { Actor, ClientInfo, Run } from '../studio/run-store.js';
import { formatDriver, actorFor } from './driver-baton.js';
import { MESSAGE_DELIVERED, MAX_MESSAGES_PER_RESULT } from './message-queue.js';
import { currentClientProfile } from './capability-handshake.js';
import { resolveDispatchStore, type DispatchStoreOptions } from './dispatch-store.js';
import type { RunsStore } from './rest/runs-store.js';
import type { FooterContext, FooterSource, McpToolResult } from './studio-dispatch.js';
import type { FooterFields } from './studio-footer.js';
import { createLogger } from '../logger.js';

const log = createLogger('studio');

/**
 * Written by the perception layer's invalidation seam (`snapshotInvalidatedEvent`,
 * `src/studio/perception/held-snapshot.ts`). Named here rather than imported because that module is
 * the app-facing producer and this is the daemon-side reader; the string is the contract between
 * them, exactly as `message.delivered` is between the queue and this file.
 */
export const SNAPSHOT_INVALIDATED = 'snapshot.invalidated';

/** The driver's re-read — see the file header for why the log needs a row for it. */
export const SNAPSHOT_READ = 'snapshot.read';

/**
 * The reserved SD6 slot. §4.2 fixes the grammar now so that adding site-profile assertions later is
 * a producer change and not a footer change; nothing writes these rows yet, so the line never
 * renders today, which is the honest state — never a fabricated verdict.
 */
export const ASSERTION_FAILED = 'assertion.failed';
export const ASSERTION_CLEARED = 'assertion.cleared';

/** The read verb. Re-reading the page is what satisfies "re-read"; nothing else clears the line. */
const READ_TOOL = 'studio_observe';

export interface FooterSourceOptions extends DispatchStoreOptions {
  /**
   * Which run this call is about. The optional `run_id` argument is the only run handle available at
   * the tool boundary today — deliberately unadvertised, so it costs no description budget. `#217`
   * moves this, the baton's and the queue's copy together onto the connection's attachment.
   */
  runIdFor?: (name: string, args: Record<string, unknown>) => string | undefined;
  /** Who is calling. Defaults to the MCP handshake badge, scoped over the dispatch. */
  caller?: () => ClientInfo | undefined;
}

function runIdFromArgs(_name: string, args: Record<string, unknown>): string | undefined {
  const raw = args.run_id ?? args.runId;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/**
 * The newest row of a small competing set, or `undefined` when the run has none of them.
 *
 * A binding with no typed read answers `undefined` for every set, which switches OFF the two
 * conditional lines it feeds rather than guessing at them: `page changed` and `assertion failed`
 * are absent, and the run-bearing lines the run projection alone can answer still render. That is
 * the degradation the port documents — a footer missing a field, never a fabricated one.
 */
async function newestOf(store: RunsStore, runId: string, types: readonly string[]): Promise<{ type: string; payload: Record<string, unknown> } | undefined> {
  const [row] = (await store.typedEvents?.(runId, { types, limit: 1, newestFirst: true })) ?? [];
  return row ? { type: row.type, payload: row.payload } : undefined;
}

/**
 * Messages this result carries. Bounded by the same cap the queue delivers under, so the newest
 * page is the whole answer: a call cannot have delivered more than `MAX_MESSAGES_PER_RESULT`.
 */
async function deliveredOnThisCall(store: RunsStore, runId: string, sinceSeq: number): Promise<number> {
  const rows = (await store.typedEvents?.(runId, { types: [MESSAGE_DELIVERED], limit: MAX_MESSAGES_PER_RESULT, newestFirst: true })) ?? [];
  return rows.filter((row) => row.seq > sinceSeq).length;
}

async function fieldsFor(store: RunsStore, run: Run, sinceSeq: number): Promise<FooterFields> {
  const snapshot = await newestOf(store, run.id, [SNAPSHOT_INVALIDATED, SNAPSHOT_READ]);
  const assertion = await newestOf(store, run.id, [ASSERTION_FAILED, ASSERTION_CLEARED]);
  const which = assertion?.type === ASSERTION_FAILED ? assertion.payload.which : undefined;
  const approval = run.pendingDecisions[0]?.prompt;
  return {
    runId: run.id,
    driverName: formatDriver(run.driver),
    tabs: run.tabIds.length,
    humanMessages: await deliveredOnThisCall(store, run.id, sinceSeq),
    pageChanged: snapshot?.type === SNAPSHOT_INVALIDATED,
    ...(approval ? { approval } : {}),
    ...(typeof which === 'string' && which.trim() ? { assertionFailed: which } : {}),
    spendUsd: run.cost.spendUsd,
    browserActions: run.cost.browserActions,
  };
}

/**
 * Record the driver's re-read, so the next result stops saying the page changed. Appended AFTER the
 * footer is rendered — the result that announces the change must still carry the line — and only
 * when there is something to clear, so the log grows once per human edit rather than once per call.
 */
async function recordRead(store: RunsStore, run: Run, name: string, result: McpToolResult, caller: ClientInfo | undefined): Promise<void> {
  if (name !== READ_TOOL || result.isError) return;
  // A binding with no append cannot record the re-read, so it also never announced a change it
  // could clear: the invalidation row it would be clearing is written through this same seam.
  if (!store.appendEvent) return;
  if ((await newestOf(store, run.id, [SNAPSHOT_INVALIDATED, SNAPSHOT_READ]))?.type !== SNAPSHOT_INVALIDATED) return;
  const actor: Actor = caller ? { ...actorFor(run.driver), client: caller } : actorFor(run.driver);
  await store.appendEvent(run.id, { actor, type: SNAPSHOT_READ, payload: {} });
}

/**
 * Build the footer's data source. Never throws: `dispatchStudioTool` degrades a failed projection to
 * `— no run —` rather than failing the call, and a decoration that could fail a tool call would be
 * a worse surface than the one that had no footer at all.
 */
export function createFooterSource(options: FooterSourceOptions = {}): FooterSource {
  const openStore = resolveDispatchStore(options);
  const runIdFor = options.runIdFor ?? runIdFromArgs;
  const caller = options.caller ?? (() => currentClientProfile().client);

  return {
    async begin(name, args): Promise<FooterContext | undefined> {
      const runId = runIdFor(name, args);
      if (!runId) return undefined;
      const store = await openStore();
      if (!store) return undefined;
      const entry = await store.get(runId);
      if (!entry) return undefined;
      // The head at ENTRY. Everything the call itself appends — the act's browser action, the
      // queue's deliveries — is what sits above this mark when the footer is rendered.
      const sinceSeq = entry.lastSeq;
      const who = caller();
      return {
        runId: entry.id,
        async fields(): Promise<FooterFields> {
          const run = (await store.get(entry.id)) ?? entry;
          return fieldsFor(store, run, sinceSeq);
        },
        async settle(result: McpToolResult): Promise<void> {
          try {
            await recordRead(store, (await store.get(entry.id)) ?? entry, name, result, who);
          } catch (err) {
            log.warn('could not record the driver re-read; page-changed stays announced', { run: entry.id, error: String(err) });
          }
        },
      };
    },
  };
}
