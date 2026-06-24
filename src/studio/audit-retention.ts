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
 */

/** The narrow DB surface this prune writes through — a real better-sqlite3 Database satisfies it. */
export interface RetentionDb {
  prepare(sql: string): { run(...args: unknown[]): { changes: number } };
}

/** The result of a prune: how many audit rows were deleted. */
export interface PruneResult {
  deleted: number;
}

/**
 * Delete studio_audit rows strictly older than `cutoffMs`. Returns the number deleted.
 * A non-finite cutoff is rejected (fail-closed) — it deletes nothing rather than everything.
 * Touches studio_audit ONLY; the studio_sessions parent is never deleted.
 */
export function pruneStudioAudit(db: RetentionDb, opts: { cutoffMs: number }): PruneResult {
  if (!Number.isFinite(opts.cutoffMs)) return { deleted: 0 };
  const info = db.prepare('DELETE FROM studio_audit WHERE ts < ?').run(opts.cutoffMs);
  return { deleted: info.changes };
}
