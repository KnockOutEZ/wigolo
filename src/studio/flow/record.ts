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
import { flowIdForSession, insertFlowStep, type FlowDb, type FlowProjection } from './store.js';

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
      if (!RECORDABLE_ACTIONS.has(input.action)) return;
      if (input.auditSeq === undefined) return;
      if (isCredentialRecordingContext({ pageUrl: input.pageUrl, pageHasCredentialField: input.pageHasCredentialField })) return;
      if (TARGETED_ACTIONS.has(input.action) && !input.target) return;

      // Narrow AFTER the credential check, which must keep seeing the full URL.
      const storedPageUrl = narrowPageUrl(input.action, input.pageUrl);
      const next = seq + 1;
      let projected: FlowProjection;
      try {
        projected = insertFlowStep(deps.db, {
          flowId,
          sessionId: deps.sessionId,
          seq: next,
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
          ...(input.action === 'type' ? { slot: slotNameFor(input.target, next) } : {}),
          ...(input.direction !== undefined ? { direction: input.direction } : {}),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ts: now(),
        });
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
