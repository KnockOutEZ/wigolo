/**
 * S13-0 — the RECORDER: it writes one flow step whenever an agent act succeeds.
 *
 * WHAT A RECORDING IS. `studio_audit` contains zero human actions — every row arrives through
 * `studio_act` — and the human's input path is not an interceptable seam any more: the human
 * drives a real browser view and the host never sees the events. So a recording here is the
 * AGENT's own successful trace, captured while a human supervises. The human "shows" the flow by
 * supervising one agent run, not by driving it themselves.
 *
 * WHY IT HANGS OFF THE ACT PATH AND NOWHERE ELSE. The act handler is the single choke point every
 * agent action already passes through — gate, resolve, credential refusal, risk gate, dispatch,
 * audit. Recording from a second observer would mean a second notion of "this happened", and the
 * two would drift. The recorder is handed its seed by the act path at the moment the element is
 * live, and it writes only after the act's own resolution says the action landed.
 *
 * WHAT IT REFUSES TO BUILD, rather than builds and then filters:
 *  - a credential context (a login-shaped URL, or a page carrying a credential field) produces NO
 *    seed and NO step. Nothing is stored, so nothing can surface later. This mirrors the mark
 *    path, whose whole shape is refuse-at-creation rather than capture-then-filter.
 *  - a `type` step stores a named SLOT and never a value. The recording cannot leak what it never
 *    held, and "run this flow for this input" is the thing a caller actually wants.
 *  - a step with no audit row is not written at all. The sidecar is DERIVED from the forensic
 *    record; a fabricated join key would be worse than a missing step.
 *
 * ONE credential decision, applied at the earliest point each verb has its inputs — not two
 * layers keyed on the same predicate, which would only read as depth.
 */
import { createLogger } from '../../logger.js';
import { isCredentialUrl } from '../credential.js';
import type { StructuredTarget } from '../mark/target.js';
import { flowIdForSession, insertFlowStep, type FlowDb, type FlowProjection, type FlowStep } from './store.js';

const log = createLogger('studio');

/**
 * The seam the act handler holds. Deliberately narrow: the recorder never reaches for a browser,
 * a snapshot or a DB handle of its own — the host provides the seed builder, and this module
 * decides only what is worth storing.
 */
export interface FlowRecorderHook {
  /**
   * Build the durable seed for an element that is LIVE right now (the host binds this to the same
   * privileged AX⋈DOM path a human mark uses). Called before dispatch, because after a click the
   * element may be gone. Returning null means "no seed" and therefore "no step" — never a guess.
   */
  seed(backendNodeId: number): Promise<StructuredTarget | null>;
  /** Append one successful step. Must never throw — a recording failure is not an action failure. */
  record(input: FlowRecordInput): void;
}

/** What the act path hands over once an action has landed. */
export interface FlowRecordInput {
  action: string;
  /** The `studio_audit` seq this step is derived from. Absent ⇒ nothing is recorded. */
  auditSeq?: number;
  /** For navigate: the requested URL. For every other verb: the page the action happened ON, read BEFORE dispatch. */
  pageUrl?: string;
  /** The live target, seeded at resolve time. Its `backendNodeId`/`trusted` are dropped by the store's allow-list. */
  target?: StructuredTarget | null;
  recordedRef?: string;
  direction?: 'up' | 'down';
  amount?: number;
  /** The page's credential-field signal at resolve time (the snapshot's own scan). */
  pageHasCredentialField?: boolean;
}

export interface FlowRecorderDeps {
  db: FlowDb;
  sessionId: string;
  seed(backendNodeId: number): Promise<StructuredTarget | null>;
  now?: () => number;
  /** Notify-only: a step the allow-list refused. The host can surface it; nothing here retries. */
  onReject?: (rejection: Extract<FlowProjection, { ok: false }>) => void;
}

/**
 * A recording is refused wholesale in a credential context. ONE predicate, one place: a
 * login-shaped URL uses the same fixed, non-injectable constant the hard credential guard does, so
 * a re-tuning of the heuristic risk policy cannot widen what gets recorded.
 */
export function isCredentialRecordingContext(input: { pageUrl?: string; pageHasCredentialField?: boolean }): boolean {
  return input.pageHasCredentialField === true || isCredentialUrl(input.pageUrl);
}

/**
 * A stable, value-free name for a `type` step's parameter, derived from locators the step already
 * stores (the element's accessible name, then its `name`/`placeholder` attribute). Deriving it
 * adds no information the seed did not already carry; falling back to the position keeps a
 * nameless field addressable.
 */
export function slotNameFor(target: StructuredTarget | null | undefined, seq: number): string {
  const source = target?.name || target?.attrs?.name || target?.attrs?.placeholder || '';
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return slug || `input_${seq}`;
}

/**
 * What a stored `page_url` may say, by verb.
 *
 * The retention decision for this sidecar rests on the sidecar adding no exposure the audit does
 * not already carry. That holds for `navigate` — its URL is byte-identical to the
 * `studio_audit.target_url` of the same act — and it does NOT hold for the other verbs: the audit
 * stores no URL at all for `click`/`type`/`scroll`, while the recorder stores the LIVE page URL.
 * A navigate URL is agent-authored; a live URL is SERVER-authored and post-redirect, which is
 * exactly where a session-bearing query parameter appears (`?sso_session=…`). The credential-URL
 * guard does not catch those — it matches login words as PATH segments, so a `?sso_session=` sails
 * through.
 *
 * So the other verbs keep origin + path and drop search + hash. A step's page URL is CONTEXT for
 * re-resolution; the target locator does the actual work. The search/hash carry the risk without
 * carrying the replay value. A navigate URL is the instruction itself and is kept whole.
 *
 * A URL that will not parse is dropped rather than stored raw — storing an unparsed string is how
 * the narrowing gets bypassed by something that never looked like a URL to us.
 */
export function narrowPageUrl(action: string, pageUrl: string | undefined): string | undefined {
  if (pageUrl === undefined) return undefined;
  if (action === 'navigate') return pageUrl;
  try {
    const u = new URL(pageUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

/** Verbs whose step is defined by an element seed; the others carry none. */
const TARGETED_ACTIONS = new Set(['click', 'type']);
const RECORDABLE_ACTIONS = new Set(['navigate', 'click', 'type', 'scroll']);

/** One step's fields, minus the three the persister owns: `flowId`, `sessionId`, `seq`. */
export type FlowStepFields = Omit<FlowStep, 'flowId' | 'sessionId' | 'seq'>;

/**
 * EVERY decision about WHETHER to record, in one place, called by every recorder.
 *
 * A TYPE PREDICATE, not a boolean: one of the four refusals is "no audit seq", so callers past this
 * point genuinely have one. Returning `boolean` compiled but silently dropped the narrowing the inline
 * check used to provide, and the alternative — asserting past it at the use site — would have made the
 * join key non-null by assertion rather than by construction.
 *
 * Extracted for K34: the Electron host cannot persist synchronously (it holds no database handle and
 * reaches the native DB through an async broker call), so it needs a different PERSISTER — and the
 * one thing it must not have is a different notion of what gets recorded. This module's own opening
 * comment is the reason: *"Recording from a second observer would mean a second notion of 'this
 * happened', and the two would drift."* The persister varies; this function does not.
 *
 * `null` means "record nothing", and each `null` is a refusal the sidecar is designed around rather
 * than a filter applied afterwards.
 */
export function isRecordableAct(input: FlowRecordInput): input is FlowRecordInput & { auditSeq: number } {
  if (!RECORDABLE_ACTIONS.has(input.action)) return false;
  // A step with no audit row is not written at all: the sidecar is DERIVED from the forensic record,
  // and a fabricated join key would be worse than a missing step.
  if (input.auditSeq === undefined) return false;
  if (isCredentialRecordingContext({ pageUrl: input.pageUrl, pageHasCredentialField: input.pageHasCredentialField })) {
    return false;
  }
  if (TARGETED_ACTIONS.has(input.action) && !input.target) return false;
  return true;
}

/**
 * The step's fields, or `null` if it is not to be recorded. Calls `isRecordableAct` rather than
 * repeating it, so a recorder that needs the verdict WITHOUT building a step (to skip a broker round
 * trip on a credential page) asks the same predicate this does.
 */
export function draftFlowStep(input: FlowRecordInput, seq: number, ts: number): FlowStepFields | null {
  if (!isRecordableAct(input)) return null;

  // Narrow AFTER the credential check, which must keep seeing the full URL.
  const storedPageUrl = narrowPageUrl(input.action, input.pageUrl);
  return {
    auditSeq: input.auditSeq,
    action: input.action,
    ...(storedPageUrl !== undefined ? { pageUrl: storedPageUrl } : {}),
    ...(input.target
      ? {
          target: {
            role: input.target.role,
            name: input.target.name,
            fingerprint: input.target.fingerprint,
            ancestorPath: input.target.ancestorPath,
            attrs: input.target.attrs,
          },
          // DERIVED, not asserted: `resolve()` refuses a low-confidence ref, and a ref is
          // low-confidence exactly when its fingerprint collided in that snapshot. A ref that
          // resolved therefore had a unique fingerprint on the page — which is what heal's
          // strongest tier matches on.
          healTierAtRecord: 'high' as const,
        }
      : {}),
    ...(input.recordedRef !== undefined ? { recordedRef: input.recordedRef } : {}),
    ...(input.action === 'type' ? { slot: slotNameFor(input.target, seq) } : {}),
    ...(input.direction !== undefined ? { direction: input.direction } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ts,
  };
}

/**
 * The Electron host's recorder. Same `record(): void` contract, an async persister underneath.
 *
 * K34: that host holds no database handle — every persist is a `broker.call(...)` into the child
 * process that owns the native DB — and its audit log is in-memory while the durable rows are written
 * by the broker. Three consequences are designed for here:
 *
 *  1. **The join key is the DURABLE audit seq**, obtained from `resolveAuditSeq`. The host's in-memory
 *     seq and the broker's durable seq both count from 1, so they agree until a persist fails and then
 *     silently disagree forever — and `013-studio-flows.sql` has no foreign key on `audit_seq`, so
 *     nothing downstream would notice. **No durable seq ⇒ no step**, which is the sidecar's own
 *     existing rule (a step with no audit row is not written) rather than a new failure mode.
 *  2. **Ordering is a promise chain**, mirroring the host's `auditPersist` chain, because the unique
 *     `(flow_id, seq)` index silently drops a collision and three racing appends would produce one.
 *  3. **`seq` advances only after a successful insert**, exactly as the synchronous recorder does, so a
 *     transient broker outage costs one step instead of leaving a permanent hole in the sequence.
 */
export interface BrokerFlowRecorderDeps {
  sessionId: string;
  seed(backendNodeId: number): Promise<StructuredTarget | null>;
  /** The flow's highest stored `seq`, read once, so numbering resumes rather than colliding on 1. */
  maxSeq(): Promise<number>;
  /**
   * The durable `studio_audit.seq` for an in-memory seq. `undefined` means the audit row never landed,
   * and therefore that no step may be written.
   */
  resolveAuditSeq(inMemorySeq: number): Promise<number | undefined>;
  /** Persist one step. May reject; a rejection loses the step and never reaches the caller. */
  insert(step: FlowStep): Promise<FlowProjection>;
  now?: () => number;
  onReject?: (rejection: Extract<FlowProjection, { ok: false }>) => void;
}

/** The async recorder, plus the drain its tests and a clean shutdown need. */
export interface BrokerFlowRecorder extends FlowRecorderHook {
  /** Resolve once every queued append has been attempted. Never rejects. */
  flush(): Promise<void>;
}

export function createBrokerFlowRecorder(deps: BrokerFlowRecorderDeps): BrokerFlowRecorder {
  const now = deps.now ?? (() => Date.now());
  const flowId = flowIdForSession(deps.sessionId);
  const onReject = (rejection: Extract<FlowProjection, { ok: false }>): void => {
    log.warn('flow step rejected by the recording allow-list', { reason: rejection.reason, key: rejection.key });
    deps.onReject?.(rejection);
  };

  // Read once, lazily, and shared by every append: the chain serialises the appends, so a single
  // in-flight read cannot be raced by the second record() call.
  let resumed: Promise<number> | undefined;
  const startSeq = (): Promise<number> => (resumed ??= deps.maxSeq().catch(() => 0));

  let seq: number | undefined;
  let chain: Promise<void> = Promise.resolve();

  return {
    async seed(backendNodeId: number): Promise<StructuredTarget | null> {
      return deps.seed(backendNodeId);
    },
    record(input: FlowRecordInput): void {
      // Everything below runs INSIDE the chain: the audit-seq lookup and the insert are both async, and
      // doing either eagerly would let two record() calls interleave and allocate the same seq.
      chain = chain.then(async () => {
        try {
          if (seq === undefined) seq = await startSeq();
          // Cheap refusals first, through the SAME predicate the drafter uses, so a credential-context
          // act costs no broker round trip and cannot be refused here for a different reason than there.
          if (!isRecordableAct(input)) return;

          const auditSeq = await deps.resolveAuditSeq(input.auditSeq ?? -1);
          if (auditSeq === undefined) {
            log.warn('flow step not recorded: its audit row did not land', { action: input.action });
            return;
          }

          const next = seq + 1;
          const fields = draftFlowStep({ ...input, auditSeq }, next, now());
          if (!fields) return;

          const projected = await deps.insert({ flowId, sessionId: deps.sessionId, seq: next, ...fields });
          if (!projected.ok) {
            onReject(projected);
            return;
          }
          seq = next;
        } catch (err) {
          // Same contract as the synchronous recorder, and for the same reason: this runs after an
          // action already reached the page and is already in the audit log. Surfacing a failure here
          // would tell an agent its click failed, and an agent told that retries — re-executing an
          // action that fired. Losing the step is strictly cheaper. `seq` is deliberately not advanced.
          log.warn('flow step not recorded', {
            action: input.action,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    },
    async flush(): Promise<void> {
      await chain;
    },
  };
}

export function createFlowRecorder(deps: FlowRecorderDeps): FlowRecorderHook {
  const now = deps.now ?? (() => Date.now());
  const flowId = flowIdForSession(deps.sessionId);
  /**
   * `projectAttrs` rejects a WHOLE step when the page offers a credential-shaped attribute name,
   * and its own comment justifies that as failing LOUDLY rather than quietly shedding a field.
   * With no host consumer wired for `onReject`, the optional callback made it the exact opposite —
   * silent. Logging is what makes the claim true independently of whether a host ever subscribes.
   */
  const onReject = (rejection: Extract<FlowProjection, { ok: false }>): void => {
    log.warn('flow step rejected by the recording allow-list', { reason: rejection.reason, key: rejection.key });
    deps.onReject?.(rejection);
  };
  // Resume after a restart rather than colliding on seq 1: the unique (flow_id, seq) index would
  // silently drop the colliding row, and a flow missing its middle is worse than a short one.
  const prior = deps.db
    .prepare('SELECT MAX(seq) AS m FROM studio_flow_steps WHERE flow_id = ?')
    .all(flowId) as Array<{ m: number | null }>;
  let seq = prior[0]?.m ?? 0;

  return {
    async seed(backendNodeId: number): Promise<StructuredTarget | null> {
      return deps.seed(backendNodeId);
    },
    record(input: FlowRecordInput): void {
      const next = seq + 1;
      const fields = draftFlowStep(input, next, now());
      if (!fields) return;

      let projected: FlowProjection;
      try {
        projected = insertFlowStep(deps.db, { flowId, sessionId: deps.sessionId, seq: next, ...fields });
      } catch (err) {
        // The contract above ("must never throw") is the whole point of the sidecar being a
        // DERIVED artefact, and until now it lived only in a docstring. `insertFlowStep` runs two
        // `db.prepare().run()` calls, and SQLITE_BUSY / a readonly file / a full disk throw from
        // any of them. Escaping here would report a FAILURE for an action that already reached the
        // page and is already in the audit log — and an agent told a click failed retries it,
        // re-executing an action that fired. Losing the step is the strictly cheaper outcome.
        // `seq` is deliberately NOT advanced: the next step reuses this number, so a transient
        // lock costs one step rather than a permanent hole in the sequence.
        log.warn('flow step not recorded', { action: input.action, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (!projected.ok) {
        onReject(projected);
        return;
      }
      seq = next;
    },
  };
}
