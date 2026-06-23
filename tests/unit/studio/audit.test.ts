import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SessionAuditLog, type AuditEntry } from '../../../src/studio/audit.js';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';

function migratedDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

/**
 * Phase 6b: a per-session APPEND-ONLY record of every agent action + its outcome, for
 * trust + replay (the Phase-7 timeline reads it). In-memory now (Phase 4 owns persistence).
 * The two load-bearing properties: it is append-only (no consumer can rewrite history) and
 * replay reconstructs the full ordered sequence.
 */
describe('SessionAuditLog — per-session append-only audit log', () => {
  it('record stamps a monotonic seq and the injected-clock timestamp, and returns the entry', () => {
    let t = 1000;
    const log = new SessionAuditLog({ now: () => t });
    const e1 = log.record({ action: 'navigate', epoch: 0, target: { url: 'https://x/' }, outcome: { ok: true } });
    t = 1500;
    const e2 = log.record({ action: 'click', epoch: 1, target: { ref: 'e1' }, outcome: { ok: false, error_reason: 'element_occluded' } });
    expect(e1.seq).toBe(1);
    expect(e1.ts).toBe(1000);
    expect(e2.seq).toBe(2); // monotonic, host-assigned
    expect(e2.ts).toBe(1500);
    expect(e1.action).toBe('navigate');
    expect(e2.outcome).toEqual({ ok: false, error_reason: 'element_occluded' });
  });

  it('replay returns every recorded action in append order — the full session sequence', () => {
    const log = new SessionAuditLog({ now: () => 0 });
    log.record({ action: 'navigate', epoch: 0, target: { url: 'https://a/' }, outcome: { ok: true } });
    log.record({ action: 'type', epoch: 0, target: { ref: 'e2' }, outcome: { ok: true, charsLanded: 5 } });
    log.record({ action: 'click', epoch: 1, target: { ref: 'e3' }, outcome: { ok: false, error_reason: 'not_holder' } });
    const seq = log.replay();
    expect(seq.map((e) => e.action)).toEqual(['navigate', 'type', 'click']);
    expect(seq.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(seq[1].outcome).toEqual({ ok: true, charsLanded: 5 });
  });

  it('is APPEND-ONLY: mutating the array returned by replay() cannot corrupt the log (replay hands out a copy)', () => {
    const log = new SessionAuditLog({ now: () => 0 });
    log.record({ action: 'navigate', epoch: 0, outcome: { ok: true } });
    const tamper = log.replay() as AuditEntry[]; // a malicious/buggy consumer tries to rewrite history
    tamper.pop();
    tamper.push({ seq: 999, ts: 0, action: 'forged', epoch: 0, outcome: { ok: true } });
    expect(log.replay().map((e) => e.action)).toEqual(['navigate']); // log unchanged
    expect(log.size).toBe(1);
  });

  it('is APPEND-ONLY: a recorded entry is DEEPLY frozen (entry + nested target + outcome) — a consumer cannot rewrite the outcome or target after the fact', () => {
    const log = new SessionAuditLog({ now: () => 0 });
    const e = log.record({ action: 'navigate', epoch: 0, target: { url: 'https://x/' }, outcome: { ok: false, error_reason: 'navigation_blocked' } });
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.outcome)).toBe(true); // the outcome cannot be flipped to ok:true after the fact — the load-bearing tamper-proof property
    expect(Object.isFrozen(e.target)).toBe(true); // the target (url/ref) cannot be rewritten either
    expect(Object.isFrozen(log.replay()[0])).toBe(true);
  });

  it('carries the Phase-6c risk tier + approval decision on a gated action (frozen); absent on an ungated one', () => {
    const log = new SessionAuditLog({ now: () => 0 });
    const gated = log.record({ action: 'click', epoch: 2, target: { ref: 'e9' }, outcome: { ok: true }, risk: 'money', approval: 'approved' });
    expect(gated.risk).toBe('money');
    expect(gated.approval).toBe('approved');
    expect(Object.isFrozen(gated)).toBe(true);
    // An ungated (safe) action records NO risk/approval — the keys are ABSENT, not undefined — so the
    // 6b exact-shape (`toEqual`) assertions for ordinary actions keep holding after this extension.
    const safe = log.record({ action: 'scroll', epoch: 2, outcome: { ok: true } });
    expect('risk' in safe).toBe(false);
    expect('approval' in safe).toBe(false);
  });

  it('size reflects the number of recorded actions and only grows', () => {
    const log = new SessionAuditLog();
    expect(log.size).toBe(0);
    log.record({ action: 'scroll', epoch: 0, target: { direction: 'down', amount: 600 }, outcome: { ok: true } });
    expect(log.size).toBe(1);
    log.record({ action: 'navigate', epoch: 0, outcome: { ok: false, error_reason: 'navigation_blocked' } });
    expect(log.size).toBe(2);
  });

  it('defaults to a real clock when none is injected', () => {
    const log = new SessionAuditLog();
    const e = log.record({ action: 'navigate', epoch: 0, outcome: { ok: true } });
    expect(typeof e.ts).toBe('number');
    expect(e.ts).toBeGreaterThan(0);
  });
});

describe('SessionAuditLog — durable persistence (Phase 6b)', () => {
  it('a recorded entry SURVIVES a fresh load from the DB, in order (durability, not in-memory)', () => {
    const db = migratedDb();
    const log1 = new SessionAuditLog({ db, sessionId: 'sess-A', now: () => 4242 });
    log1.record({ action: 'navigate', epoch: 0, target: { url: 'https://x/' }, outcome: { ok: true } });
    log1.record({ action: 'click', epoch: 1, target: { ref: 'e1' }, outcome: { ok: false, error_reason: 'element_occluded' } });

    // A FRESH log instance reading the SAME session from the DB — empty unless the entries persisted.
    const log2 = new SessionAuditLog({ db, sessionId: 'sess-A' });
    const seq = log2.replay();

    expect(seq.map((e) => e.action)).toEqual(['navigate', 'click']);
    expect(seq.map((e) => e.seq)).toEqual([1, 2]); // ordered by seq
    expect(seq[0].target).toEqual({ url: 'https://x/' });
    expect(seq[1].outcome).toEqual({ ok: false, error_reason: 'element_occluded' });
    db.close();
  });

  it('(c) append-only: exposes NO mutation API, and a fresh-hydrated replay is ordered + frozen', () => {
    const db = migratedDb();
    const log = new SessionAuditLog({ db, sessionId: 'sess-AO' });
    log.record({ action: 'navigate', epoch: 0, outcome: { ok: true } });
    log.record({ action: 'click', epoch: 1, target: { ref: 'e1' }, outcome: { ok: true } });
    // Structural append-only: no row-altering API on the audit store (instance or prototype).
    for (const m of ['update', 'delete', 'remove', 'clear', 'set', 'mutate']) {
      expect((log as unknown as Record<string, unknown>)[m]).toBeUndefined();
    }
    // A fresh hydrate over the persisted sequence is ordered + each entry frozen (tamper-proof).
    const fresh = new SessionAuditLog({ db, sessionId: 'sess-AO' });
    const seq = fresh.replay();
    expect(seq.map((e) => e.seq)).toEqual([1, 2]);
    expect(Object.isFrozen(seq[0])).toBe(true);
    expect(Object.isFrozen(seq[1])).toBe(true);
    db.close();
  });
});
