import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionAuditLog } from '../../../src/studio/audit.js';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { pruneStudioAudit } from '../../../src/companion/audit-retention.js';

/**
 * D9 — studio_audit retention prune. The forensic audit log is INSERT-only by construction
 * (src/studio/audit.ts: sole writer, no mutate/remove/clear). A SANCTIONED, operator-gated prune
 * is the ONE deletion path: a standalone fn in this NEW module, injected DB handle + an explicit
 * by-age cutoff. It mirrors the audit.ts injected-leaf pattern + the store.ts where-claused DELETE.
 * It is NOT a method on SessionAuditLog (that would make writer==pruner, breaking the append-only
 * invariant), and it is NOT reachable from any agent surface (operator-CLI-only).
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
    new SessionAuditLog({ db, sessionId: 'sess-1', now: () => 1000 }).record({ action: 'navigate', epoch: 0, outcome: { ok: true } }); // ancient
    new SessionAuditLog({ db, sessionId: 'sess-1', now: () => 9000 }).record({ action: 'click', epoch: 1, outcome: { ok: true } }); // newer
    expect(auditCount(db, 'sess-1')).toBe(2);

    const { deleted } = pruneStudioAudit(db, { cutoffMs: 5000 });

    expect(deleted).toBe(1);
    const rows = db.prepare('SELECT action, ts FROM studio_audit WHERE session_id = ?').all('sess-1') as { action: string; ts: number }[];
    expect(rows.map((r) => r.action)).toEqual(['click']); // the ts=9000 row survived; ts=1000 gone
    db.close();
  });

  it('the INSERT path is unaffected after a prune — appending still works (pin #4)', () => {
    const db = migratedDb();
    new SessionAuditLog({ db, sessionId: 'sess-1', now: () => 1000 }).record({ action: 'navigate', epoch: 0, outcome: { ok: true } });
    pruneStudioAudit(db, { cutoffMs: 5000 }); // removes the only row

    const fresh = new SessionAuditLog({ db, sessionId: 'sess-1', now: () => 9000 });
    fresh.record({ action: 'scroll', epoch: 2, outcome: { ok: true } });
    expect(auditCount(db, 'sess-1')).toBe(1);
    expect(fresh.entries().map((e) => e.action)).toEqual(['scroll']);
    db.close();
  });

  it('touches studio_audit rows ONLY — the studio_sessions parent survives (pin #7)', () => {
    const db = migratedDb();
    new SessionAuditLog({ db, sessionId: 'sess-1', now: () => 1000 }).record({ action: 'navigate', epoch: 0, outcome: { ok: true } });
    expect(sessionCount(db, 'sess-1')).toBe(1);

    pruneStudioAudit(db, { cutoffMs: 5000 }); // deletes the (only) audit row

    expect(auditCount(db, 'sess-1')).toBe(0);
    expect(sessionCount(db, 'sess-1')).toBe(1); // FK parent NOT deleted
    db.close();
  });

  it('fail-closed: a non-finite cutoff deletes NOTHING (never default to delete-all) (pin #6)', () => {
    const db = migratedDb();
    new SessionAuditLog({ db, sessionId: 'sess-1', now: () => 1000 }).record({ action: 'navigate', epoch: 0, outcome: { ok: true } });
    new SessionAuditLog({ db, sessionId: 'sess-1', now: () => 9000 }).record({ action: 'click', epoch: 1, outcome: { ok: true } });

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
  it('the agent tool surface (studio dispatch + studio tool registry) does NOT import audit-retention (pin #1)', () => {
    // operator-CLI-only: a confused-deputy / track-covering containment — no agent-reachable path can
    // delete forensic rows. mutation: add `import '../studio/audit-retention.js'` to studio-dispatch.ts
    // or tool-schemas.ts → it enters the closure → this REDS.
    const closure = importClosure([
      join(SRC, 'daemon/studio-dispatch.ts'),
      join(SRC, 'server/tool-schemas.ts'),
      join(SRC, 'server.ts'),
    ]);
    expect(closure.has(join(SRC, 'daemon/studio-dispatch.ts'))).toBe(true); // sanity: walked
    expect(closure.size).toBeGreaterThan(20);
    expect(closure.has(join(SRC, 'studio/audit-retention.ts'))).toBe(false);
  });

  it('audit-retention does NOT import the SessionAuditLog writer — shares only table-name + DB handle (pin #3)', () => {
    const closure = importClosure([join(SRC, 'studio/audit-retention.ts')]);
    expect(closure.has(join(SRC, 'studio/audit-retention.ts'))).toBe(true); // sanity: the module exists + was walked
    // mutation: add `import { SessionAuditLog } from './audit.js'` to audit-retention.ts → REDS.
    expect(closure.has(join(SRC, 'studio/audit.ts'))).toBe(false);
  });

  it('SessionAuditLog remains append-only — exposes NO row-altering method (pin #2; audit.ts :8-9 unchanged)', () => {
    const log = new SessionAuditLog();
    for (const m of ['update', 'delete', 'remove', 'clear', 'set', 'mutate', 'prune']) {
      // mutation: add a `remove`/`prune` method to SessionAuditLog → REDS (writer must never also delete).
      expect((log as unknown as Record<string, unknown>)[m]).toBeUndefined();
    }
  });

  /**
   * S13-0 — the flow sidecar is DERIVED from the audit and carries the same page URLs. Pruning the
   * source while the derivative survives would leave a readable shadow of exactly the rows the
   * operator asked to be gone, which is a privacy regression introduced by the sidecar's existence.
   */
  it('prunes the derived flow sidecar with the audit rows it was derived from', () => {
    const db = migratedDb();
    db.prepare('INSERT OR IGNORE INTO studio_sessions (id) VALUES (?)').run('sess-derived');
    new SessionAuditLog({ db, sessionId: 'sess-derived', now: () => 1000 }).record({ action: 'navigate', epoch: 0, outcome: { ok: true } });
    const ins = db.prepare(
      `INSERT INTO studio_flow_steps (flow_id, session_id, seq, audit_seq, action, page_url, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run('flw_old', 'sess-derived', 1, 1, 'navigate', 'https://example.com/orders?token=abc', 1000);
    ins.run('flw_new', 'sess-derived', 1, 2, 'navigate', 'https://example.com/orders?token=xyz', 9000);

    const result = pruneStudioAudit(db, { cutoffMs: 5000 });
    expect(result.deleted).toBe(1);
    expect(result.flowStepsDeleted).toBe(1);
    const left = db.prepare('SELECT flow_id, page_url FROM studio_flow_steps').all() as Array<{ flow_id: string; page_url: string }>;
    expect(left).toEqual([{ flow_id: 'flw_new', page_url: 'https://example.com/orders?token=xyz' }]);
  });

  it('a non-finite cutoff deletes no flow step either — fail-closed on both tables', () => {
    const db = migratedDb();
    db.prepare('INSERT OR IGNORE INTO studio_sessions (id) VALUES (?)').run('sess-nan');
    db.prepare(`INSERT INTO studio_flow_steps (flow_id, session_id, seq, audit_seq, action, ts) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('flw_x', 'sess-nan', 1, 1, 'navigate', 1000);
    const result = pruneStudioAudit(db, { cutoffMs: Number.NaN });
    expect(result).toEqual({ deleted: 0, flowStepsDeleted: 0 });
    expect((db.prepare('SELECT COUNT(*) c FROM studio_flow_steps').get() as { c: number }).c).toBe(1);
  });
});
