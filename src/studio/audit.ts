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

export class SessionAuditLog {
  private readonly entries: AuditEntry[] = [];
  private seq = 0;
  private readonly now: () => number;
  private readonly db?: AuditDb;
  private readonly sessionId?: string;

  constructor(deps: AuditDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.db = deps.db;
    this.sessionId = deps.sessionId;
    // GREEN wires hydrate-from-DB here.
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
    return entry;
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
