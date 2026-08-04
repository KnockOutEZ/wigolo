/**
 * Studio's captured artifacts as an `ArtifactProvider` — the ONE place the studio side of the shared
 * knowledge store is named. Core's three read paths (`cache`, `find_similar`, `research`) go through
 * the registry and no longer import anything from this directory.
 *
 * The persisted URI scheme is UNCHANGED (`studio://<type>|<id>`, `capture/artifacts.ts`). It is the key
 * already written into the shared vector store and `index_jobs` for every artifact on disk, so renaming
 * it would orphan the existing corpus for no contract gain — core no longer contains the prefix either
 * way. `owns()` delegates to the same `isStudioEmbedKey` the write path derives its keys from, so read
 * and write cannot drift.
 */
import {
  isStudioEmbedKey,
  getStudioArtifactByEmbedKey,
  searchStudioArtifactKeys,
} from './capture/artifacts.js';
import type { ArtifactProvider, ArtifactRecord } from '../cache/artifact-registry.js';

/**
 * The provider id, and therefore the `source` / `engines` value an agent reads on a captured row. It
 * names the SURFACE the row came from, which is what an agent needs in order to weigh it against a
 * fetched page.
 */
export const STUDIO_ARTIFACT_PROVIDER = 'studio';

/**
 * Artifact types that carry citable prose. `mark` is excluded — it has null markdown, so it matches
 * FTS on its title but can never be a source. This is provider POLICY: core used to hold this set as a
 * literal, which meant a second product's types were silently dropped from research.
 */
const RESEARCHABLE_TYPES = new Set(['clip', 'qa', 'note']);

export const studioArtifactProvider: ArtifactProvider = {
  name: STUDIO_ARTIFACT_PROVIDER,
  owns: (key) => isStudioEmbedKey(key),
  searchKeys: (query, limit) => searchStudioArtifactKeys(query, limit),
  hydrate: (key): ArtifactRecord | null => {
    const row = getStudioArtifactByEmbedKey(key);
    if (!row) return null;
    return {
      key,
      type: row.type,
      title: row.title,
      markdown: row.markdown,
      // Mirrors studio_artifacts.content_trusted (clips/qa ⇒ false, human notes ⇒ true), NOT
      // curated_by_human: page-derived content stays untrusted-as-instructions forever.
      trusted: row.contentTrusted,
      fetchedAt: row.fetchedAt,
    };
  },
  isResearchable: (record) => RESEARCHABLE_TYPES.has(record.type),
};
