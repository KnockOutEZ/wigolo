/**
 * Shared-artifact key scheme — the one place `studio://<type>|<id>` is defined.
 *
 * The capture pipeline WRITES these keys into the shared vector store and `index_jobs`; the
 * companion artifact provider READS them back. Today both sides call the functions below, so
 * read and write cannot drift; once the two sides live in different packages this module is
 * the only thing they still share, so it must stay pure — types, string shapes and policy,
 * no I/O and no imports outside this directory.
 *
 * The scheme itself is FROZEN: the keys are already on disk for every captured artifact, so
 * renaming it would orphan the existing corpus for no contract gain.
 *
 * Trust mapping (policy, stated here because both sides implement it): a hydrated record's
 * `trusted` mirrors `studio_artifacts.content_trusted` — clips and qa pairs are page-derived
 * and therefore false, a human's own note is true. It NEVER mirrors `curated_by_human`:
 * page-derived content stays untrusted-as-instructions forever, even once a human keeps it.
 */

/** Scheme prefix of every shared-artifact key. */
export const STUDIO_EMBED_PREFIX = 'studio://';

/** A key parsed back into the pair it addresses. */
export interface StudioEmbedKeyParts {
  type: string;
  id: number;
}

/**
 * Build the embed/vector-store key for an artifact — the SINGLE source of truth for the
 * scheme. The write path (the capture pipeline's embed enqueue) and the FTS read path must
 * emit the IDENTICAL string so an artifact matching BOTH the embedding and FTS paths fuses
 * to one result.
 */
export function makeStudioEmbedKey(type: string, id: number): string {
  return `${STUDIO_EMBED_PREFIX}${type}|${id}`;
}

/**
 * True for a shared-vector-store key that addresses a captured artifact. The `|` makes it a
 * deliberately NON-url-parseable key (it must never reach new URL() / normalizeUrl — callers
 * route on this before url hydration).
 */
export function isStudioEmbedKey(key: string): boolean {
  return key.startsWith(STUDIO_EMBED_PREFIX);
}

/**
 * Inverse of {@link makeStudioEmbedKey}. Returns null for anything that is not a well-formed
 * key — a foreign provider's key, a truncated one, a non-positive or non-integer id. Never
 * throws: a malformed key is a clean miss the caller skips, not an error path.
 *
 * Splits on the LAST separator so a type that itself contains `|` cannot capture the id.
 */
export function parseStudioEmbedKey(key: string): StudioEmbedKeyParts | null {
  if (!isStudioEmbedKey(key)) return null;
  const rest = key.slice(STUDIO_EMBED_PREFIX.length); // <type>|<id>
  const sep = rest.lastIndexOf('|');
  if (sep <= 0 || sep >= rest.length - 1) return null;
  const type = rest.slice(0, sep);
  const id = Number(rest.slice(sep + 1));
  if (!Number.isInteger(id) || id <= 0) return null;
  return { type, id };
}

/**
 * Artifact types that carry citable prose. `mark` is excluded — it has null markdown, so it
 * matches FTS on its title but can never be a source.
 *
 * PINNED: this set decides which stored rows research can cite. Widening or narrowing it
 * changes what an already-captured corpus is worth, so it is a contract value both sides
 * read, never a literal either side keeps.
 */
export const RESEARCHABLE_TYPES: readonly string[] = Object.freeze(['clip', 'qa', 'note']);

const RESEARCHABLE_TYPE_SET = new Set(RESEARCHABLE_TYPES);

/** True for an artifact type that research may cite (see {@link RESEARCHABLE_TYPES}). */
export function isResearchableArtifactType(type: string): boolean {
  return RESEARCHABLE_TYPE_SET.has(type);
}
