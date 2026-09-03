import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';

/**
 * SD5 §6.1 — the operator-CLI entry for the memories expiry prune:
 * `wigolo config --prune-memories --yes`. Like `--prune-audit`, the behavioural pins run through
 * the REAL verb rather than the bare prune fn, because the verb IS the containment: this is the
 * only sanctioned way a memory row is deleted for having outlived its expiry, so the confirm gate
 * has to hold at the entry and not merely in a function nobody is forced to call correctly.
 *
 * It takes NO --older-than. The audit prune is by AGE and so needs an explicit cutoff to avoid
 * defaulting to delete-all; expiry is an ABSOLUTE per-row lifetime the user already chose, so the
 * only cutoff this verb could have is "now". Accepting --older-than here would be inventing a
 * retention policy, which is an explicit non-goal.
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
function seedMemory(id: string, expiresAt: number | null, status = 'active'): void {
  testDb
    .prepare(
      `INSERT INTO studio_memories (id, text, scope, scope_key, provenance, created_at, expires_at, status)
       VALUES (?, ?, 'global', NULL, 'user', 1000, ?, ?)`,
    )
    .run(id, `memory ${id}`, expiresAt, status);
}
function memoryIds(): string[] {
  return (testDb.prepare('SELECT id FROM studio_memories ORDER BY id').all() as { id: string }[]).map((r) => r.id);
}
async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const written: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  try {
    return { code: await runConfig(argv), out: written.join('') };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  testDb = migratedDb();
  seedMemory('forever', null); // no expiry — the common case
  seedMemory('future', Date.now() + 3_600_000);
  seedMemory('past', Date.now() - 3_600_000);
});

describe('wigolo config --prune-memories (operator-CLI entry)', () => {
  it('with --yes: deletes ONLY the already-expired row and reports the count', async () => {
    const { code, out } = await capture(['--prune-memories', '--yes']);
    expect(code).toBe(0);
    expect(memoryIds()).toEqual(['forever', 'future']);
    expect(out).toContain('1 expired studio memory row(s)');
  });

  it('fail-closed: WITHOUT --yes, nothing is deleted', async () => {
    const code = await runConfig(['--prune-memories']);
    expect(code).toBe(1);
    expect(memoryIds()).toEqual(['forever', 'future', 'past']);
  });

  it('refuses --older-than instead of quietly ignoring it — this verb has no age policy', async () => {
    // Silently accepting it would let an operator believe they had scoped the delete by age while
    // every expired row went, whatever its age.
    const code = await runConfig(['--prune-memories', '--older-than', '30d', '--yes']);
    expect(code).toBe(1);
    expect(memoryIds()).toEqual(['forever', 'future', 'past']);
  });

  it('refuses to run beside --prune-audit rather than silently doing only one of them', async () => {
    // No --older-than here on purpose: with one, the age-policy refusal above would answer first
    // and this pin would pass whether or not the both-flags refusal exists.
    const code = await runConfig(['--prune-audit', '--prune-memories', '--yes']);
    expect(code).toBe(1);
    expect(memoryIds()).toEqual(['forever', 'future', 'past']);
    // and the audit half did not run either — the refusal is before any deletion
    expect((testDb.prepare('SELECT COUNT(*) c FROM studio_audit').get() as { c: number }).c).toBe(0);
  });

  it('reports zero without failing when nothing has expired yet', async () => {
    testDb.prepare('DELETE FROM studio_memories WHERE id = ?').run('past');
    const { code, out } = await capture(['--prune-memories', '--yes']);
    expect(code).toBe(0);
    expect(out).toContain('0 expired studio memory row(s)');
    expect(memoryIds()).toEqual(['forever', 'future']);
  });
});
