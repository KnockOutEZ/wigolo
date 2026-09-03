import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { flowIdForSession, seedAuditRow, seedFlowStep } from '../../helpers/companion-tables.js';

/**
 * D9 — the operator-CLI entry for the audit prune: `wigolo config --prune-audit --older-than <dur> --yes`.
 * Behavioral pins run through the REAL CLI verb (runConfig), not the bare prune fn: this is the only
 * sanctioned deletion surface, so the confirm gate + explicit-cutoff requirement must hold AT the entry.
 * The DB handle is the process singleton (getDatabase); the test injects a migrated in-memory DB.
 */

let testDb: Database.Database;
vi.mock('../../../src/cache/db.js', () => ({ getDatabase: () => testDb }));

import { runConfig } from '../../../src/cli/config.js';

function migratedDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}
function auditCount(): number {
  return (testDb.prepare('SELECT COUNT(*) c FROM studio_audit WHERE session_id = ?').get('sess-1') as { c: number }).c;
}
function sessionCount(): number {
  return (testDb.prepare('SELECT COUNT(*) c FROM studio_sessions WHERE id = ?').get('sess-1') as { c: number }).c;
}

beforeEach(() => {
  testDb = migratedDb();
  // One ancient row (ts=1000 — far older than any cutoff) + one fresh row (ts≈now).
  seedAuditRow(testDb, { sessionId: 'sess-1', seq: 1, action: 'navigate', epoch: 0, ts: 1000 });
  seedAuditRow(testDb, { sessionId: 'sess-1', seq: 2, action: 'click', epoch: 1, ts: Date.now() });
});

describe('wigolo config --prune-audit (operator-CLI entry)', () => {
  it('with --older-than + --yes: deletes ONLY the aged row, parent session + fresh row survive (pins #4/#7)', async () => {
    const code = await runConfig(['--prune-audit', '--older-than', '1h', '--yes']);
    expect(code).toBe(0);
    expect(auditCount()).toBe(1); // only the ts=1000 row was older than now-1h
    const rows = testDb.prepare('SELECT action FROM studio_audit WHERE session_id = ?').all('sess-1') as { action: string }[];
    expect(rows.map((r) => r.action)).toEqual(['click']); // fresh row survived
    expect(sessionCount()).toBe(1); // studio_sessions parent NOT deleted (pin #7)
  });

  it('reports the recorded flow steps it deleted, not only the audit rows', async () => {
    // The prune deletes recorded flow steps alongside the audit rows. An operator who is told only
    // the audit count cannot tell how much of the recording surface the command just removed —
    // and the flow steps are the half that carries page URLs and element seeds.
    seedFlowStep(testDb, {
      flowId: flowIdForSession('sess-1'),
      sessionId: 'sess-1',
      seq: 1,
      auditSeq: 1,
      action: 'navigate',
      pageUrl: 'https://example.com/a',
      ts: 1000,
    });
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(await runConfig(['--prune-audit', '--older-than', '1h', '--yes'])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const out = written.join('');
    expect(out).toContain('1 studio audit row(s)');
    expect(out).toContain('1 recorded flow step(s)');
  });

  it('deletes the aged flow-step ROW and leaves the fresh one, not only the counts it printed', async () => {
    // EXTRACT C6: the sibling case above asserts the printed counts. A count is what the command
    // CLAIMS it removed; this case asserts the table afterwards, which is the only evidence that
    // the recorded page URLs actually left the machine — and that the cutoff applies to the flow
    // steps on their own timestamps rather than sweeping the whole flow because one step aged out.
    const flowId = flowIdForSession('sess-1');
    seedFlowStep(testDb, {
      flowId, sessionId: 'sess-1', seq: 1, auditSeq: 1,
      action: 'navigate', pageUrl: 'https://example.com/aged', ts: 1000,
    });
    seedFlowStep(testDb, {
      flowId, sessionId: 'sess-1', seq: 2, auditSeq: 2,
      action: 'click', pageUrl: 'https://example.com/fresh', ts: Date.now(),
    });

    expect(await runConfig(['--prune-audit', '--older-than', '1h', '--yes'])).toBe(0);

    const urls = (testDb
      .prepare('SELECT page_url FROM studio_flow_steps WHERE session_id = ? ORDER BY seq')
      .all('sess-1') as { page_url: string }[]).map((r) => r.page_url);
    expect(urls).toEqual(['https://example.com/fresh']);
  });

  it('fail-closed: WITHOUT --yes, nothing is deleted (pin #5)', async () => {
    const code = await runConfig(['--prune-audit', '--older-than', '1h']);
    expect(code).toBe(1);
    expect(auditCount()).toBe(2); // both rows intact — no confirm, no delete
  });

  it('fail-closed: WITHOUT --older-than, nothing is deleted — never default to delete-all (pin #6)', async () => {
    const code = await runConfig(['--prune-audit', '--yes']);
    expect(code).toBe(1);
    expect(auditCount()).toBe(2);
  });

  it('fail-closed: an invalid --older-than duration deletes nothing (pin #6)', async () => {
    const code = await runConfig(['--prune-audit', '--older-than', 'garbage', '--yes']);
    expect(code).toBe(1);
    expect(auditCount()).toBe(2);
  });
});
