/**
 * D9 — the SANCTIONED retention prune for the studio_audit forensic log.
 *
 * The audit log (src/studio/audit.ts) is INSERT-only by construction: SessionAuditLog is the sole
 * writer and exposes no mutate/remove/clear method, so session history can never be rewritten in
 * the normal path. Retention needs ONE deliberate deletion site — this module. It is a standalone
 * leaf (no SessionAuditLog import; shares only the table name + an injected DB handle) so the
 * writer's append-only contract stays intact, and it is reachable ONLY from the operator CLI verb
 * (`wigolo config --prune-audit`), never from any agent-facing studio_* tool.
 *
 * Predicate: BY AGE. The caller passes an explicit absolute cutoff; rows with `ts` strictly older
 * than the cutoff are deleted. Fail-closed: a non-finite cutoff deletes NOTHING — a missing/garbage
 * cutoff must never collapse to delete-all.
 *
 * S13 widened the scope from studio_audit alone to studio_audit PLUS the flow sidecar derived from
 * it — see the note on `pruneStudioAudit`. It still imports no writer and still deletes no session.
 */

/** The narrow DB surface this prune writes through — a real better-sqlite3 Database satisfies it. */
export interface RetentionDb {
  prepare(sql: string): { run(...args: unknown[]): { changes: number } };
}

/** The result of a prune: how many audit rows, and how many derived flow steps, were deleted. */
export interface PruneResult {
  deleted: number;
  /** S13: rows removed from the derived flow sidecar in the same pass. */
  flowStepsDeleted: number;
}

/**
 * Delete studio_audit rows strictly older than `cutoffMs`, AND the flow-sidecar steps of the same
 * age. Returns both counts. A non-finite cutoff is rejected (fail-closed) — it deletes nothing
 * rather than everything. The studio_sessions parent is never deleted.
 *
 * WHY THE SIDECAR GOES WITH IT, despite this module having been audit-only. `studio_flow_steps`
 * is DERIVED from the audit and carries the same navigate URLs. Pruning the source while the
 * derivative survives would leave a readable shadow of exactly the rows the operator asked to be
 * gone — a privacy regression that arrives with the sidecar rather than existing before it. A
 * derived record must not outlive its source, and the only place that can be guaranteed is the
 * one sanctioned deletion site.
 */
export function pruneStudioAudit(db: RetentionDb, opts: { cutoffMs: number }): PruneResult {
  if (!Number.isFinite(opts.cutoffMs)) return { deleted: 0, flowStepsDeleted: 0 };
  const audit = db.prepare('DELETE FROM studio_audit WHERE ts < ?').run(opts.cutoffMs);
  const flow = db.prepare('DELETE FROM studio_flow_steps WHERE ts < ?').run(opts.cutoffMs);
  return { deleted: audit.changes, flowStepsDeleted: flow.changes };
}

/** The result of an expiry prune: how many studio_memories rows were deleted. */
export interface MemoryPruneResult {
  deleted: number;
}

/**
 * SD5 §6.1 — delete `studio_memories` rows whose absolute `expires_at` is already in the past at
 * `nowMs`. Rows with no expiry (`expires_at IS NULL` — the common case) and rows whose expiry is
 * still ahead both survive. Fail-closed on a non-finite clock: it deletes nothing rather than
 * everything, matching `pruneStudioAudit`.
 *
 * It sits HERE, beside the audit prune, under the same rules: a standalone leaf that imports no
 * writer, shares only a table name and an injected handle, and is reachable only from the operator
 * CLI verb (`wigolo config --prune-memories`). The memories store is otherwise written through the
 * companion broker, which has no expiry-sweep op — so this is the one place a memory row is removed
 * for having outlived the lifetime the user gave it, and it is a deliberate operator action.
 *
 * The `expires_at IS NOT NULL` arm is redundant against SQL's three-valued logic (`NULL < ?` is
 * never true, so a no-expiry row is already safe from a bare comparison), and it is kept anyway:
 * it is the text of migration 019's partial index `idx_studio_memories_expiry`, so the statement
 * reads as the index it seeks, and the "NULL means forever" intent is stated at the deletion site
 * instead of resting on a reader knowing the three-valued rule.
 *
 * Status is deliberately NOT in the predicate. Expiry is orthogonal to archiving: an archived row
 * whose expiry has passed goes with the rest, because the opposite reading would make archiving a
 * way for a memory to outlive the lifetime it was given.
 */
export function pruneExpiredMemories(db: RetentionDb, opts: { nowMs: number }): MemoryPruneResult {
  if (!Number.isFinite(opts.nowMs)) return { deleted: 0 };
  const res = db
    .prepare('DELETE FROM studio_memories WHERE expires_at IS NOT NULL AND expires_at < ?')
    .run(opts.nowMs);
  return { deleted: res.changes };
}
