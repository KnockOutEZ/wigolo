import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import {
  isStudioEmbedKey,
  makeStudioEmbedKey,
  RESEARCHABLE_TYPES,
} from '../../../src/companion-contract/artifact-keys.js';
import { studioArtifactProvider } from '../../../src/companion/artifact-provider.js';
import type { ArtifactRecord } from '../../../src/cache/artifact-registry.js';

/**
 * EXTRACT A5 — the companion artifact provider under D8 (dumb-broker) semantics.
 *
 * The provider is now the LAST public reader of `studio_artifacts`: the capture pipeline that writes
 * those rows leaves for the private package, so the two halves of this store will ship in different
 * repos on different release cadences. The only thing holding them together after that is
 * `companion-contract/artifact-keys.ts` — the key scheme, the researchable-type set and the trust
 * mapping — plus the column names of the migrated table.
 *
 * So every case below is seeded against the REAL migrated schema (`initDatabase` runs the migration
 * runner) and addressed through the REAL contract functions the write path calls. That is the point:
 * a column rename in a migration, or a change to the key scheme on either side, reds HERE rather than
 * silently returning zero artifacts to `cache`, `find_similar` and `research` in a shipped build —
 * the exact failure mode the old provider's source comment asked for a tripwire against.
 */

interface SeedRow {
  type: string;
  title: string | null;
  markdown: string | null;
  url?: string | null;
  contentTrusted: 0 | 1;
  curatedByHuman?: 0 | 1;
}

describe('companion/artifact-provider — reads studio_artifacts directly, keyed by the contract', () => {
  let dir: string;
  let db: Database.Database;
  let nextHash = 0;

  /** Insert one artifact row the way the capture pipeline does, and return its contract key. */
  function seed(row: SeedRow): { id: number; key: string } {
    db.prepare('INSERT OR IGNORE INTO studio_sessions (id) VALUES (?)').run('sess');
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO studio_artifacts
           (session_id, artifact_type, url, normalized_url, content_hash, fetched_at,
            created_at, title, markdown, metadata, content_trusted, curated_by_human)
         VALUES ('sess', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        row.type,
        row.url ?? null,
        row.url ?? null,
        `hash-${nextHash++}`,
        now,
        now,
        row.title,
        row.markdown,
        row.contentTrusted,
        row.curatedByHuman ?? 0,
      );
    const id = Number(info.lastInsertRowid);
    return { id, key: makeStudioEmbedKey(row.type, id) };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-a5-provider-'));
    db = initDatabase(join(dir, 'cache.db'));
    nextHash = 0;
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('hydrate', () => {
    it('resolves a seeded row and mirrors content_trusted onto trusted', () => {
      // The trust mapping IS the security property: a clip is page-derived, so its bytes are data and
      // never instructions, however useful they look. A provider that reported them trusted would hand
      // an agent an instruction channel straight out of the shared cache.
      const clip = seed({ type: 'clip', title: 'Pricing', markdown: '# Pricing\n$20/mo', url: 'https://example.com/pricing', contentTrusted: 0 });
      const note = seed({ type: 'note', title: null, markdown: 'remember the discount code', contentTrusted: 1 });

      const hydratedClip = studioArtifactProvider.hydrate(clip.key);
      expect(hydratedClip).not.toBeNull();
      expect(hydratedClip).toMatchObject({
        key: clip.key,
        type: 'clip',
        title: 'Pricing',
        markdown: '# Pricing\n$20/mo',
        trusted: false,
      });
      expect(typeof (hydratedClip as ArtifactRecord).fetchedAt).toBe('string');

      expect(studioArtifactProvider.hydrate(note.key)).toMatchObject({
        type: 'note',
        markdown: 'remember the discount code',
        trusted: true,
      });
    });

    it('never reports curated_by_human as trust', () => {
      // A human keeping a clip says the clip is USEFUL, not that the page that produced it is safe to
      // obey. Reading curation as trust is the one-line change that would quietly re-open the channel.
      const curated = seed({ type: 'clip', title: 'Kept', markdown: 'body', url: 'https://example.com/k', contentTrusted: 0, curatedByHuman: 1 });
      expect(studioArtifactProvider.hydrate(curated.key)?.trusted).toBe(false);
    });

    it('misses cleanly on a stale, forged or malformed key instead of throwing', () => {
      const clip = seed({ type: 'clip', title: 'T', markdown: 'b', url: 'https://example.com/x', contentTrusted: 0 });
      // A key whose type does not match the stored row addresses a DIFFERENT artifact than its scheme
      // claims — a stale key from before a re-capture, or a forged one. Answering it would let a
      // caller pull a row by guessing an id under a type it never had.
      expect(studioArtifactProvider.hydrate(makeStudioEmbedKey('note', clip.id))).toBeNull();
      expect(studioArtifactProvider.hydrate(makeStudioEmbedKey('clip', clip.id + 5000))).toBeNull();
      expect(studioArtifactProvider.hydrate('studio://clip|nope')).toBeNull();
      expect(studioArtifactProvider.hydrate('https://example.com/x')).toBeNull();
    });
  });

  describe('owns', () => {
    it('agrees with the contract predicate on every key shape, and claims no foreign key', () => {
      // `owns` is how the registry routes a key to a provider. If it drifted from the contract the
      // write path uses, captured artifacts would be routed to nobody (invisible) or this provider
      // would claim url_cache keys and answer null for them (a hole in the core read paths).
      const keys = [
        makeStudioEmbedKey('clip', 1),
        makeStudioEmbedKey('qa', 42),
        'studio://',
        'studio://mark|7',
        'https://example.com/page',
        'file:///tmp/x',
        '',
        'studio:/clip|1',
      ];
      for (const key of keys) {
        expect(studioArtifactProvider.owns(key), key).toBe(isStudioEmbedKey(key));
      }
      expect(studioArtifactProvider.owns('https://example.com/page')).toBe(false);
    });
  });

  describe('isResearchable', () => {
    const record = (type: string): ArtifactRecord => ({
      key: makeStudioEmbedKey(type, 1),
      type,
      title: 't',
      markdown: 'm',
      trusted: false,
      fetchedAt: new Date().toISOString(),
    });

    it('excludes a mark, which has no body to cite', () => {
      // A mark is a pointer at an element: it matches full-text on its title and carries null markdown,
      // so citing one would put a source in a research brief with nothing behind it.
      expect(studioArtifactProvider.isResearchable?.(record('mark'))).toBe(false);
      expect(studioArtifactProvider.isResearchable?.(record('screenshot'))).toBe(false);
    });

    it('admits exactly the contract\'s researchable set', () => {
      // The set is a contract value precisely so neither side can widen it locally — widening decides
      // what an already-captured corpus is worth.
      for (const type of RESEARCHABLE_TYPES) {
        expect(studioArtifactProvider.isResearchable?.(record(type)), type).toBe(true);
      }
    });
  });

  describe('searchKeys', () => {
    it('returns contract keys that hydrate — the read path end to end', () => {
      // searchKeys and hydrate are two SQL statements over two tables (the FTS index and the base
      // table). This is the case that fails if the FTS trigger, the rowid join or the key scheme moves.
      const clip = seed({ type: 'clip', title: 'Quarterly revenue', markdown: 'revenue grew by a third', url: 'https://example.com/q', contentTrusted: 0 });
      seed({ type: 'clip', title: 'Unrelated', markdown: 'nothing to see', url: 'https://example.com/u', contentTrusted: 0 });

      const keys = studioArtifactProvider.searchKeys('revenue', 10);
      expect(keys).toContain(clip.key);
      expect(studioArtifactProvider.hydrate(keys[0])?.type).toBe('clip');
    });

    it('answers empty for an empty query, a non-positive limit, and FTS-hostile input', () => {
      seed({ type: 'clip', title: 'Anything', markdown: 'body', url: 'https://example.com/a', contentTrusted: 0 });
      expect(studioArtifactProvider.searchKeys('', 10)).toEqual([]);
      expect(studioArtifactProvider.searchKeys('   ', 10)).toEqual([]);
      expect(studioArtifactProvider.searchKeys('body', 0)).toEqual([]);
      // Raw FTS5 syntax from a caller must not reach MATCH unescaped — it would throw out of a
      // read path whose contract is "no artifacts", never "query failed".
      expect(() => studioArtifactProvider.searchKeys('body OR "unbalanced', 5)).not.toThrow();
    });

    it('honours the limit', () => {
      for (let i = 0; i < 5; i++) {
        seed({ type: 'clip', title: `Report ${i}`, markdown: 'shared token report', url: `https://example.com/${i}`, contentTrusted: 0 });
      }
      expect(studioArtifactProvider.searchKeys('report', 2)).toHaveLength(2);
    });
  });

  it('names the surface, not the implementation', () => {
    expect(studioArtifactProvider.name).toBe('studio');
  });
});
