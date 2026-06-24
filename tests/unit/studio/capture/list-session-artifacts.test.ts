import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../../src/cache/migrations/runner.js';
import {
  captureFromPage,
  captureHumanNote,
  listSessionArtifacts,
  type ArtifactDelta,
  type PageCapture,
} from '../../../../src/studio/capture/artifacts.js';

/**
 * Phase 7e S2 — listSessionArtifacts: the post-hello captured-items backfill read. Generalizes
 * listSessionComments to the captured panel scope (artifact_type NOT IN note/mark), session-scoped,
 * light projection, most-recent `limit`.
 *
 * VALUE-FLIP PINS (R2-hardened). Each pin below is mutation-verified against the PRESENT, correct
 * function — applying ONLY its named mutation REDs the test with the diverging values shown, so none can
 * pass vacuously. (The original 7e-S2 RED at 6cf66c2 failed on module-absence — the function did not yet
 * exist — NOT on a value flip; these assertions are the genuine pins that history's RED only stood in for.)
 *
 *  PIN-B  ISOLATION   — WHERE session_id is the boundary. Mutation: widen `session_id = ?` → `(… OR 1=1)`
 *                       ⇒ a foreign session's clip leaks ⇒ ['/1','/2'] ≠ ['/1'].
 *  PIN-C  TYPE FILTER — NOT IN (note,mark). Mutation: drop the filter ⇒ note+mark leak ⇒
 *                       ['clip','mark','note','qa'] ≠ ['clip','qa'].
 *  PIN-D  CAP         — most-recent `limit` via slice(-limit). TWO independent mutations:
 *                       slice(0,limit) ⇒ count holds 200 but boundary item[0] '/1' ≠ '/51';
 *                       slice(0) ⇒ count 250 ≠ 200. Test asserts BOTH count and boundary, so each REDs it.
 *  PIN-E  LIGHT proj  — {id,type,title,url,trusted,created_at} only. Mutation: add `markdown` to SELECT+map
 *                       ⇒ body leaks ⇒ markdown:'body 7' ≠ undefined and keys gain `markdown`.
 */

const deps = (db: Database.Database) => ({ db, enqueue: () => undefined, credentialContext: {} as const });

function clip(db: Database.Database, sessionId: string, n: number) {
  captureFromPage({ type: 'clip', sessionId, url: `https://x.example/${n}`, title: `clip ${n}`, markdown: `body ${n}` }, deps(db));
}
function mark(db: Database.Database, sessionId: string): PageCapture {
  return {
    type: 'mark',
    sessionId,
    url: 'https://x.example/m',
    target: { role: 'button', name: 'Buy', ancestorPath: 'html/body/button', fingerprint: 'fp', attrs: {} },
  };
}

describe('studio/capture/listSessionArtifacts — Phase 7e S2 (value-flip pins, R2-hardened)', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-studio-7e-s2-'));
    db = new Database(join(dir, 'cache.db'));
    db.pragma('foreign_keys = ON');
    applyMigrations(db, { vecLoaded: false });
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ─── PIN-B — session isolation ───────────────────────────────────────────────
  it('B: returns ONLY this session\'s captured items (WHERE session_id)', () => {
    clip(db, 'mine', 1);
    clip(db, 'theirs', 2); // a foreign session's clip in the SAME db
    const items = listSessionArtifacts(db, 'mine', 200);
    expect(items.map((i) => i.url)).toEqual(['https://x.example/1']); // 'theirs' must not leak
  });

  // ─── PIN-C — type filter (note + mark excluded) ──────────────────────────────
  it('C: excludes notes and marks (NOT IN note,mark) — only clip/qa', () => {
    clip(db, 'sess', 1);
    captureHumanNote({ sessionId: 'sess', text: 'a note' }, deps(db));      // note → comments panel
    captureFromPage(mark(db, 'sess'), deps(db));                            // mark → marks panel
    captureFromPage({ type: 'qa', sessionId: 'sess', question: 'q', answer: 'a' }, deps(db));
    const types = listSessionArtifacts(db, 'sess', 200).map((i) => i.type).sort();
    expect(types).toEqual(['clip', 'qa']); // note + mark filtered out
  });

  // ─── PIN-D — cap = most-recent `limit` ───────────────────────────────────────
  it('D: with >limit captured items returns EXACTLY the most-recent limit (slice(-limit))', () => {
    for (let i = 1; i <= 250; i++) clip(db, 'sess', i);
    const items = listSessionArtifacts(db, 'sess', 200);
    expect(items.length).toBe(200);                       // capped (unbounded → 250, RED)
    expect(items[0].url).toBe('https://x.example/51');    // most-recent 200 = 51..250 (oldest slice(0,200) → 1, RED)
    expect(items[199].url).toBe('https://x.example/250');
  });

  // ─── PIN-E — light projection (no markdown body) ─────────────────────────────
  it('E: each item is the light projection {id,type,title,url,trusted,created_at} — no markdown body', () => {
    clip(db, 'sess', 7);
    const [item] = listSessionArtifacts(db, 'sess', 200);
    expect(item.type).toBe('clip');
    expect(item.title).toBe('clip 7');
    expect(item.url).toBe('https://x.example/7');
    expect(item.trusted).toBe(false); // clip is page-derived
    expect(typeof item.created_at).toBe('string');
    expect(item.created_at).not.toBe('');
    expect((item as unknown as Record<string, unknown>).markdown).toBeUndefined();
    expect(Object.keys(item).sort()).toEqual(['created_at', 'id', 'title', 'trusted', 'type', 'url'] satisfies (keyof ArtifactDelta)[]);
  });
});
