import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';

/**
 * Phase 4a — studio_artifacts migration, SCHEMA-ONLY REDs.
 *
 * These exercise the table's dedup unique-index shape + trust columns + NOT NULL
 * constraints + session linkage DIRECTLY via SQL with LITERAL content_hash values.
 * There is no production insert path and no hash helper yet — both, plus the
 * page→0 / human→1 app-path trust behavior and the hash type-namespacing
 * (hash(clip,X) != hash(mark,X)), get their OWN REDs in the slices that build
 * them (4b+). They are deliberately NOT pulled forward here.
 *
 * Until migration 008 lands, neither studio_sessions nor studio_artifacts exists,
 * so every case fails because the SCHEMA IS ABSENT ("no such table: …"), not
 * because of a test bug. The IntegrityError cases (1.4, 2.3, 3.1) message-match
 * the specific NOT NULL violation so that a bare "no such table" throw cannot
 * false-green a plain toThrow().
 *
 * SESSION LINKAGE (FK branch — CEO 2026-06-20): session_id is NOT NULL and the
 * sessions table is durable + planned at 008 (HANDOFF §3/§6: "sessions … with FK
 * relationships"; sessions are already first-class — class Session + SessionRegistry
 * + current.json). So the migration declares
 *   session_id TEXT NOT NULL REFERENCES studio_sessions(id)
 * Disqualifier checked: no session-less writer to studio_artifacts (the only
 * planned writers — host capture pipeline + studio_capture — are per-session;
 * research/find_similar/cache are READERS). foreign_keys is enabled here to match
 * production (db.ts) so the FK + the seed are actually enforced, and these REDs
 * seed a session row and reference it.
 *
 * Contract this RED imposes on the 008 migration (keeps the RED→GREEN diff clean):
 *   - studio_sessions is insertable with just (id) — other columns defaulted/nullable
 *     (the codebase's datetime('now')-default idiom, e.g. url_cache.created_at).
 *   - studio_artifacts.normalized_url is NULLABLE (url-less notes/qa) — unlike
 *     url_cache.normalized_url which is NOT NULL.
 *
 * Target unique-index shape (built next beat) — SYMMETRIC, artifact_type in BOTH
 * partial indexes; session_id is NOT in either (1.1/1.2 prove that):
 *   UNIQUE (normalized_url, artifact_type, content_hash) WHERE normalized_url IS NOT NULL
 *   UNIQUE (artifact_type, content_hash)                 WHERE normalized_url IS NULL
 * 1.3b (clip vs mark at the same url+hash → 2 rows) only goes green if the
 * url-bearing index carries artifact_type. Column order is free for uniqueness;
 * the url-bearing index leads with normalized_url so url-prefix reads hit it.
 */

const FETCHED_AT = '2026-06-19T00:00:00.000Z';

describe('migration 008_studio_artifacts — dedup index + trust columns + session linkage (schema-only RED)', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-studio-art-'));
    db = new Database(join(dir, 'cache.db'));
    // Match production (src/cache/db.ts) so the session FK is enforced and the
    // seed below is load-bearing rather than cosmetic.
    db.pragma('foreign_keys = ON');
    // ONE commit for the whole fixture — see the note in
    // studio-artifacts-009-content-fts.test.ts. A bare `new Database(<file>)` runs
    // journal_mode=delete + synchronous=FULL, so the runner's per-migration
    // transactions cost 15 journal fsyncs per test; the outer transaction demotes them
    // to SAVEPOINTs. Every case here asserts the SCHEMA the migrations leave behind,
    // not the number of transactions that produced it.
    db.transaction(() => { applyMigrations(db, { vecLoaded: false }); })();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Seed a durable session row so artifacts can reference it (FK branch).
  // studio_sessions is created by migration 008 (next beat); until then this
  // throws "no such table: studio_sessions" — a schema-absent RED, the right reason.
  // INSERT OR IGNORE so re-seeding the same id within a test is a no-op.
  function seedSession(id: string): void {
    db.prepare('INSERT OR IGNORE INTO studio_sessions (id) VALUES (?)').run(id);
  }

  // Test-local raw-SQL insert (NOT the production store path — that is 4b+).
  // normalized_url is set to `url` verbatim: there is no normalize helper this
  // beat, and identical literal urls must collide on the url-bearing index.
  // Optional columns use `'key' in row` so a key can be omitted (column absent →
  // its default/NULL) vs. supplied-as-null (explicit NULL, to fire NOT NULL).
  function insert(
    row: { type: string | null; url: string | null; hash: string | null; fetched?: string | null; session?: string | null; curated?: number | null; trusted?: number | null },
    opts: { ignore?: boolean } = {},
  ): void {
    const verb = opts.ignore ? 'INSERT OR IGNORE' : 'INSERT';
    const cols = ['artifact_type', 'url', 'normalized_url', 'content_hash', 'fetched_at'];
    const vals: Array<string | number | null> = [
      row.type, row.url, row.url, row.hash, 'fetched' in row ? (row.fetched ?? null) : FETCHED_AT,
    ];
    if ('session' in row) { cols.push('session_id'); vals.push(row.session ?? null); }
    if ('curated' in row) { cols.push('curated_by_human'); vals.push(row.curated ?? null); }
    if ('trusted' in row) { cols.push('content_trusted'); vals.push(row.trusted ?? null); }
    db.prepare(
      `${verb} INTO studio_artifacts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ).run(...vals);
  }

  const countByType = (type: string, hash: string): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM studio_artifacts WHERE artifact_type = ? AND content_hash = ?')
      .get(type, hash) as { n: number }).n;

  const totalForHash = (hash: string): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM studio_artifacts WHERE content_hash = ?')
      .get(hash) as { n: number }).n;

  describe('RED-1 dedup / unique index (literal content_hash)', () => {
    it('1.1 url-less: identical (note, NULL url, h1) under DIFFERENT sessions dedups to one row', () => {
      // Distinct session_ids on the two inserts — still one row proves session_id
      // is NOT part of the dedup key (the url-less index is (artifact_type, content_hash)).
      seedSession('sess-A');
      seedSession('sess-B');
      insert({ type: 'note', url: null, hash: 'h1', session: 'sess-A' }, { ignore: true });
      insert({ type: 'note', url: null, hash: 'h1', session: 'sess-B' }, { ignore: true });
      expect(countByType('note', 'h1')).toBe(1);
    });

    it('1.2 url-bearing: identical (clip, https://x/a, h2) under DIFFERENT sessions dedups to one row', () => {
      // Same proof for the url-bearing index: session_id is not a dedup discriminator.
      seedSession('sess-A');
      seedSession('sess-B');
      insert({ type: 'clip', url: 'https://x/a', hash: 'h2', session: 'sess-A' }, { ignore: true });
      insert({ type: 'clip', url: 'https://x/a', hash: 'h2', session: 'sess-B' }, { ignore: true });
      expect(countByType('clip', 'h2')).toBe(1);
    });

    it('1.3a url-less cross-type: (note,NULL,h3) + (qa,NULL,h3) stay two rows', () => {
      seedSession('sess-1');
      insert({ type: 'note', url: null, hash: 'h3', session: 'sess-1' }, { ignore: true });
      insert({ type: 'qa', url: null, hash: 'h3', session: 'sess-1' }, { ignore: true });
      expect(countByType('note', 'h3')).toBe(1);
      expect(countByType('qa', 'h3')).toBe(1);
      expect(totalForHash('h3')).toBe(2);
    });

    it('1.3b url-bearing cross-type: (clip,https://x/a,h4) + (mark,https://x/a,h4) stay two rows', () => {
      // Pins artifact_type INTO the url-bearing partial index (the symmetric shape).
      seedSession('sess-1');
      insert({ type: 'clip', url: 'https://x/a', hash: 'h4', session: 'sess-1' }, { ignore: true });
      insert({ type: 'mark', url: 'https://x/a', hash: 'h4', session: 'sess-1' }, { ignore: true });
      expect(countByType('clip', 'h4')).toBe(1);
      expect(countByType('mark', 'h4')).toBe(1);
      expect(totalForHash('h4')).toBe(2);
    });

    it('1.4 content_hash NOT NULL: insert with hash=NULL raises an integrity error', () => {
      // Seed + insert BOTH inside the closure so the RED-state failure ("no such
      // table") is surfaced THROUGH the matcher (which rejects it), and a valid
      // session means the NOT NULL that fires in GREEN is content_hash — not
      // session_id and not the FK.
      expect(() => {
        seedSession('sess-1');
        insert({ type: 'note', url: null, hash: null, session: 'sess-1' });
      }).toThrow(/NOT NULL constraint failed: studio_artifacts\.content_hash/);
    });

    it('1.5 partition independence: url-less + url-bearing with same (type, hash) stay two rows', () => {
      // The two partial indexes cover disjoint partitions (normalized_url NULL vs
      // NOT NULL), so a url-less note and a url-bearing note that share
      // (artifact_type, content_hash) do NOT collide — guards the idx_nourl WHERE.
      seedSession('sess-1');
      insert({ type: 'note', url: null, hash: 'h12', session: 'sess-1' }, { ignore: true });
      insert({ type: 'note', url: 'https://x/b', hash: 'h12', session: 'sess-1' }, { ignore: true });
      expect(totalForHash('h12')).toBe(2);
    });
  });

  describe('RED-2 trust columns / schema', () => {
    it('2.1 curated_by_human + content_trusted exist as INTEGER NOT NULL DEFAULT 0', () => {
      const cols = db.prepare("PRAGMA table_info('studio_artifacts')").all() as Array<{
        name: string; type: string; notnull: number; dflt_value: string | null;
      }>;
      for (const name of ['curated_by_human', 'content_trusted']) {
        const col = cols.find((c) => c.name === name);
        expect(col, `column ${name} must exist`).toBeDefined();
        expect(col!.type).toBe('INTEGER');
        expect(col!.notnull).toBe(1);
        expect(col!.dflt_value).toBe('0');
      }
    });

    it('2.2 fail-safe default: a row specifying neither trust col reads both 0', () => {
      // Supplies everything (incl. session_id) EXCEPT the two trust cols, so the
      // assertion proves their DEFAULT 0 — not a session_id NOT NULL failure.
      seedSession('sess-1');
      insert({ type: 'clip', url: 'https://x/a', hash: 'h5', session: 'sess-1' });
      const row = db.prepare(
        'SELECT curated_by_human, content_trusted FROM studio_artifacts WHERE content_hash = ?',
      ).get('h5') as { curated_by_human: number; content_trusted: number };
      expect(row.curated_by_human).toBe(0);
      expect(row.content_trusted).toBe(0);
    });

    it('2.3 trust cols NOT NULL: explicit NULL into either raises an integrity error', () => {
      // Valid session in each closure → the NOT NULL that fires is the trust col.
      expect(() => {
        seedSession('sess-1');
        insert({ type: 'note', url: null, hash: 'h6', session: 'sess-1', curated: null });
      }).toThrow(/NOT NULL constraint failed: studio_artifacts\.curated_by_human/);
      expect(() => {
        seedSession('sess-1');
        insert({ type: 'note', url: null, hash: 'h7', session: 'sess-1', trusted: null });
      }).toThrow(/NOT NULL constraint failed: studio_artifacts\.content_trusted/);
    });
  });

  describe('RED-3 session linkage — every artifact has an origin', () => {
    it('3.1 session_id NOT NULL: insert omitting session_id raises an integrity error', () => {
      // Pins the firm CEO decision (session_id NOT NULL). Without this, a migration
      // that left session_id nullable would pass every other RED (they all supply a
      // session). Omitting session entirely → session_id NULL → NOT NULL fires
      // before the FK is evaluated. Message-matched so the RED-state "no such table"
      // cannot false-green.
      expect(() => insert({ type: 'note', url: null, hash: 'h8' })).toThrow(
        /NOT NULL constraint failed: studio_artifacts\.session_id/,
      );
    });

    it('3.2 FK referential: a session_id absent from studio_sessions raises a FK error', () => {
      // NO seedSession — reference an id that doesn't exist. session_id is non-null
      // (its NOT NULL is satisfied) and every other NOT NULL col is valid, so the
      // ONLY violation is the dangling foreign key. Also proves foreign_keys is
      // actually ON in the harness — with it OFF this insert would silently succeed.
      expect(() => insert({ type: 'note', url: null, hash: 'h9', session: 'ghost-session' })).toThrow(
        /FOREIGN KEY constraint failed/,
      );
    });
  });

  describe('RED-4 core column NOT NULL', () => {
    // 2.1's PRAGMA asserts notnull only on the trust cols — artifact_type and
    // fetched_at are unchecked there, so they get their own behavioral pins. Each
    // supplies a valid session + every other NOT NULL col, so the only violation
    // is the intended one.
    it('4.1 artifact_type NOT NULL: insert with artifact_type=NULL raises an integrity error', () => {
      expect(() => {
        seedSession('sess-1');
        insert({ type: null, url: null, hash: 'h10', session: 'sess-1' });
      }).toThrow(/NOT NULL constraint failed: studio_artifacts\.artifact_type/);
    });

    it('4.2 fetched_at NOT NULL: insert with fetched_at=NULL raises an integrity error', () => {
      expect(() => {
        seedSession('sess-1');
        insert({ type: 'note', url: null, hash: 'h11', session: 'sess-1', fetched: null });
      }).toThrow(/NOT NULL constraint failed: studio_artifacts\.fetched_at/);
    });
  });
});
