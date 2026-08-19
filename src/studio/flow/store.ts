/**
 * S13-0 — the FLOW SIDECAR store, and the allow-list that guards it at write AND at read.
 *
 * A flow is the agent's own successful trace, captured under human supervision. `studio_audit`
 * already records every action, but it deliberately keeps only what forensics needs: a `ref` for
 * a click, no page URL, no `role`/`name`, no `StructuredTarget`, no typed text. A ref is a
 * one-way hash of the element fingerprint, so a recording built from the audit alone can only
 * ever match on fingerprint equality — the weakest rung of the heal cascade. This sidecar carries
 * the seed the stronger rungs need, and carries nothing else.
 *
 * WHY AN ALLOW-LIST AND NOT A DENY-LIST. A deny-list of credential-shaped names ("cookie",
 * "authorization", …) passes everything nobody thought to name, and `attrs` comes from the PAGE —
 * a document chooses its own attribute names. An allow-list of the keys a re-run actually reads
 * is closed by construction, and it costs nothing here because the set of readers is small and
 * known: `heal()` reads `fingerprint`, `role`, `name` and `ancestorPath`, and `computeFingerprint`
 * reads exactly the stable-attr subset. Nothing reads a stored `attrs` entry outside that subset,
 * so storing one would be storage without a reader — and a reader-less field is exactly where a
 * secret goes unnoticed.
 *
 * The allow-list runs AT READ as well, because the writer is not the only way a row can arrive
 * (a future migration, a hand-edited DB, a restored backup). A rejected row raises a typed error:
 * accepting-and-ignoring is how a dead handle eventually gets dereferenced by something that
 * trusted the field's presence.
 */
import { createHash } from 'node:crypto';
import { STABLE_ATTRS } from '../perception/id.js';
import type { HealConfidence } from '../mark/heal.js';

/** The one narrow DB surface this module writes and reads through (a better-sqlite3 Database satisfies it). */
export interface FlowDb {
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}

/**
 * The re-resolution seed: `mark/target.ts`'s StructuredTarget MINUS `backendNodeId` (a live
 * host-side handle, invalid in a stored step) and MINUS `trusted` (welded `false` at
 * construction — a stored copy could only ever disagree with the weld).
 */
export interface FlowTargetSeed {
  role: string;
  name: string;
  fingerprint: string;
  ancestorPath: string;
  /** Restricted to the fingerprint's stable-attr subset — see the allow-list note above. */
  attrs: Record<string, string>;
}

/** The heal confidences a recording may carry. `low`/`none` were never actionable, so they were never recorded. */
export type RecordedHealTier = Extract<HealConfidence, 'high' | 'medium'>;

export interface FlowStep {
  flowId: string;
  sessionId: string;
  seq: number;
  /** The `studio_audit` row this step was derived from — the join back to the forensic record. */
  auditSeq: number;
  action: string;
  pageUrl?: string;
  target?: FlowTargetSeed;
  /** The ref minted at record time. A control for the resolver comparison — never the primary locator. */
  recordedRef?: string;
  healTierAtRecord?: RecordedHealTier;
  /** For `type`: the named parameter the caller fills at run time. NEVER a value. */
  slot?: string;
  direction?: 'up' | 'down';
  amount?: number;
  ts: number;
}

/** Top-level keys a step may carry. Exported as data so the reader is checked against the same list the writer is. */
export const FLOW_STEP_KEYS = [
  'flowId', 'sessionId', 'seq', 'auditSeq', 'action', 'pageUrl', 'target',
  'recordedRef', 'healTierAtRecord', 'slot', 'direction', 'amount', 'ts',
] as const;

/** Seed keys a step's target may carry. `backendNodeId` and `trusted` are absent on purpose. */
export const FLOW_TARGET_KEYS = ['role', 'name', 'fingerprint', 'ancestorPath', 'attrs'] as const;

/**
 * Attribute keys a stored seed may carry — the SAME fixed subset `computeFingerprint` reads, so
 * a stored seed is exactly sufficient to recompute its own fingerprint and cannot carry more.
 */
export const FLOW_ATTR_KEYS: readonly string[] = STABLE_ATTRS;

export type FlowRejectReason =
  | 'disallowed_key'
  | 'disallowed_target_key'
  | 'disallowed_attr'
  | 'incomplete_target'
  | 'missing_target'
  | 'unexpected_target'
  | 'bad_field';

export type FlowProjection =
  | { ok: true; step: FlowStep }
  | { ok: false; reason: FlowRejectReason; key: string };

/** Thrown when a stored row fails the read allow-list. A rejected row is never silently repaired. */
export class FlowStepReadError extends Error {
  constructor(readonly reason: FlowRejectReason, readonly key: string) {
    super(`flow step rejected at read: ${reason} (${key})`);
    this.name = 'FlowStepReadError';
  }
}

/** Verbs whose step is defined by an element seed. The other verbs carry no target at all. */
const TARGETED_ACTIONS = new Set(['click', 'type']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Project an untyped candidate step through the write allow-list.
 *
 * Untyped on purpose: the recorder builds a step from a live `StructuredTarget`, which carries
 * fields a stored step must not (`backendNodeId`, `trusted`), and a compile-time-only guard would
 * be satisfied by a widened object. The check has to exist at run time to mean anything.
 */
export function projectFlowStep(raw: unknown): FlowProjection {
  if (!isRecord(raw)) return { ok: false, reason: 'bad_field', key: '<root>' };

  const allowed = new Set<string>(FLOW_STEP_KEYS);
  for (const key of Object.keys(raw)) {
    if (raw[key] === undefined) continue;
    if (!allowed.has(key)) return { ok: false, reason: 'disallowed_key', key };
  }

  const str = (k: string): string | undefined => (typeof raw[k] === 'string' ? (raw[k] as string) : undefined);
  const num = (k: string): number | undefined =>
    typeof raw[k] === 'number' && Number.isFinite(raw[k]) ? (raw[k] as number) : undefined;

  const flowId = str('flowId');
  const sessionId = str('sessionId');
  const action = str('action');
  const seq = num('seq');
  const auditSeq = num('auditSeq');
  const ts = num('ts');
  for (const [k, v] of [['flowId', flowId], ['sessionId', sessionId], ['action', action]] as const) {
    if (!v) return { ok: false, reason: 'bad_field', key: k };
  }
  for (const [k, v] of [['seq', seq], ['auditSeq', auditSeq], ['ts', ts]] as const) {
    if (v === undefined) return { ok: false, reason: 'bad_field', key: k };
  }

  const tier = str('healTierAtRecord');
  if (tier !== undefined && tier !== 'high' && tier !== 'medium') {
    // A `low` or `none` verdict is "ask, never guess" — it never produced an action, so it can
    // never have produced a recording. Storing one would advertise a seed nothing may act on.
    return { ok: false, reason: 'bad_field', key: 'healTierAtRecord' };
  }

  const direction = str('direction');
  if (direction !== undefined && direction !== 'up' && direction !== 'down') {
    return { ok: false, reason: 'bad_field', key: 'direction' };
  }

  const targetRaw = raw['target'];
  const needsTarget = TARGETED_ACTIONS.has(action!);
  if (targetRaw === undefined) {
    if (needsTarget) return { ok: false, reason: 'missing_target', key: action! };
  } else if (!needsTarget) {
    return { ok: false, reason: 'unexpected_target', key: action! };
  }

  let target: FlowTargetSeed | undefined;
  if (targetRaw !== undefined) {
    const projected = projectTarget(targetRaw);
    if (!projected.ok) return projected;
    target = projected.target;
  }

  const step: FlowStep = {
    flowId: flowId!,
    sessionId: sessionId!,
    seq: seq!,
    auditSeq: auditSeq!,
    action: action!,
    ts: ts!,
    ...(str('pageUrl') !== undefined ? { pageUrl: str('pageUrl')! } : {}),
    ...(target ? { target } : {}),
    ...(str('recordedRef') !== undefined ? { recordedRef: str('recordedRef')! } : {}),
    ...(tier !== undefined ? { healTierAtRecord: tier } : {}),
    ...(str('slot') !== undefined ? { slot: str('slot')! } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(num('amount') !== undefined ? { amount: num('amount')! } : {}),
  };
  return { ok: true, step };
}

function projectTarget(raw: unknown): { ok: true; target: FlowTargetSeed } | { ok: false; reason: FlowRejectReason; key: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'bad_field', key: 'target' };
  const allowed = new Set<string>(FLOW_TARGET_KEYS);
  for (const key of Object.keys(raw)) {
    if (raw[key] === undefined) continue;
    if (!allowed.has(key)) return { ok: false, reason: 'disallowed_target_key', key };
  }
  for (const key of FLOW_TARGET_KEYS) {
    if (raw[key] === undefined) return { ok: false, reason: 'incomplete_target', key };
  }
  const { role, name, fingerprint, ancestorPath, attrs } = raw;
  if (typeof role !== 'string' || typeof name !== 'string' || typeof fingerprint !== 'string' || typeof ancestorPath !== 'string') {
    return { ok: false, reason: 'bad_field', key: 'target' };
  }
  const projectedAttrs = projectAttrs(attrs);
  if (!projectedAttrs.ok) return projectedAttrs;
  return { ok: true, target: { role, name, fingerprint, ancestorPath, attrs: projectedAttrs.attrs } };
}

/**
 * Keep the fingerprint's stable-attr subset; DROP any other ordinary page attribute (`class`,
 * `id`, `style`, `data-*` …) rather than reject the step — those are normal markup and nothing
 * reads them from storage. A credential-shaped name is a different case: it is rejected loudly so
 * the recording fails visibly instead of quietly shedding something that should never have been
 * offered.
 */
function projectAttrs(raw: unknown): { ok: true; attrs: Record<string, string> } | { ok: false; reason: FlowRejectReason; key: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'bad_field', key: 'attrs' };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SENSITIVE_ATTR_NAMES.has(key.toLowerCase())) return { ok: false, reason: 'disallowed_attr', key };
    if (!FLOW_ATTR_KEYS.includes(key)) continue;
    if (typeof value !== 'string') return { ok: false, reason: 'bad_field', key };
    out[key] = value;
  }
  return { ok: true, attrs: out };
}

/**
 * Names that must never be quietly dropped. This is NOT the guard — the allow-list above is, and
 * it already excludes every one of these. This list exists so the failure is LOUD: a page or a
 * caller offering one of these is a signal worth surfacing, not a silently trimmed field.
 */
const SENSITIVE_ATTR_NAMES: ReadonlySet<string> = new Set([
  'cookie', 'set-cookie', 'authorization', 'storagestate', 'password', 'token', 'secret',
]);

/**
 * A flow's stable identity.
 *
 * Derived from the session, NOT from a hash of the step body: the recorder appends on every
 * successful act, and a content hash cannot name a sequence that is still growing without
 * renaming the flow on each append. One studio session owns exactly one tab (the host mints one
 * tab at `open`, maps it 1:1, and drops both at `close`), so the session IS the recording and the
 * flow is single-tab by construction.
 */
export function flowIdForSession(sessionId: string): string {
  return 'flw_' + createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

interface FlowRow {
  flow_id: string;
  session_id: string;
  seq: number;
  audit_seq: number;
  action: string;
  page_url: string | null;
  target_role: string | null;
  target_name: string | null;
  target_fingerprint: string | null;
  target_ancestor_path: string | null;
  target_attrs: string | null;
  recorded_ref: string | null;
  heal_tier_at_record: string | null;
  slot: string | null;
  direction: string | null;
  amount: number | null;
  ts: number;
}

/**
 * The sole writer. Projects through the allow-list first — a rejected step is NOT inserted and
 * the rejection is returned, never thrown past the act path (a recording failure must not turn a
 * successful action into an error the agent retries).
 */
export function insertFlowStep(db: FlowDb, raw: unknown): FlowProjection {
  const projected = projectFlowStep(raw);
  if (!projected.ok) return projected;
  const s = projected.step;
  db.prepare('INSERT OR IGNORE INTO studio_sessions (id) VALUES (?)').run(s.sessionId);
  db.prepare(
    `INSERT OR IGNORE INTO studio_flow_steps
       (flow_id, session_id, seq, audit_seq, action, page_url,
        target_role, target_name, target_fingerprint, target_ancestor_path, target_attrs,
        recorded_ref, heal_tier_at_record, slot, direction, amount, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.flowId, s.sessionId, s.seq, s.auditSeq, s.action, s.pageUrl ?? null,
    s.target?.role ?? null, s.target?.name ?? null, s.target?.fingerprint ?? null,
    s.target?.ancestorPath ?? null, s.target ? JSON.stringify(s.target.attrs) : null,
    s.recordedRef ?? null, s.healTierAtRecord ?? null, s.slot ?? null,
    s.direction ?? null, s.amount ?? null, s.ts,
  );
  return projected;
}

/** Rebuild a step from a row, re-running the allow-list. A row that fails it raises, never returns a partial step. */
function rowToStep(r: FlowRow): FlowStep {
  let attrs: unknown = {};
  if (r.target_attrs != null) {
    try {
      attrs = JSON.parse(r.target_attrs) as unknown;
    } catch {
      throw new FlowStepReadError('bad_field', 'target_attrs');
    }
    if (isRecord(attrs)) {
      for (const key of Object.keys(attrs)) {
        // At READ the allow-list is strict on BOTH counts: a stored row had its attributes
        // trimmed at write, so anything outside the subset arrived some other way.
        if (!FLOW_ATTR_KEYS.includes(key)) throw new FlowStepReadError('disallowed_attr', key);
      }
    }
  }
  const candidate: Record<string, unknown> = {
    flowId: r.flow_id,
    sessionId: r.session_id,
    seq: r.seq,
    auditSeq: r.audit_seq,
    action: r.action,
    ts: r.ts,
    ...(r.page_url != null ? { pageUrl: r.page_url } : {}),
    ...(r.target_fingerprint != null
      ? {
          target: {
            role: r.target_role ?? '',
            name: r.target_name ?? '',
            fingerprint: r.target_fingerprint,
            ancestorPath: r.target_ancestor_path ?? '',
            attrs,
          },
        }
      : {}),
    ...(r.recorded_ref != null ? { recordedRef: r.recorded_ref } : {}),
    ...(r.heal_tier_at_record != null ? { healTierAtRecord: r.heal_tier_at_record } : {}),
    ...(r.slot != null ? { slot: r.slot } : {}),
    ...(r.direction != null ? { direction: r.direction } : {}),
    ...(r.amount != null ? { amount: r.amount } : {}),
  };
  const projected = projectFlowStep(candidate);
  if (!projected.ok) throw new FlowStepReadError(projected.reason, projected.key);
  return Object.freeze(projected.step);
}

const READ_COLS =
  `flow_id, session_id, seq, audit_seq, action, page_url,
   target_role, target_name, target_fingerprint, target_ancestor_path, target_attrs,
   recorded_ref, heal_tier_at_record, slot, direction, amount, ts`;

/** The ordered steps of one flow. Inspectable before anything runs it — that is the slice's deliverable. */
export function listFlowSteps(db: FlowDb, flowId: string): FlowStep[] {
  const rows = db
    .prepare(`SELECT ${READ_COLS} FROM studio_flow_steps WHERE flow_id = ? ORDER BY seq ASC`)
    .all(flowId) as FlowRow[];
  return rows.map(rowToStep);
}

/** One recorded flow, summarised for a listing — no step bodies, so nothing page-derived is read. */
export interface FlowSummary {
  flowId: string;
  sessionId: string;
  steps: number;
  firstTs: number;
  lastTs: number;
}

/**
 * Every recorded flow, newest activity first.
 *
 * Aggregated in SQL rather than by reading every step: a listing needs counts and timestamps, and
 * loading step bodies to count them would pull target locators through a path that has no use for them.
 */
export function listFlows(db: FlowDb): FlowSummary[] {
  const rows = db
    .prepare(
      `SELECT flow_id, session_id, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts
         FROM studio_flow_steps
        GROUP BY flow_id, session_id
        ORDER BY last_ts DESC, flow_id ASC`,
    )
    .all() as Array<{ flow_id: string; session_id: string; n: number; first_ts: number; last_ts: number }>;
  return rows.map((r) => ({
    flowId: r.flow_id,
    sessionId: r.session_id,
    steps: r.n,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
  }));
}

/** Every flow id recorded for a session (one today; the query does not assume it). */
export function listSessionFlowIds(db: FlowDb, sessionId: string): string[] {
  const rows = db
    .prepare('SELECT DISTINCT flow_id FROM studio_flow_steps WHERE session_id = ? ORDER BY flow_id')
    .all(sessionId) as Array<{ flow_id: string }>;
  return rows.map((r) => r.flow_id);
}
