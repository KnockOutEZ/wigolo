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
import type { IndexJobInput } from '../embedding/background-queue.js';
import type { FieldSemantics } from '../studio/credential.js';
import type { StudioCaptureInput } from './studio-dispatch.js';
import type { FindSimilarInput } from '../types.js';

const log = createLogger('studio');
type CredSignal = { pageUrl?: string; fields?: FieldSemantics[] };

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
    // Reverse-chronological read for the timeline (backfill + paging). Metadata columns only.
    listAudit: async (p: { sessionId: string; limit: number; before?: number }): Promise<AuditDto[]> =>
      listSessionAudit(deps.db, p.sessionId, p.limit, p.before),
    // M2 (sealed): studio_audit is append-only. NO prune/delete broker method — the ONLY sanctioned
    // deletion is the operator-CLI pruneStudioAudit (audit-retention.ts), unreachable from here + the agent.
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
