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
 * may be up to `MAX_EVENT_PAYLOAD_CHARS` (64k), so a row count is not a size, and a size alone would
 * still have to read and parse an arbitrary number of rows to find out what it was.
 *
 * A run past either bound is answered with its PROJECTION instead of its envelopes. That is not a
 * degraded answer: `listRuns` has already computed it by the bounded path, it is field-for-field the
 * answer REST gives for the same run, and it is a few hundred bytes. The host keeps it exactly the
 * way it keeps a finished run's projection — every read stays correct — and replays the log in
 * bounded pages when the run next speaks.
 */
export const MAX_BOOT_EVENTS_PER_RUN = 2_000;
export const MAX_BOOT_EVENTS_TOTAL = 20_000;
export const MAX_BOOT_FRAME_CHARS = 4_000_000;

/**
 * The ceiling on ONE `runEventsSince` frame, whatever the caller asks for.
 *
 * `limit` is now required — an omitted one used to mean "the whole log", which is how the view-model
 * replayed every gap — but a required parameter only moves the decision to the caller. A frame the
 * host cannot survive must not be reachable FROM a caller at all, so the ceiling is enforced here as
 * well. A client that asks for more gets a short page, which is why the paged reader upstream stops
 * on an EMPTY page rather than on a short one.
 */
const MAX_EVENTS_PAGE = 2_000;

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
      const rows = deps.db
        .prepare('SELECT MAX(seq) AS m FROM studio_flow_steps WHERE flow_id = ?')
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
      const row = deps.db.prepare('SELECT id, task, space_id, created_at FROM studio_runs WHERE id = ?').get(id) as
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
      const entries = runs.map((run): BrokerRunLogEntry => {
        const facts: StoredRunFacts = { id: run.id, task: run.task, spaceId: run.spaceId, createdAt: run.createdAt };
        // `seq` is gap-free and starts at 1, so the tail seq IS the event count: how big a log is, is
        // known from the listing row before a single event row is read.
        const budget = Math.min(MAX_BOOT_EVENTS_PER_RUN, eventsLeft);
        if (run.lastSeq <= budget) {
          const events = eventsSince(deps.db, run.id, 0, budget);
          const chars = JSON.stringify(events).length;
          if (chars <= charsLeft) {
            eventsLeft -= events.length;
            charsLeft -= chars;
            return { facts, events, lastSeq: run.lastSeq };
          }
        }
        return { facts, events: [], lastSeq: run.lastSeq, projection: run, ...sessionLinkOf(deps.db, run.id) };
      });
      return { entries, ...(nextCursor ? { nextCursor } : {}) };
    },
    // `limit` is REQUIRED. Omitting it used to mean "every event this run has ever had", in one frame,
    // and the view-model's gap replay called it exactly that way.
    runEventsSince: async (p: { runId: string; since?: number; limit: number }): Promise<RunEvent[]> => {
      const limit = Math.floor(Number(p.limit));
      if (!Number.isFinite(limit) || limit < 1) throw new Error('runEventsSince requires a positive limit');
      return eventsSince(deps.db, p.runId, p.since ?? 0, Math.min(limit, MAX_EVENTS_PAGE));
    },
  };
}
export type BrokerHandlers = ReturnType<typeof createBrokerHandlers>;

interface RpcRequest { id: number; method: keyof BrokerHandlers; params?: unknown }

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function main(): Promise<void> {
  // No-orphan (spec §11): die IMMEDIATELY when the parent kills us (SIGTERM from broker.stop) or closes the
  // stdio pipe (app exit/crash). A graceful shutdown can hang on the onnxruntime-node teardown mutex race
  // (see the init-exit-crash history), so we hard-exit — the process is being reaped, exit-code niceties
  // don't matter, and a zombie broker (holding the DB + a model) is far worse.
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
