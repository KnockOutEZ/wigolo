/**
 * Phase 6b — the per-session, APPEND-ONLY audit log of every agent action.
 *
 * Records each studio_act the agent attempts together with its resolved outcome, for the
 * two jobs the studio's trust story needs: forensics (what did the agent do, did it
 * succeed or get refused?) and replay (the Phase-7 timeline IS this log, played in order).
 *
 * Append-only by construction: there is no mutate / remove / clear method, every recorded
 * entry is frozen (target + outcome included), and `replay()` hands out a fresh array — so
 * no consumer can rewrite session history. In-memory per session for now; Phase 4 owns the
 * persistent schema/migration.
 *
 * The entry is a CLOSED shape (not an open `[k]: unknown` bag) so this channel carries the
 * same compile-time enforcement the observe channel does.
 */
import type { RiskTier } from './risk.js';
import type { ApprovalDecision } from './approvals.js';

/** The resolved outcome of one agent action: success, or a typed refusal/failure reason. */
export type AuditOutcome =
  | { ok: true; charsLanded?: number }
  | { ok: false; error_reason: string; charsLanded?: number };

/** What the act handler hands in for one agent action; the log stamps `seq` + `ts`. */
export interface AuditRecordInput {
  /** The attempted verb (navigate|click|type|scroll, or whatever the agent sent — an unknown verb is logged too, never silently dropped). */
  action: string;
  /** The control epoch at record time — ties the action to a turn (forensics: was the agent the holder, did a reclaim land). */
  epoch: number;
  /** The action's inputs, by verb. NO raw typed text (privacy) — `outcome.charsLanded` carries the type effect. */
  target?: { url?: string; ref?: string; direction?: 'up' | 'down'; amount?: number };
  /** The resolved outcome. */
  outcome: AuditOutcome;
  /** Phase 6c: the risk tier the deterministic classifier assigned. Absent when the action was not classified risky (safe). */
  risk?: RiskTier;
  /** Phase 6c: the human approval decision when the action passed through the gate. Absent when the action was never gated. */
  approval?: ApprovalDecision;
}

/** A stamped, immutable audit entry. */
export interface AuditEntry extends AuditRecordInput {
  /** Host-assigned monotonic sequence (1-based) — the replay order. */
  seq: number;
  /** Record-time timestamp from the injected clock. */
  ts: number;
}

/**
 * The narrow DB surface the audit log writes through (Phase 6b persistence). A real better-sqlite3
 * Database satisfies it structurally; tests inject a migrated in-memory DB. Kept as an injected
 * interface (not a getDatabase import) so audit.ts stays a leaf — the persistent INSERT lands HERE
 * (sole writer), but the handle is provided by the host.
 */
export interface AuditDb {
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}

export interface AuditDeps {
  /** Injected clock for deterministic tests; defaults to the wall clock. */
  now?: () => number;
  /** When set (with `sessionId`): durably persist each record + hydrate prior entries on construction. */
  db?: AuditDb;
  /** The session this log belongs to — the FK + query scope for persistence. */
  sessionId?: string;
}

/** One persisted row (flattened entry). Metadata only — there is no raw-typed-text column to read back. */
interface AuditRow {
  seq: number;
  action: string;
  epoch: number;
  target_url: string | null;
  target_ref: string | null;
  target_direction: string | null;
  target_amount: number | null;
  outcome_ok: number;
  outcome_error_reason: string | null;
  outcome_chars_landed: number | null;
  risk: string | null;
  approval: string | null;
  ts: number;
}

/** Rebuild a frozen AuditEntry from a persisted row so a hydrated entry is indistinguishable from a freshly-recorded one (same shape, same freeze). */
function rowToEntry(r: AuditRow): AuditEntry {
  const target: NonNullable<AuditRecordInput['target']> = {};
  if (r.target_url != null) target.url = r.target_url;
  if (r.target_ref != null) target.ref = r.target_ref;
  if (r.target_direction != null) target.direction = r.target_direction as 'up' | 'down';
  if (r.target_amount != null) target.amount = r.target_amount;
  const outcome: AuditOutcome = r.outcome_ok
    ? { ok: true, ...(r.outcome_chars_landed != null ? { charsLanded: r.outcome_chars_landed } : {}) }
    : { ok: false, error_reason: r.outcome_error_reason ?? '', ...(r.outcome_chars_landed != null ? { charsLanded: r.outcome_chars_landed } : {}) };
  return Object.freeze({
    action: r.action,
    epoch: r.epoch,
    ...(Object.keys(target).length ? { target: Object.freeze(target) } : {}),
    outcome: Object.freeze(outcome),
    ...(r.risk != null ? { risk: r.risk as RiskTier } : {}),
    ...(r.approval != null ? { approval: r.approval as ApprovalDecision } : {}),
    seq: r.seq,
    ts: r.ts,
  });
}

export class SessionAuditLog {
  private readonly entries: AuditEntry[] = [];
  private seq = 0;
  private readonly now: () => number;
  private readonly db?: AuditDb;
  private readonly sessionId?: string;
  private readonly recordHandlers: Array<(entry: AuditEntry) => void> = [];

  constructor(deps: AuditDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.db = deps.db;
    this.sessionId = deps.sessionId;
    if (this.db && this.sessionId) this.hydrate();
  }

  /** Reconstruct the prior session sequence from the table (ordered by seq) — for display/forensics, never re-execution. */
  private hydrate(): void {
    const rows = this.db!.prepare(
      `SELECT seq, action, epoch, target_url, target_ref, target_direction, target_amount,
              outcome_ok, outcome_error_reason, outcome_chars_landed, risk, approval, ts
       FROM studio_audit WHERE session_id = ? ORDER BY seq ASC`,
    ).all(this.sessionId) as AuditRow[];
    for (const r of rows) {
      this.entries.push(rowToEntry(r));
      if (r.seq > this.seq) this.seq = r.seq;
    }
  }

  /** The sole audit writer: auto-seed the session (FK parent, idempotent) then INSERT the row. INSERT-only — never UPDATE/DELETE. */
  private persist(entry: AuditEntry): void {
    this.db!.prepare(`INSERT OR IGNORE INTO studio_sessions (id) VALUES (?)`).run(this.sessionId);
    this.db!.prepare(
      `INSERT INTO studio_audit
         (session_id, seq, action, epoch, target_url, target_ref, target_direction, target_amount,
          outcome_ok, outcome_error_reason, outcome_chars_landed, risk, approval, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      this.sessionId,
      entry.seq,
      entry.action,
      entry.epoch,
      entry.target?.url ?? null,
      entry.target?.ref ?? null,
      entry.target?.direction ?? null,
      entry.target?.amount ?? null,
      entry.outcome.ok ? 1 : 0,
      entry.outcome.ok ? null : entry.outcome.error_reason,
      entry.outcome.charsLanded ?? null,
      entry.risk ?? null,
      entry.approval ?? null,
      entry.ts,
    );
  }

  /** Append one agent action + outcome. Returns the stamped, frozen entry. */
  record(input: AuditRecordInput): AuditEntry {
    const entry: AuditEntry = Object.freeze({
      action: input.action,
      epoch: input.epoch,
      ...(input.target ? { target: Object.freeze({ ...input.target }) } : {}),
      outcome: Object.freeze({ ...input.outcome }),
      ...(input.risk ? { risk: input.risk } : {}),
      ...(input.approval ? { approval: input.approval } : {}),
      seq: ++this.seq,
      ts: this.now(),
    });
    this.entries.push(entry);
    if (this.db && this.sessionId) this.persist(entry);
    // 7d S2: notify-only — hand the SAME deeply-frozen entry to each subscriber (the host wires this to
    // hub.broadcast({t:'audit', <entry>}) for the live Phase-7 timeline). Mirrors controlToken.onChange:
    // a subscriber cannot mutate the log (frozen entry, no write-back path), it only observes.
    for (const cb of this.recordHandlers) cb(entry);
    return entry;
  }

  /** Subscribe to each recorded action (notify-only). The host wires this to a live {t:'audit'} broadcast. */
  onRecord(cb: (entry: AuditEntry) => void): void {
    this.recordHandlers.push(cb);
  }

  /** The full ordered session sequence — a fresh array of frozen entries (append-only: tampering the result cannot corrupt the log). */
  replay(): readonly AuditEntry[] {
    return [...this.entries];
  }

  /** Number of recorded actions. */
  get size(): number {
    return this.entries.length;
  }
}
