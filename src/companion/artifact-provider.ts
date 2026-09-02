/**
 * The captured-artifact store as an `ArtifactProvider` — the companion half of the shared knowledge
 * store, and the ONE place the studio side of it is named in public core.
 *
 * D8 (dumb broker): this reads the `studio_artifacts` table DIRECTLY. It projects rows into the
 * registry's provider-agnostic record and does nothing else — no domain shaping, no capture
 * knowledge. The pipeline that WRITES these rows lives in the extracted domain layer and ships in a
 * different package, so this file must not reach into it: an import there would be the coupling the
 * split exists to remove, and would take core's three read paths (`cache`, `find_similar`,
 * `research`) down with it the moment that layer leaves.
 *
 * What survives the split as the shared agreement between the two halves is exactly two things: the
 * migrated table's columns, and `companion-contract/artifact-keys.ts` — the `studio://<type>|<id>`
 * scheme, the researchable-type set and the trust mapping. Both sides import the contract; neither
 * keeps a copy. `tests/unit/companion/artifact-provider.test.ts` seeds the real migrated schema and
 * addresses it through the real contract functions, so a drift in either reds there rather than
 * quietly returning nothing to an agent.
 *
 * The persisted scheme is FROZEN: those keys are already written into the shared vector store and
 * `index_jobs` for every artifact on disk, so renaming it would orphan the existing corpus.
 */
import {
  isResearchableArtifactType,
  isStudioEmbedKey,
  makeStudioEmbedKey,
  parseStudioEmbedKey,
} from '../companion-contract/artifact-keys.js';
import { getDatabase } from '../cache/db.js';
import { sanitizeFtsQuery } from '../cache/store.js';
import type { ArtifactProvider, ArtifactRecord } from '../cache/artifact-registry.js';

/**
 * The provider id, and therefore the `source` / `engines` value an agent reads on a captured row. It
 * names the SURFACE the row came from, which is what an agent needs in order to weigh it against a
 * fetched page.
 */
export const STUDIO_ARTIFACT_PROVIDER = 'studio';

interface ArtifactRow {
  id: number;
  artifact_type: string;
  title: string | null;
  markdown: string | null;
  content_trusted: number;
  fetched_at: string;
}

/**
 * Resolve a key to its row BY ID — never by constructing a URL from the key (the `|` separator makes
 * it deliberately non-url-parseable, which is what lets the read paths branch on key shape before any
 * url hydration). The stored type must match the type the key claims: a mismatch is a stale key from
 * before a re-capture, or a forged one addressing a row under a type it never had, and both are a
 * clean miss rather than a row.
 */
function selectArtifact(key: string): ArtifactRow | null {
  const parts = parseStudioEmbedKey(key);
  if (!parts) return null;
  const row = getDatabase()
    .prepare(
      `SELECT id, artifact_type, title, markdown, content_trusted, fetched_at
       FROM studio_artifacts WHERE id = ?`,
    )
    .get(parts.id) as ArtifactRow | undefined;
  if (!row || row.artifact_type !== parts.type) return null;
  return row;
}

export const studioArtifactProvider: ArtifactProvider = {
  name: STUDIO_ARTIFACT_PROVIDER,

  owns: (key) => isStudioEmbedKey(key),

  /**
   * Full-text search over the artifact index, returning contract keys in BM25 rank order. Mirrors
   * the url_cache search's sanitize-then-MATCH so caller text can never reach FTS5 as syntax: this
   * read path's contract is "no artifacts", never "the query threw".
   */
  searchKeys: (query, limit) => {
    if (!query.trim() || limit <= 0) return [];
    const rows = getDatabase()
      .prepare(
        `SELECT studio_artifacts.id AS id, studio_artifacts.artifact_type AS type
         FROM studio_artifacts
         JOIN studio_artifacts_fts ON studio_artifacts.id = studio_artifacts_fts.rowid
         WHERE studio_artifacts_fts MATCH ?
         ORDER BY studio_artifacts_fts.rank
         LIMIT ?`,
      )
      .all(sanitizeFtsQuery(query), limit) as Array<{ id: number; type: string }>;
    return rows.map((r) => makeStudioEmbedKey(r.type, r.id));
  },

  hydrate: (key): ArtifactRecord | null => {
    const row = selectArtifact(key);
    if (!row) return null;
    return {
      key,
      type: row.artifact_type,
      title: row.title,
      markdown: row.markdown,
      // The contract's trust mapping: content_trusted (page-derived ⇒ false, a human's own note ⇒
      // true), NEVER curated_by_human — a human keeping a clip says it is useful, not that the page
      // it came from is safe to obey.
      trusted: row.content_trusted === 1,
      fetchedAt: row.fetched_at,
    };
  },

  isResearchable: (record) => isResearchableArtifactType(record.type),
};
