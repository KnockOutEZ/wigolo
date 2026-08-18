import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../../src/cache/migrations/runner.js';
import type { IndexJobInput } from '../../../../src/embedding/background-queue.js';
// P3 region-clip persist path — NOT written yet (reds on the missing export). A screenshot carries a
// PRE-COMPUTED PNG hash (the host hashes the bytes), so it must NOT route through captureFromPage's
// contentHashFor (single-source-of-truth for text-derived hashes) — hence its own insert path.
import {
  insertScreenshotArtifact,
  listSessionArtifacts,
  type ArtifactDelta,
} from '../../../../src/studio/capture/artifacts.js';

/**
 * P3 T4 — `insertScreenshotArtifact` pins:
 *  - the SAME credential choke as captureFromPage (a screenshot of a login page never persists);
 *  - trust-by-construction (content_trusted=0, no caller flag);
 *  - the caller-supplied PNG content_hash is stored verbatim (NOT recomputed);
 *  - mediaPath rides metadata (the DB stores a pointer; media lives on disk — §6);
 *  - dedup on the type-generic (normalized_url, 'screenshot', content_hash) index;
 *  - NO embed enqueue (an image has no prose to embed);
 *  - a screenshot IS a captured-panel type → onArtifact fires + listSessionArtifacts returns it.
 */
describe('studio/capture/artifacts — insertScreenshotArtifact (P3 region clip)', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-studio-p3-shot-'));
    db = new Database(join(dir, 'cache.db'));
    db.pragma('foreign_keys = ON');
    // ONE commit for the whole fixture — see the note in
    // tests/unit/cache/studio-artifacts-009-content-fts.test.ts. A bare
    // `new Database(<file>)` runs journal_mode=delete + synchronous=FULL, so the
    // runner's per-migration transactions cost 15 journal fsyncs per test; the outer
    // transaction demotes them to SAVEPOINTs. These cases assert what
    // insertScreenshotArtifact writes into the migrated schema, not how many
    // transactions produced it.
    db.transaction(() => { applyMigrations(db, { vecLoaded: false }); })();
  });
  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function mkDeps(over: Partial<{ credentialContext: { pageUrl?: string; fields?: never[] } }> = {}) {
    const jobs: IndexJobInput[] = [];
    const deltas: ArtifactDelta[] = [];
    return {
      jobs, deltas,
      deps: {
        db,
        enqueue: (j: IndexJobInput) => { jobs.push(j); },
        credentialContext: over.credentialContext ?? {},
        onArtifact: (d: ArtifactDelta) => { deltas.push(d); },
      },
    };
  }
  const rowById = (id: number) => db.prepare('SELECT * FROM studio_artifacts WHERE id = ?').get(id) as Record<string, unknown>;
  const rowCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM studio_artifacts').get() as { n: number }).n;

  const shot = { sessionId: 'sess', url: 'https://x.example/dashboard', title: 'chart', mediaPath: '/media/sess/abc.png', contentHash: 'abc123' };

  it('inserts an artifact_type=screenshot row, content_trusted=0, verbatim content_hash, mediaPath in metadata', () => {
    const { deps } = mkDeps();
    const r = insertScreenshotArtifact(shot, deps);
    expect(r.inserted).toBe(true);
    const row = rowById(r.id);
    expect(row.artifact_type).toBe('screenshot');
    expect(row.content_trusted).toBe(0);
    expect(row.content_hash).toBe('abc123'); // the PNG bytes' hash, stored NOT recomputed
    expect(row.url).toBe(shot.url);
    expect(row.title).toBe('chart');
    expect(JSON.parse(row.metadata as string)).toMatchObject({ mediaPath: '/media/sess/abc.png' });
  });

  it('dedups on repeat (same url + hash) — inserted:false, no second row', () => {
    const { deps } = mkDeps();
    const a = insertScreenshotArtifact(shot, deps);
    const b = insertScreenshotArtifact(shot, deps);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.id).toBe(a.id);
    expect(rowCount()).toBe(1);
  });

  it('REFUSES on a credential context (login URL) — throws CaptureRefusedError, no row (un-leakable)', () => {
    const { deps } = mkDeps({ credentialContext: { pageUrl: 'https://x.example/login' } });
    expect(() => insertScreenshotArtifact(shot, deps)).toThrow(/capture refused|credential/i);
    expect(rowCount()).toBe(0);
  });

  it('never enqueues an embed (an image has no prose) but DOES fire onArtifact on a real insert', () => {
    const { deps, jobs, deltas } = mkDeps();
    insertScreenshotArtifact(shot, deps);
    expect(jobs).toHaveLength(0);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ type: 'screenshot', title: 'chart', url: shot.url, trusted: false });
  });

  it('onArtifact does NOT fire on a dedup no-op', () => {
    const { deps, deltas } = mkDeps();
    insertScreenshotArtifact(shot, deps);
    insertScreenshotArtifact(shot, deps);
    expect(deltas).toHaveLength(1);
  });

  it('a screenshot IS a captured-panel item — listSessionArtifacts returns it', () => {
    const { deps } = mkDeps();
    insertScreenshotArtifact(shot, deps);
    const list = listSessionArtifacts(db, 'sess', 50);
    expect(list.some((a) => a.type === 'screenshot')).toBe(true);
  });
});
