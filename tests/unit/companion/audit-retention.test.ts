import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { pruneExpiredMemories, pruneStudioAudit } from '../../../src/companion/audit-retention.js';
import { seedAuditRow, seedFlowStep, seedSession } from '../../helpers/companion-tables.js';

/**
 * D9 — audit retention prune. The forensic audit log is INSERT-only by construction: its writer
 * is the companion's session audit log, which has no mutate/remove/clear. A SANCTIONED,
 * operator-gated prune is the ONE deletion path: a standalone fn in this module, injected DB handle
 * + an explicit by-age cutoff, NOT a method on the writer (that would make writer==pruner and break
 * the append-only invariant), and NOT reachable from any agent surface (operator-CLI-only).
 *
 * The writer moved to the companion with the domain layer, so the rows here are seeded directly —
 * which is also how the broker's callers write them after D8. What core still owns is the prune,
 * and that is what these pins are about.
 */

function migratedDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

function auditCount(db: Database.Database, sessionId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM studio_audit WHERE session_id = ?').get(sessionId) as { c: number }).c;
}
function sessionCount(db: Database.Database, id: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM studio_sessions WHERE id = ?').get(id) as { c: number }).c;
}

describe('pruneStudioAudit — by-age prune of the forensic audit log', () => {
  it('deletes ONLY rows older than the cutoff; newer rows survive (pin #4)', () => {
    const db = migratedDb();
    seedAuditRow(db, { sessionId: 'sess-1', seq: 1, action: 'navigate', ts: 1000 }); // ancient
    seedAuditRow(db, { sessionId: 'sess-1', seq: 2, action: 'click', epoch: 1, ts: 9000 }); // newer
    expect(auditCount(db, 'sess-1')).toBe(2);

    const { deleted } = pruneStudioAudit(db, { cutoffMs: 5000 });

    expect(deleted).toBe(1);
    const rows = db.prepare('SELECT action, ts FROM studio_audit WHERE session_id = ?').all('sess-1') as { action: string; ts: number }[];
    expect(rows.map((r) => r.action)).toEqual(['click']); // the ts=9000 row survived; ts=1000 gone
    db.close();
  });

  it('the INSERT path is unaffected after a prune — appending still works (pin #4)', () => {
    const db = migratedDb();
    seedAuditRow(db, { sessionId: 'sess-1', seq: 1, action: 'navigate', ts: 1000 });
    pruneStudioAudit(db, { cutoffMs: 5000 }); // removes the only row

    seedAuditRow(db, { sessionId: 'sess-1', seq: 2, action: 'scroll', epoch: 2, ts: 9000 });
    expect(auditCount(db, 'sess-1')).toBe(1);
    const rows = db.prepare('SELECT action FROM studio_audit WHERE session_id = ?').all('sess-1') as { action: string }[];
    expect(rows.map((r) => r.action)).toEqual(['scroll']);
    db.close();
  });

  it('touches studio_audit rows ONLY — the studio_sessions parent survives (pin #7)', () => {
    const db = migratedDb();
    seedAuditRow(db, { sessionId: 'sess-1', seq: 1, action: 'navigate', ts: 1000 });
    expect(sessionCount(db, 'sess-1')).toBe(1);

    pruneStudioAudit(db, { cutoffMs: 5000 }); // deletes the (only) audit row

    expect(auditCount(db, 'sess-1')).toBe(0);
    expect(sessionCount(db, 'sess-1')).toBe(1); // FK parent NOT deleted
    db.close();
  });

  it('fail-closed: a non-finite cutoff deletes NOTHING (never default to delete-all) (pin #6)', () => {
    const db = migratedDb();
    seedAuditRow(db, { sessionId: 'sess-1', seq: 1, action: 'navigate', ts: 1000 });
    seedAuditRow(db, { sessionId: 'sess-1', seq: 2, action: 'click', epoch: 1, ts: 9000 });

    expect(pruneStudioAudit(db, { cutoffMs: Number.NaN }).deleted).toBe(0);
    expect(pruneStudioAudit(db, { cutoffMs: Number.POSITIVE_INFINITY }).deleted).toBe(0);
    expect(auditCount(db, 'sess-1')).toBe(2); // both rows intact — no delete executed
    db.close();
  });
});

// ---- Structural seam pins (import-graph; mutation-validated, GREEN-on-arrival) ----

const SRC = resolve(fileURLToPath(new URL('../../../src', import.meta.url)));

function resolveRelativeImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, '');
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      readFileSync(cand);
      return cand;
    } catch {
      /* try next */
    }
  }
  return null;
}

function importClosure(entries: string[]): Set<string> {
  // A missing entry used to enter `seen` unread, so every "X is not in the closure" assertion below
  // passed for a file that had been deleted or moved. The walk must fail on that, not agree with it.
  for (const entry of entries) readFileSync(entry);
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
      const resolved = resolveRelativeImport(file, m[1]);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

describe('D9 retention — security seams (structural)', () => {
  it('the agent tool surface does NOT import audit-retention (pin #1)', () => {
    // operator-CLI-only: a confused-deputy / track-covering containment — no agent-reachable path can
    // delete forensic rows. mutation: add `import '../companion/audit-retention.js'` to server.ts or
    // tool-schemas.ts → it enters the closure → this REDS.
    const closure = importClosure([
      join(SRC, 'server.ts'),
      join(SRC, 'server/tool-schemas.ts'),
    ]);
    expect(closure.has(join(SRC, 'server.ts'))).toBe(true); // sanity: walked
    expect(closure.size).toBeGreaterThan(20);
    expect(closure.has(join(SRC, 'companion/audit-retention.ts'))).toBe(false);
  });

  it('audit-retention imports NOTHING — it shares a table name and a DB handle and no more (pin #3)', () => {
    // It used to be stated as "does not import the audit writer". That writer left core, and a pin
    // naming a module that cannot exist would be green forever. The stronger property was always
    // true and is what the containment actually rests on: the pruner reaches no other module, so
    // nothing it imports can drag a writer — or an agent-reachable surface — back in behind it.
    const closure = importClosure([join(SRC, 'companion/audit-retention.ts')]);
    expect([...closure]).toEqual([join(SRC, 'companion/audit-retention.ts')]);
  });

  /**
   * S13-0 — the flow sidecar is DERIVED from the audit and carries the same page URLs. Pruning the
   * source while the derivative survives would leave a readable shadow of exactly the rows the
   * operator asked to be gone, which is a privacy regression introduced by the sidecar's existence.
   */
  it('prunes the derived flow sidecar with the audit rows it was derived from', () => {
    const db = migratedDb();
    seedAuditRow(db, { sessionId: 'sess-derived', seq: 1, action: 'navigate', ts: 1000 });
    seedFlowStep(db, { flowId: 'flw_old', sessionId: 'sess-derived', seq: 1, auditSeq: 1, action: 'navigate', pageUrl: 'https://example.com/orders?token=abc', ts: 1000 });
    seedFlowStep(db, { flowId: 'flw_new', sessionId: 'sess-derived', seq: 1, auditSeq: 2, action: 'navigate', pageUrl: 'https://example.com/orders?token=xyz', ts: 9000 });

    const result = pruneStudioAudit(db, { cutoffMs: 5000 });
    expect(result.deleted).toBe(1);
    expect(result.flowStepsDeleted).toBe(1);
    const left = db.prepare('SELECT flow_id, page_url FROM studio_flow_steps').all() as Array<{ flow_id: string; page_url: string }>;
    expect(left).toEqual([{ flow_id: 'flw_new', page_url: 'https://example.com/orders?token=xyz' }]);
  });

  it('a non-finite cutoff deletes no flow step either — fail-closed on both tables', () => {
    const db = migratedDb();
    seedSession(db, 'sess-nan');
    seedFlowStep(db, { flowId: 'flw_x', sessionId: 'sess-nan', seq: 1, auditSeq: 1, action: 'navigate', ts: 1000 });
    const result = pruneStudioAudit(db, { cutoffMs: Number.NaN });
    expect(result).toEqual({ deleted: 0, flowStepsDeleted: 0 });
    expect((db.prepare('SELECT COUNT(*) c FROM studio_flow_steps').get() as { c: number }).c).toBe(1);
  });
});

/**
 * SD5 §6.1 — the expired-memory prune, the second sanctioned deletion site in this module.
 *
 * `studio_memories` rows carry an OPTIONAL absolute `expires_at`. Until this landed, expiry was
 * display-only: nothing ever removed an expired row, so a memory the user had scoped to a week
 * lived on disk forever. The prune is stated here rather than beside the memories CRUD for the
 * same reason the audit prune is: one deliberate deletion site, operator-reachable only.
 */
function seedMemory(
  db: Database.Database,
  row: { id: string; expiresAt: number | null; status?: string; text?: string },
): void {
  db.prepare(
    `INSERT INTO studio_memories (id, text, scope, scope_key, provenance, created_at, expires_at, status)
     VALUES (?, ?, 'global', NULL, 'user', 1000, ?, ?)`,
  ).run(row.id, row.text ?? `memory ${row.id}`, row.expiresAt, row.status ?? 'active');
}
function memoryIds(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM studio_memories ORDER BY id').all() as { id: string }[]).map((r) => r.id);
}

describe('pruneExpiredMemories — expiry prune of the studio memories store', () => {
  it('deletes ONLY the past-expiry row; a null expiry and a future expiry both survive', () => {
    const db = migratedDb();
    seedMemory(db, { id: 'forever', expiresAt: null }); // NULL = no expiry, the common case
    seedMemory(db, { id: 'future', expiresAt: 9000 });
    seedMemory(db, { id: 'past', expiresAt: 1000 });

    const { deleted } = pruneExpiredMemories(db, { nowMs: 5000 });

    expect(deleted).toBe(1);
    expect(memoryIds(db)).toEqual(['forever', 'future']);
    db.close();
  });

  it('is strict: a row expiring exactly at nowMs survives (the cutoff is not yet past)', () => {
    const db = migratedDb();
    seedMemory(db, { id: 'boundary', expiresAt: 5000 });

    expect(pruneExpiredMemories(db, { nowMs: 5000 }).deleted).toBe(0);
    expect(memoryIds(db)).toEqual(['boundary']);
    db.close();
  });

  it('fail-closed: a non-finite nowMs deletes NOTHING (a garbage clock must not delete everything)', () => {
    const db = migratedDb();
    seedMemory(db, { id: 'forever', expiresAt: null });
    seedMemory(db, { id: 'past', expiresAt: 1000 });

    expect(pruneExpiredMemories(db, { nowMs: Number.NaN }).deleted).toBe(0);
    expect(pruneExpiredMemories(db, { nowMs: Number.POSITIVE_INFINITY }).deleted).toBe(0);
    expect(memoryIds(db)).toEqual(['forever', 'past']); // both intact — no delete executed
    db.close();
  });

  it('does not special-case status: an expired ARCHIVED row goes with the rest', () => {
    // Expiry is orthogonal to status. Archiving is the user hiding a memory, not a reason to keep
    // its text on disk past the lifetime they gave it — the opposite reading would make archiving a
    // way to outlive your own expiry.
    const db = migratedDb();
    seedMemory(db, { id: 'archived-past', expiresAt: 1000, status: 'archived' });
    seedMemory(db, { id: 'archived-future', expiresAt: 9000, status: 'archived' });

    expect(pruneExpiredMemories(db, { nowMs: 5000 }).deleted).toBe(1);
    expect(memoryIds(db)).toEqual(['archived-future']);
    db.close();
  });

  it('touches studio_memories ONLY — audit rows of any age survive an expiry prune', () => {
    const db = migratedDb();
    seedAuditRow(db, { sessionId: 'sess-mem', seq: 1, action: 'navigate', ts: 1 });
    seedMemory(db, { id: 'past', expiresAt: 1000 });

    expect(pruneExpiredMemories(db, { nowMs: 5000 }).deleted).toBe(1);
    expect(auditCount(db, 'sess-mem')).toBe(1);
    db.close();
  });

  it('the statement it ships SEEKS the partial expiry index rather than scanning', () => {
    // Migration 019 ships `idx_studio_memories_expiry ... WHERE expires_at IS NOT NULL`. The
    // integration suite pins the plan for a bare `expires_at < ?`; the statement this module
    // actually runs carries the `IS NOT NULL` arm too, so the seek is pinned for THAT text.
    const db = migratedDb();
    const plan = db
      .prepare('EXPLAIN QUERY PLAN DELETE FROM studio_memories WHERE expires_at IS NOT NULL AND expires_at < ?')
      .all(5000) as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(' | ');

    expect(detail).toContain('idx_studio_memories_expiry');
    expect(detail).not.toContain('SCAN studio_memories');
    db.close();
  });
});
