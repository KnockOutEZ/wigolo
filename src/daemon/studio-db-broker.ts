/**
 * Studio DB broker — a plain-Node child process that owns the cache DB (better-sqlite3, Node ABI) so
 * the Electron main never loads a native module (spec §13.7 / §13.9). Serves studio persistence +
 * local find_similar over newline-delimited JSON-RPC on stdin/stdout. stderr = logs. It reuses the
 * salvaged capture pipeline + find_similar VERBATIM; the Electron host computes the security-gate inputs
 * (session id, nav-epoch, credential signal) from live session state and passes them per call, so the
 * salvaged handler stays the single source of truth for the gate.
 */
import { createInterface } from 'node:readline';
import type Database from 'better-sqlite3';
import { initSubsystems } from '../server.js';
import { getDatabase } from '../cache/db.js';
import { createLogger } from '../logger.js';
import { createCaptureHandler } from '../studio/capture/handler.js';
import {
  captureFromPage,
  captureHumanNote,
  insertScreenshotArtifact,
  listSessionArtifacts,
  listSessionComments,
  type ArtifactDelta,
  type MarkSelectors,
  type CaptureResult,
} from '../studio/capture/artifacts.js';
import { findSimilar } from '../search/find-similar.js';
import { SessionAuditLog, listSessionAudit, type AuditRecordInput, type AuditDto } from '../studio/audit.js';
import { insertFlowStep, type FlowProjection, type FlowStep } from '../studio/flow/store.js';
import {
  createRun,
  appendEvent,
  getRun,
  runExists,
  listRuns,
  eventsSince,
  resolveRunId,
  type CreateRunInput,
  type ListRunsOptions,
  type ListRunsResult,
  type Run,
  type RunEvent,
  type RunEventInput,
  type StoredRunFacts,
} from '../studio/run-store.js';
import { listSessionArtifactsFull } from '../studio/capture/artifacts.js';
import { artifactsToSources, type ResearchBriefDto } from '../studio/synthesize.js';
import { buildResearchBrief } from '../research/brief.js';
import type { IndexJobInput } from '../embedding/background-queue.js';
import type { FieldSemantics } from '../studio/credential.js';
import type { StudioCaptureInput } from './studio-dispatch.js';
import type { FindSimilarInput } from '../types.js';

const log = createLogger('studio');
type CredSignal = { pageUrl?: string; fields?: FieldSemantics[] };

/**
 * The boot page's event budget — per run, and across the whole page.
 *
 * `runListLogs` answers as ONE newline-delimited stdio frame. The host accumulates that frame as a
 * single JS string and `JSON.parse`s it synchronously on the Electron main thread, which is also the
 * thread that paints — so an unbounded answer is an unbounded stall, and at fifty long-lived runs of
 * tens of thousands of envelopes each it is hundreds of megabytes of stall before the app has drawn
 * anything. There was no cap of any kind and no fallback.
 *
 * The bound is stated in events AND in characters because neither alone bounds a frame: one payload
 * may be up to `MAX_EVENT_PAYLOAD_CHARS` (64k), so a row count is not a size, and a size says nothing
 * about how many rows the page had to move to reach it.
 *
 * Neither is learned by materializing the log. The row count is the listing row's `lastSeq`, and the
 * size is a `SUM(LENGTH(payload))` that under-states the serialized frame by construction — see
 * `storedPayloadChars`. Every read is charged the moment it is made — the estimate itself, and the
 * materialization of a run the estimate cannot rule out — whether or not any envelope ships, so one
 * overrun cannot be repeated by every run behind it.
 *
 * A run past either bound is answered with its PROJECTION instead of its envelopes. That is not a
 * degraded answer: `listRuns` has already computed it by the bounded path, and it is field-for-field
 * the answer REST gives for the same run. The host keeps it exactly the way it keeps a finished
 * run's projection — every read stays correct — and replays the log in bounded pages when the run
 * next speaks.
 *
 * It is NOT "a few hundred bytes", which is what this note used to claim and what let the condensed
 * branch ship uncharged. Two of a projection's fields grow without a count bound of their own — the
 * held-tab list grows with an ordinary run's lifetime, and `pendingDecisions` is windowed by time
 * and never by count with each prompt up to `MAX_EVENT_PAYLOAD_CHARS` — so the condensed answer is
 * charged against the same character budget as a log. Only one of the two may be cut to fit it, and
 * `condenseProjection` says which and why.
 */
export const MAX_BOOT_EVENTS_PER_RUN = 2_000;
export const MAX_BOOT_EVENTS_TOTAL = 20_000;
export const MAX_BOOT_FRAME_CHARS = 4_000_000;

/**
 * How many unresolved decision cards ONE condensed projection may relay.
 *
 * The projection was the budget's unmetered door. `pendingDecisions` is windowed by TIME and never
 * by count — `PENDING_DECISION_SQL` asks for every in-window `decision.requested` a run has not
 * resolved — and each prompt may be `MAX_EVENT_PAYLOAD_CHARS`. So "how many cards can be in the
 * window" is a question about the writer, not about this read, and a run that raises a thousand of
 * them in two minutes produces a projection larger than the host's whole frame bound. Charging the
 * projection bounds the PAGE; a count cap is what bounds a SINGLE run's, which is the case charging
 * alone cannot reach.
 *
 * Twenty because the cards are a boot-screen surface — the panel shows the ones that need you, and
 * a human answers them one at a time. Dropped cards are REPORTED (`projectionOmitted`), never
 * silently lost: the run's log still holds every one of them, and the host replays it in bounded
 * pages when the run next speaks. Reverse this if a surface is ever built that must enumerate every
 * pending card at boot, from the projection, without reading the log.
 */
export const MAX_BOOT_PENDING_CARDS = 20;

/**
 * The ceiling on ONE `runEventsSince` frame, whatever the caller asks for.
 *
 * `limit` is now required — an omitted one used to mean "the whole log", which is how the view-model
 * replayed every gap — but a required parameter only moves the decision to the caller. A frame the
 * host cannot survive must not be reachable FROM a caller at all, so the ceiling is enforced here as
 * well. A client that asks for more gets a short page, which is why the paged reader upstream stops
 * on an EMPTY page rather than on a short one.
 */
export const MAX_EVENTS_PAGE = 2_000;

/**
 * The same ceiling in the unit the frame actually grows in.
 *
 * A count alone bounds the wrong thing — `MAX_BOOT_*` says so above, and `DEFAULT_MAX_HELD_BYTES` in
 * `rest/runs.ts` says it again for the SSE hold buffer — and this read was the one place that had the
 * count and nothing else. One payload may be `MAX_EVENT_PAYLOAD_CHARS` (64k), so a page of 2,000 rows
 * is up to 128M characters: TWICE the host's own `DEFAULT_MAX_FRAME_CHARS` backstop. A legitimate
 * page could therefore be killed as an oversized frame and take the broker down with it, and a replay
 * paging through such a log would restart the child on every page and never finish.
 *
 * Four million, matching `MAX_BOOT_FRAME_CHARS`: the same host, the same thread, the same reason.
 */
export const MAX_EVENTS_PAGE_CHARS = 4_000_000;

/**
 * Prepared-statement cache, keyed by connection.
 *
 * The append path has had one since F1 — see the sibling note in `run-store.ts`, which owns the
 * same map for its own statements and does not export it. Compiling constant SQL per call is a
 * parse, a name resolution and a plan for a statement that never changes, and the reads below are
 * on the hot boot page and the hot gap replay.
 *
 * Keyed by handle because a `Statement` belongs to the connection that compiled it — the broker
 * child, the daemon and every test database must never be handed each other's. A `WeakMap` so a
 * closed connection's statements go with it. Only CONSTANT sql goes through this, and nothing may
 * call `pluck`/`expand`/`safeIntegers` on what it returns: those are sticky modes on a shared
 * object.
 */
const preparedByDb = new WeakMap<Database.Database, Map<string, Database.Statement>>();

function stmt(db: Database.Database, sql: string): Database.Statement {
  let statements = preparedByDb.get(db);
  if (statements === undefined) {
    statements = new Map<string, Database.Statement>();
    preparedByDb.set(db, statements);
  }
  const hit = statements.get(sql);
  if (hit) return hit;
  const prepared = db.prepare(sql);
  statements.set(sql, prepared);
  return prepared;
}

/**
 * `{"seq":`, `,"ts":"…"`, `,"actor":`, `,"type":"…"`, `,"payload":`, `}` — the keys, quotes, commas
 * and braces `JSON.stringify` puts around one envelope's four stored columns. Fixed by the shape of
 * `RunEvent`, so the only per-row variable left is the seq's digit count.
 */
const EVENT_ENVELOPE_CHARS = 46;

const PAGE_MEASURE_SQL =
  'SELECT seq, LENGTH(ts) + LENGTH(actor) + LENGTH(type) + LENGTH(payload) AS chars' +
  '  FROM studio_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?';

/**
 * How many of the next `limit` rows fit the character budget — asked of SQLite, not of the page.
 *
 * ALWAYS at least one when there is one: an empty page is how every paged reader here recognises
 * end-of-log, so a budget that could answer "nothing" would end a replay in the middle of a run
 * rather than bound it. One event cannot approach the frame cap on its own —
 * `MAX_EVENT_PAYLOAD_CHARS` is 64k — so the worst page this admits is the budget plus one event,
 * which is what `tests/integration/studio-broker-frame-budget.test.ts` pins against the host's
 * ceiling.
 *
 * The measure used to be `JSON.stringify` per event over the materialized page, and then `send`
 * serialized the whole frame again — two full serializations of the same characters, 3.29 ms +
 * 1.66 ms on a 733 KB page, on the child's only thread, and a hundred-thousand-event gap replay
 * pays it once per page. `LENGTH()` reads the stored bytes without copying them into a JS string,
 * so the frame is now serialized exactly once, by the transport.
 *
 * Sound in the same direction as `storedPayloadChars`: SQLite's `length()` counts code points where
 * JS `.length` counts UTF-16 units, so an astral character makes this smaller than the truth and
 * never larger, and the payload each row stores is the same JSON text `JSON.stringify` reproduces.
 * A bound that can only UNDER-state admits at most a little more than the old measure did — never
 * a page the old one would have cut short of the budget.
 */
function pageRowsWithinChars(db: Database.Database, runId: string, since: number, limit: number): number {
  const rows = stmt(db, PAGE_MEASURE_SQL).all(runId, since, limit) as Array<{ seq: number; chars: number | null }>;
  let chars = 0;
  for (let i = 0; i < rows.length; i++) {
    chars += (rows[i].chars ?? 0) + EVENT_ENVELOPE_CHARS + String(rows[i].seq).length;
    if (chars > MAX_EVENTS_PAGE_CHARS) return i + 1;
  }
  return rows.length;
}

/** One run's stored facts and the envelopes that project it — what a replay needs, and nothing else. */
export interface BrokerRunLogEntry {
  facts: StoredRunFacts;
  events: RunEvent[];
  /**
   * The run's true tail seq — ALWAYS, never `events.at(-1).seq`.
   *
   * The host rejects a stale envelope, and detects a gap, by comparing `seq` against the highest one
   * it holds. Deriving that from a capped or condensed read would put it below the store's real tail,
   * so the very next live envelope would look like a hole and replay a run that missed nothing —
   * turning a read bound into a replay storm.
   */
  lastSeq: number;
  /** The bounded projection, sent IN PLACE of a log too large for one frame. */
  projection?: Run;
  /**
   * What `projection` had to leave out to stay inside the page's character budget, per field.
   *
   * Present ONLY when something was dropped, so an ordinary condensed entry is byte-for-byte what
   * it was. A truncation the host cannot see is one it cannot replay: the run's log still holds
   * every card, and this is how the host knows to go and get them rather than treat a shortened
   * list as the run's actual state.
   *
   * `pendingDecisions` is the only field that can appear here, and `condenseProjection` says why:
   * `tabIds` is law 4's ownership index and is never cut.
   */
  projectionOmitted?: { pendingDecisions: number };
  /**
   * The daemon studio session this run was born from. Normally the host replays it from the
   * `run.created` envelope; a condensed entry carries no envelopes, and losing it would cost the
   * host `runForSession` — how a studio session finds the run it is driving.
   */
  sessionId?: string;
}

export interface BrokerRunLogPage {
  entries: BrokerRunLogEntry[];
  /** The listing's own cursor, so the host can hydrate PAST the first page. */
  nextCursor?: string;
  /**
   * What this page's READS cost, accumulated over every run it materialized — including the ones it
   * then condensed and shipped as projections.
   *
   * The page's allowance is a LOCAL of the call, so a host that pages is handed a fresh one per page
   * and the only bound it can carry across the hydration is one it computes from what came BACK. What
   * came back is `events`, and a condensed entry's `events` is empty — so a page of condensed runs
   * looked free from up there while costing the child a full `eventsSince` + `JSON.stringify` per run
   * here. The host charged zero, kept asking for envelopes, and multiplied this call's budget by its
   * page cap.
   *
   * Reporting the READ rather than the answer is the same rule as the charge at the read site, for the
   * same reason: the cost is paid at materialization, and a caller that can only see the acceptance
   * cannot bound the work. Both dimensions travel, because neither alone bounds a frame — see
   * `MAX_BOOT_*`.
   *
   * `charsSpent` also carries what a condensed entry SHIPS. A projection is not a read, but it is
   * characters in the same frame, and it was the one door in this call that nothing metered.
   */
  eventsSpent: number;
  charsSpent: number;
}

/**
 * A run's stored payload characters, summed in SQL — a strict LOWER bound on what its log serializes
 * to, so `storedPayloadChars(run) > charsLeft` PROVES the log cannot fit without materializing it.
 *
 * Sound because every stored payload string appears verbatim inside `JSON.stringify(events)`, which
 * additionally carries `seq`, `ts`, `actor`, `type`, the keys, the braces and the commas. SQLite's
 * `length()` counts code points where JS `.length` counts UTF-16 units, so an astral character makes
 * this estimate smaller still — never larger. A bound that can only UNDER-state means no run that
 * would have fit is ever condensed by it: the accepted path is decided by exactly the check it was
 * decided by before, on exactly the same characters.
 *
 * The point is what it does NOT do. The materializing check reads up to two thousand rows, parses
 * every payload into an object and re-serializes the array; this reads one aggregate and allocates
 * one number. Cheaper is not free: it scans every payload byte the run has, so the caller charges
 * this answer to the page's character budget BEFORE deciding on it. Both paths out of the probe are
 * then bounded by `MAX_BOOT_FRAME_CHARS` — the run it rejects as much as the one it lets through.
 */
function storedPayloadChars(db: Database.Database, runId: string): number {
  const row = stmt(db, 'SELECT SUM(LENGTH(payload)) AS chars FROM studio_run_events WHERE run_id = ?')
    .get(runId) as { chars: number | null } | undefined;
  return row?.chars ?? 0;
}

/** A condensed entry's projection, already cut to what the page can afford, and what that cost. */
interface CondensedProjection {
  projection: Run;
  chars: number;
  omitted?: { pendingDecisions: number };
}

/**
 * The projection a condensed entry may ship, given what the page has left.
 *
 * Two cuts, in order, and BOTH of them only ever touch `pendingDecisions`. The count cap is
 * unconditional — it bounds ONE run's projection, which is the case the page-wide charge cannot
 * reach, because the first run of a page is offered the whole budget and a single hostile card list
 * exceeds the host's own frame bound on its own. Dropping the cards entirely is the fallback for a
 * run that still does not fit what the page has left.
 *
 * `tabIds` is NEVER cut, however large it grows. The host rebuilds law 4's tab→run index by seeding
 * `tab.attached` from exactly this array (`run-view-model.ts`'s `keptSeed`), so a projection that
 * under-reports a run's held tabs does not shrink an answer — it tells the app those tabs belong to
 * nobody, and the next run to ask for one is not refused. A read bound may not manufacture a chance
 * for two runs to hold the same tab. What bounds it instead is the charge: a large tab list spends
 * the page's budget and the runs behind it condense harder, and past that the host's own
 * `DEFAULT_MAX_FRAME_CHARS` stays the last line of defence, which is where `#132` left it.
 *
 * Cards can go because nothing downstream infers ownership from them: the run's `status` carries
 * `needs_you` on its own, the cards are re-read from the log the moment the run speaks, and the
 * count of what was dropped travels with the entry — empty plus a stated number, never a short list
 * presented as the whole one.
 */
function condenseProjection(run: Run, charsLeft: number): CondensedProjection {
  const dropped = Math.max(0, run.pendingDecisions.length - MAX_BOOT_PENDING_CARDS);
  const capped = dropped === 0 ? run : { ...run, pendingDecisions: run.pendingDecisions.slice(0, MAX_BOOT_PENDING_CARDS) };
  const chars = JSON.stringify(capped).length;
  if (chars <= charsLeft) {
    return { projection: capped, chars, ...(dropped ? { omitted: { pendingDecisions: dropped } } : {}) };
  }
  const cardless: Run = { ...run, pendingDecisions: [] };
  return {
    projection: cardless,
    chars: JSON.stringify(cardless).length,
    omitted: { pendingDecisions: run.pendingDecisions.length },
  };
}

/** The session link, as one row. Only read when the entry has no envelopes to replay it from. */
function sessionLinkOf(db: Database.Database, runId: string): { sessionId?: string } {
  const [created] = eventsSince(db, runId, 0, 1);
  const sessionId = created?.type === 'run.created' ? created.payload.sessionId : undefined;
  return typeof sessionId === 'string' ? { sessionId } : {};
}

export interface BrokerCaptureParams {
  input: StudioCaptureInput;
  sessionId: string;
  currentNavEpoch: number;
  lastObserveEpoch: number;
  credentialSignal: CredSignal;
}
export interface BrokerHandlerDeps {
  db: Database.Database;
  engines: Parameters<typeof findSimilar>[1];
  router: Parameters<typeof findSimilar>[2];
  backendStatus?: Parameters<typeof findSimilar>[3];
  /** Embed-job sink. Injected in tests; production leaves it undefined → the shared background queue. */
  enqueue?: (job: IndexJobInput) => unknown;
  onArtifact: (delta: ArtifactDelta) => void;
  /** Live tail for the run log. Fires after the append commits, never inside the transaction. */
  onRunEvent?: (runId: string, event: RunEvent) => void;
}

/** Pure dispatch map — unit-testable without a process. */
export function createBrokerHandlers(deps: BrokerHandlerDeps) {
  return {
    ping: async (): Promise<'pong'> => 'pong',
    capture: async (p: BrokerCaptureParams) => {
      const handler = createCaptureHandler({
        sessionId: p.sessionId,
        db: deps.db,
        enqueue: deps.enqueue,
        credentialContext: async () => p.credentialSignal,
        currentNavEpoch: () => p.currentNavEpoch,
        lastObserveEpoch: () => p.lastObserveEpoch,
        onArtifact: deps.onArtifact,
      });
      return handler(p.input);
    },
    persistSessionFetch: async (p: { sessionId: string; url: string; title: string; markdown: string; credentialSignal: CredSignal }): Promise<CaptureResult> =>
      captureFromPage(
        { type: 'clip', sessionId: p.sessionId, url: p.url, title: p.title, markdown: p.markdown },
        { db: deps.db, enqueue: deps.enqueue, credentialContext: p.credentialSignal, onArtifact: deps.onArtifact },
      ),
    persistMark: async (p: { sessionId: string; url: string; target: MarkSelectors; credentialSignal: CredSignal }): Promise<CaptureResult> =>
      captureFromPage(
        { type: 'mark', sessionId: p.sessionId, url: p.url, target: p.target },
        { db: deps.db, enqueue: deps.enqueue, credentialContext: p.credentialSignal, onArtifact: deps.onArtifact },
      ),
    // P6 F1 grab-all — persist generalized structured rows as a type=extraction artifact. Same credential
    // choke as every other persist path (belt-and-suspenders: host refuses at entry, broker refuses again).
    persistExtraction: async (p: { sessionId: string; url: string; columns: string[]; rows: Record<string, string>[]; credentialSignal: CredSignal }): Promise<CaptureResult> =>
      captureFromPage(
        { type: 'extraction', sessionId: p.sessionId, url: p.url, columns: p.columns, rows: p.rows },
        { db: deps.db, enqueue: deps.enqueue, credentialContext: p.credentialSignal, onArtifact: deps.onArtifact },
      ),
    persistComment: async (p: { sessionId: string; text: string }): Promise<CaptureResult> =>
      captureHumanNote({ sessionId: p.sessionId, text: p.text }, { db: deps.db, enqueue: deps.enqueue }),
    persistScreenshot: async (p: { sessionId: string; url: string; title: string; mediaPath: string; contentHash: string; credentialSignal: CredSignal }): Promise<CaptureResult> =>
      insertScreenshotArtifact(
        { sessionId: p.sessionId, url: p.url, title: p.title, mediaPath: p.mediaPath, contentHash: p.contentHash },
        { db: deps.db, enqueue: deps.enqueue, credentialContext: p.credentialSignal, onArtifact: deps.onArtifact },
      ),
    listArtifacts: async (p: { sessionId: string; limit: number }): Promise<ArtifactDelta[]> =>
      listSessionArtifacts(deps.db, p.sessionId, p.limit),
    listComments: async (p: { sessionId: string; limit: number }) =>
      listSessionComments(deps.db, p.sessionId, p.limit),
    findSimilar: async (p: { input: FindSimilarInput }) =>
      findSimilar({ ...p.input, include_web: false }, deps.engines, deps.router, deps.backendStatus),
    // P6 F4 timeline — persist one agent action to the per-session append-only audit log. Reuse the
    // salvaged SessionAuditLog (sole writer, INSERT-only, hydrates the seq from the db) so the
    // (session_id, seq) monotonic invariant holds across broker calls.
    persistAudit: async (p: { sessionId: string; entry: AuditRecordInput }): Promise<{ seq: number }> => {
      const log = new SessionAuditLog({ db: deps.db, sessionId: p.sessionId });
      return { seq: log.record(p.entry).seq };
    },
    // K34 — the flow sidecar's writer for the Electron surface. The host cannot insert: it holds no DB
    // handle and this child owns the native module. The projection/allow-list runs HERE, where the row is
    // actually written, so a rejected step is refused by the same code the CLI path is refused by.
    //
    // The host owns `seq` (it is the sole writer for its own flow and allocates from `flowMaxSeq` below),
    // and `audit_seq` arrives already resolved to a DURABLE seq — this method does not translate it,
    // because only the host knows which in-memory record a step came from.
    recordFlowStep: async (p: { step: FlowStep }): Promise<FlowProjection> => insertFlowStep(deps.db, p.step),
    // The flow's highest stored seq, so a restarted host resumes numbering instead of colliding on 1
    // (the unique (flow_id, seq) index would otherwise silently drop the collision).
    flowMaxSeq: async (p: { flowId: string }): Promise<{ seq: number }> => {
      const rows = stmt(deps.db, 'SELECT MAX(seq) AS m FROM studio_flow_steps WHERE flow_id = ?')
        .all(p.flowId) as Array<{ m: number | null }>;
      return { seq: rows[0]?.m ?? 0 };
    },
    // Reverse-chronological read for the timeline (backfill + paging). Metadata columns only.
    listAudit: async (p: { sessionId: string; limit: number; before?: number }): Promise<AuditDto[]> =>
      listSessionAudit(deps.db, p.sessionId, p.limit, p.before),
    // M2 (sealed): studio_audit is append-only. NO prune/delete broker method — the ONLY sanctioned
    // deletion is the operator-CLI pruneStudioAudit (audit-retention.ts), unreachable from here + the agent.
    // P6 F3 cross-tab synthesis — shape the session's captured bodies into a research brief over the LOCAL
    // corpus. Invokes the brief-shaping stage ONLY (buildResearchBrief) — never decomposition→search→fetch,
    // so there is NO network. Persists the result as a qa artifact (save-as-research, findable via
    // find_similar). Zero captures → an honest empty DTO, never a fabricated brief.
    synthesizeSession: async (p: { sessionId: string }): Promise<ResearchBriefDto> => {
      const rows = listSessionArtifactsFull(deps.db, p.sessionId);
      if (rows.length === 0) return { empty: true };
      const { sources, provenance } = artifactsToSources(rows);
      // Caps mirror the research pipeline (PER_SOURCE=3000, TOTAL=40000); 'general' shaping, no comparison.
      const brief = await buildResearchBrief('Session summary', sources, [], 3000, 40000, 'general', []);
      captureFromPage(
        { type: 'qa', sessionId: p.sessionId, question: 'Session synthesis', answer: JSON.stringify(brief) },
        { db: deps.db, enqueue: deps.enqueue, credentialContext: { fields: [] }, onArtifact: deps.onArtifact },
      );
      return { brief, provenance };
    },
    // SD1 spine 1 — the run store behind the broker. A run outlives every UI, so the child that owns
    // the DB owns the log; the host never mints run identity and never writes an event itself.
    //
    // There is deliberately NO runUpdate and NO runDelete: the log is append-only, and the store
    // exports no path that could rewrite it. Retention, if it ever exists, goes the sanctioned-pruner
    // route (the audit-retention.ts precedent), never a broker method.
    runCreate: async (p: { input: CreateRunInput }): Promise<Run> =>
      createRun(deps.db, p.input, { onEvent: deps.onRunEvent }),
    runAppend: async (p: { runId: string; event: RunEventInput }): Promise<RunEvent> =>
      appendEvent(deps.db, p.runId, p.event, { onEvent: deps.onRunEvent }),
    runGet: async (p: { runId: string }): Promise<Run | undefined> => getRun(deps.db, p.runId),
    runList: async (p: ListRunsOptions = {}): Promise<ListRunsResult> => listRuns(deps.db, p),
    // Existence without a projection. `runGet(...) !== undefined` replays a run's whole log to answer,
    // and the host charges this once per SSE connect — every 3s for a client in a reconnect loop, against
    // a log that only grows. The daemon's own binding answers it with an index hit; this closes that
    // asymmetry rather than making the host pay for the pipe it sits behind.
    runExists: async (p: { runId: string }): Promise<boolean> => runExists(deps.db, p.runId),
    /**
     * A run's four stored facts, with no projection and no log read at all.
     *
     * The host's gap replay used to open with `runGet`, whose answer is a projected `Run` — the child
     * reads the run's projection rows, folds its cost in SQL and seeks its tail — and then threw
     * every field but these four away, because the projection it wants is the one it computes itself
     * from the log it is about to read next. So the same log was read twice per gap. This asks the
     * `studio_runs` row and stops.
     */
    runFacts: async (p: { runId: string }): Promise<StoredRunFacts | undefined> => {
      const id = resolveRunId(p.runId);
      if (id === undefined) return undefined;
      const row = stmt(deps.db, 'SELECT id, task, space_id, created_at FROM studio_runs WHERE id = ?').get(id) as
        { id: string; task: string; space_id: string; created_at: string } | undefined;
      return row ? { id: row.id, task: row.task, spaceId: row.space_id, createdAt: row.created_at } : undefined;
    },
    // The host's boot page in ONE round-trip. The host projects runs itself (it holds the same pure
    // `projectRun`), so it needs facts+events and not the `Run`s `runList` serializes — asking for both
    // sent every projection event across the pipe twice, once inside a projection the host recomputes.
    // Same page `runList` would return, so paging/filters keep one definition.
    //
    // Bounded per run and across the page — see MAX_BOOT_*. A run whose log does not fit is answered
    // with the projection `listRuns` already computed for it, which costs no extra read and is the
    // same answer REST gives.
    runListLogs: async (p: ListRunsOptions = {}): Promise<BrokerRunLogPage> => {
      const { runs, nextCursor } = listRuns(deps.db, p);
      let eventsLeft = MAX_BOOT_EVENTS_TOTAL;
      let charsLeft = MAX_BOOT_FRAME_CHARS;
      // Accumulated at the read, not derived as `MAX - left` afterwards. The spend is a fact about
      // the reads this call made; deriving it ties the number to whatever the allowance happened to
      // start at, and a stand-in store that forces an unbounded allowance — which the host's own
      // fixtures do — would report `NaN` and compare false against every bound the host applies.
      let eventsSpent = 0;
      let charsSpent = 0;
      const entries = runs.map((run): BrokerRunLogEntry => {
        const facts: StoredRunFacts = { id: run.id, task: run.task, spaceId: run.spaceId, createdAt: run.createdAt };
        // `seq` is gap-free and starts at 1, so the tail seq IS the event count: how big a log is, is
        // known from the listing row before a single event row is read.
        //
        // The char bound is decided the same way wherever it can be. `storedPayloadChars` under-states
        // the serialized size, so a run it rules out could not have fitted — and is ruled out for the
        // price of one SUM instead of a full parse-and-re-serialize.
        const budget = Math.min(MAX_BOOT_EVENTS_PER_RUN, eventsLeft);
        if (run.lastSeq <= budget && charsLeft > 0) {
          // The probe is a READ — a SUM over every payload byte this run has — so it is charged
          // before its answer is used, exactly like the materialization below. Charging it inside
          // the branch it guards made a run the probe ITSELF rejected cost the page nothing: the
          // scan happened, the page reported zero, and zero is what the hydration's allowance moves
          // by, so every page took the log branch and re-ran the same scan against a budget the
          // caller had just been handed fresh.
          const charsAtEntry = charsLeft;
          const storedChars = storedPayloadChars(deps.db, run.id);
          charsLeft -= storedChars;
          charsSpent += storedChars;
          if (storedChars <= charsAtEntry) {
            const events = eventsSince(deps.db, run.id, 0, budget);
            const chars = JSON.stringify(events).length;
            const fits = chars <= charsAtEntry;
            // Charged for the READ, never for the acceptance. A run that got this far cost the page
            // the same materialization whether or not its envelopes ship, and leaving the budget
            // untouched on rejection made the NEXT run start from the full four million and pay it
            // again — so a page of oversized runs read every one of them in full, and the next
            // hydration page did it again. Charging here is what makes the overrun terminate:
            // `charsLeft` goes non-positive and the guard above stops the reads for the rest of the
            // page. Only what the materialization added BEYOND the probe is charged here, because
            // the probe's characters are already on the books and they are the same characters —
            // the accepted path's total is `JSON.stringify(events).length`, unchanged.
            eventsLeft -= events.length;
            charsLeft -= chars - storedChars;
            eventsSpent += events.length;
            charsSpent += chars - storedChars;
            if (fits) return { facts, events, lastSeq: run.lastSeq };
          }
        }
        // The condensed answer is still an ANSWER, and it ships characters. It used to ship them
        // free: the event budget was decided first, so every run past `MAX_BOOT_EVENTS_PER_RUN`
        // took this branch without one comparison against `MAX_BOOT_FRAME_CHARS`, and the two
        // fields that grow — the held-tab list, and a pending-card list windowed by time and never
        // by count — were relayed in full at `charsSpent: 0`. Fifty such runs is a frame the host
        // kills, on a boot that produces the same frame every time it retries: a restart loop, not
        // a slow start. Charged here, on the same rule as the reads above — the page's own bound is
        // what makes the overrun terminate.
        const condensed = condenseProjection(run, charsLeft);
        charsLeft -= condensed.chars;
        charsSpent += condensed.chars;
        return {
          facts,
          events: [],
          lastSeq: run.lastSeq,
          projection: condensed.projection,
          ...(condensed.omitted ? { projectionOmitted: condensed.omitted } : {}),
          ...sessionLinkOf(deps.db, run.id),
        };
      });
      return { entries, eventsSpent, charsSpent, ...(nextCursor ? { nextCursor } : {}) };
    },
    // `limit` is REQUIRED. Omitting it used to mean "every event this run has ever had", in one frame,
    // and the view-model's gap replay called it exactly that way.
    //
    // CONTRACT: the returned page is clamped to `MAX_EVENTS_PAGE` rows AND `MAX_EVENTS_PAGE_CHARS`
    // characters whatever `limit` says, so a SHORT page never means end-of-log. Callers must page
    // until an EMPTY one — a caller that stops on a short page silently truncates every log longer
    // than either clamp. Both clamps are here because neither bounds a frame alone: rows say nothing
    // about size, and the size is what the host has to accumulate and parse on the thread that paints.
    runEventsSince: async (p: { runId: string; since?: number; limit: number }): Promise<RunEvent[]> => {
      const limit = Math.floor(Number(p.limit));
      if (!Number.isFinite(limit) || limit < 1) throw new Error('runEventsSince requires a positive limit');
      const id = resolveRunId(p.runId);
      if (id === undefined) return [];
      const since = p.since ?? 0;
      // Measure, then read exactly what fits. The clamp used to read the whole row page and
      // `JSON.stringify` its way down it, which is the second of two serializations of the same
      // characters — see `pageRowsWithinChars`.
      const rows = pageRowsWithinChars(deps.db, id, since, Math.min(limit, MAX_EVENTS_PAGE));
      return rows === 0 ? [] : eventsSince(deps.db, id, since, rows);
    },
  };
}
export type BrokerHandlers = ReturnType<typeof createBrokerHandlers>;

interface RpcRequest { id: number; method: keyof BrokerHandlers; params?: unknown }

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function main(): Promise<void> {
  // No-orphan (spec §11): die IMMEDIATELY when the parent closes our stdin pipe — the app's own stop
  // (`stopBrokerChild`) and an app crash both arrive that way — or when someone else signals us. A
  // graceful shutdown can hang on the onnxruntime-node teardown mutex race (see the init-exit-crash
  // history), so we hard-exit — the process is being reaped, exit-code niceties don't matter, and a
  // zombie broker (holding the DB + a model) is far worse.
  //
  // `process.exit(0)` is load-bearing beyond the exit code: it is what fires the `exit` hook that
  // drains the queued `events.jsonl` tail (law 11). The signal handlers below reach it only on POSIX
  // — a Windows `TerminateProcess` runs no JavaScript at all — which is why the stdin door, not a
  // signal, is the stop the app sends.
  const bail = (): never => process.exit(0);
  process.on('SIGTERM', bail);
  process.on('SIGINT', bail);
  const subsystems = await initSubsystems();
  const handlers = createBrokerHandlers({
    db: getDatabase(),
    engines: subsystems.searchEngines,
    router: subsystems.router,
    backendStatus: subsystems.backendStatus,
    onArtifact: (delta) => send({ notify: 'artifact', delta }),
    onRunEvent: (runId, envelope) => send({ notify: 'run-event', runId, envelope }),
  });
  const rl = createInterface({ input: process.stdin });
  rl.on('close', bail); // parent closed the stdin pipe (app exited/crashed) → don't linger
  rl.on('line', (line) => {
    void (async () => {
      let req: RpcRequest | undefined;
      try {
        req = JSON.parse(line) as RpcRequest;
        // Own-property only — never resolve a prototype method (e.g. `constructor`) as an RPC handler.
        const fn = Object.hasOwn(handlers, req.method) ? (handlers[req.method] as (p: unknown) => Promise<unknown>) : undefined;
        if (!fn) throw new Error(`unknown broker method: ${String(req.method)}`);
        send({ id: req.id, ok: true, result: await fn(req.params) });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (req) send({ id: req.id, ok: false, error: { message } });
        else log.error('broker parse error', { message });
      }
    })();
  });
  send({ notify: 'ready' });
  log.info('studio db broker ready');
}

// Gate solely on the env the client always sets — deterministic, no import-time surprise in tests.
if (process.env.WIGOLO_STUDIO_BROKER_MAIN === '1') {
  main().catch((e) => {
    log.error('broker fatal', { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
}
