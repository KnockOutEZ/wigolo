import type Database from 'better-sqlite3';
import { hashArtifact } from './hash.js';
import { normalizeUrl } from '../../cache/store.js';
import { getBackgroundIndexQueue, type IndexJobInput } from '../../embedding/background-queue.js';
import { getDatabase } from '../../cache/db.js';

/**
 * Phase 4b-3 — the Studio capture pipeline. The host persists a human-marked target,
 * a clipped page region, a page Q&A, or a human note as a deduped, FTS-searchable
 * artifact, enqueues an off-loop embedding for prose types, and exposes a curate action.
 *
 * Trust is a function of the PATH, never a caller flag: `captureFromPage` (mark/clip/qa)
 * always stores content_trusted=0 — page bytes are data, not instructions — and exposes
 * no trust parameter; `captureHumanNote` is the only path that sets content_trusted=1.
 */

export interface MarkSelectors {
  role: string;
  name: string;
  /** Generalized ancestor-path spine (positional indices dropped) — the dedup identity. */
  ancestorPath: string;
  /** Durable re-resolution locators; persisted to metadata, never hashed or FTS-indexed. */
  fingerprint: string;
  attrs: Record<string, string>;
  /** Volatile host-side handle at mark time — excluded from the content hash. */
  backendNodeId?: number;
}

export type PageCapture =
  | { type: 'mark'; sessionId: string; url: string; target: MarkSelectors }
  | { type: 'clip'; sessionId: string; url: string; title: string; markdown: string }
  | { type: 'qa'; sessionId: string; question: string; answer: string };

export interface NoteCapture {
  sessionId: string;
  text: string;
}

export interface CaptureDeps {
  db: Database.Database;
  /** Embed-job sink; defaults to the shared background queue. Injected for tests. */
  enqueue?: (job: IndexJobInput) => unknown;
}

export interface CaptureResult {
  id: number;
  /** False when an existing row deduped the capture (no new row, no re-embed). */
  inserted: boolean;
  contentHash: string;
}

type HashableArtifact = PageCapture | { type: 'note'; sessionId: string; text: string };

/**
 * The single per-type domain-part composition feeding the content hash. Both capture
 * entry points route through `contentHashFor`, so no two call sites can derive a
 * divergent hash. mark = role + accessible-name + generalized ancestorPath spine (NOT
 * the volatile backendNodeId / fingerprint / attrs); clip = clipped markdown; qa =
 * question + answer; note = note text.
 */
function contentParts(input: HashableArtifact): string[] {
  switch (input.type) {
    case 'mark':
      return [input.target.role, input.target.name, input.target.ancestorPath];
    case 'clip':
      return [input.markdown];
    case 'qa':
      return [input.question, input.answer];
    case 'note':
      return [input.text];
  }
}

export function contentHashFor(input: HashableArtifact): string {
  return hashArtifact(input.type, ...contentParts(input));
}

interface ArtifactInsert {
  sessionId: string;
  type: string;
  url: string | null;
  normalizedUrl: string | null;
  contentHash: string;
  fetchedAt: string;
  createdAt: string;
  title: string | null;
  markdown: string | null;
  metadata: string | null;
  contentTrusted: number;
  curatedByHuman: number;
}

/**
 * Insert one artifact and, for embed-worthy content, enqueue its off-loop embedding —
 * ATOMICALLY. The row insert (and its AFTER INSERT FTS trigger) plus the enqueue run in
 * ONE transaction, so a failed enqueue rolls the row + its FTS entry back rather than
 * leaving an un-embedded artifact. INSERT OR IGNORE dedups on the per-type partial unique
 * index; a dedup hit returns the existing row and never re-enqueues (its content is
 * already indexed) — and OR IGNORE (not OR REPLACE) preserves a prior human curation.
 */
function insertArtifact(
  db: Database.Database,
  row: ArtifactInsert,
  embed: { text: string } | null,
  enqueue: (job: IndexJobInput) => unknown,
): CaptureResult {
  const tx = db.transaction((): CaptureResult => {
    // session_id is NOT NULL + a FK (NO ACTION) — ensure the origin row exists first.
    db.prepare('INSERT OR IGNORE INTO studio_sessions (id) VALUES (?)').run(row.sessionId);

    const info = db
      .prepare(
        `INSERT OR IGNORE INTO studio_artifacts
           (session_id, artifact_type, url, normalized_url, content_hash, fetched_at,
            created_at, title, markdown, metadata, content_trusted, curated_by_human)
         VALUES
           (@sessionId, @type, @url, @normalizedUrl, @contentHash, @fetchedAt,
            @createdAt, @title, @markdown, @metadata, @contentTrusted, @curatedByHuman)`,
      )
      .run(row);
    const inserted = info.changes > 0;

    // lastInsertRowid is stale on an ignored insert — resolve the canonical row id by the
    // dedup key, matching whichever partial unique index governs this type.
    const existing = (
      row.normalizedUrl === null
        ? db
            .prepare(
              'SELECT id FROM studio_artifacts WHERE artifact_type = ? AND content_hash = ? AND normalized_url IS NULL',
            )
            .get(row.type, row.contentHash)
        : db
            .prepare(
              'SELECT id FROM studio_artifacts WHERE artifact_type = ? AND content_hash = ? AND normalized_url = ?',
            )
            .get(row.type, row.contentHash, row.normalizedUrl)
    ) as { id: number };
    const id = existing.id;

    // Embed only embed-worthy types, and only on a REAL insert. The studio-namespaced
    // key keeps url-less types non-null and never collides with the url_cache embed of
    // the same page (no find_similar url-facet pollution). The artifact id unifies with
    // the FTS content_rowid.
    if (inserted && embed) {
      enqueue({ url: `studio://${row.type}|${id}`, text: embed.text, contentHash: row.contentHash });
    }

    return { id, inserted, contentHash: row.contentHash };
  });
  return tx();
}

function resolveEnqueue(deps: CaptureDeps): (job: IndexJobInput) => unknown {
  return deps.enqueue ?? ((job) => getBackgroundIndexQueue().enqueue(job));
}

/**
 * Capture page-derived content (mark / clip / qa). Page bytes are NEVER trusted as
 * instructions: content_trusted is the literal 0 here, and there is no caller-facing
 * trust parameter. Text mapping: clip → markdown (title = page title); qa → title =
 * question, markdown = answer; mark → title = role+name (searchable), selectors → metadata.
 */
export function captureFromPage(input: PageCapture, deps: CaptureDeps): CaptureResult {
  const now = new Date().toISOString();
  const contentHash = contentHashFor(input);

  let url: string | null;
  let title: string | null;
  let markdown: string | null;
  let metadata: string | null;
  let embed: { text: string } | null;

  switch (input.type) {
    case 'mark':
      url = input.url;
      title = `${input.target.role} ${input.target.name}`.trim();
      markdown = null;
      // Selectors are durable re-resolution data, not prose — kept out of FTS.
      metadata = JSON.stringify({
        fingerprint: input.target.fingerprint,
        ancestorPath: input.target.ancestorPath,
        attrs: input.target.attrs,
      });
      embed = null; // marks are structural → FTS-only, never embedded
      break;
    case 'clip':
      url = input.url;
      title = input.title;
      markdown = input.markdown;
      metadata = null;
      embed = { text: input.markdown };
      break;
    case 'qa':
      url = null; // qa is url-less
      title = input.question;
      markdown = input.answer;
      metadata = null;
      embed = { text: input.answer };
      break;
  }

  return insertArtifact(
    deps.db,
    {
      sessionId: input.sessionId,
      type: input.type,
      url,
      // Reuse the url_cache normalizer so a studio clip and a url_cache fetch of the same
      // page normalize identically (cross-surface find_similar / research join).
      normalizedUrl: url === null ? null : normalizeUrl(url),
      contentHash,
      fetchedAt: now,
      createdAt: now,
      title,
      markdown,
      metadata,
      contentTrusted: 0,
      curatedByHuman: 0,
    },
    embed,
    resolveEnqueue(deps),
  );
}

/**
 * Capture a human-authored note. The ONLY path that sets content_trusted=1 (a human
 * typed it, so its bytes are safe as instructions) and curated_by_human=1 (deliberately
 * authored). url-less; deduped by note text.
 */
export function captureHumanNote(input: NoteCapture, deps: CaptureDeps): CaptureResult {
  const now = new Date().toISOString();
  return insertArtifact(
    deps.db,
    {
      sessionId: input.sessionId,
      type: 'note',
      url: null,
      normalizedUrl: null,
      contentHash: contentHashFor({ type: 'note', sessionId: input.sessionId, text: input.text }),
      fetchedAt: now,
      createdAt: now,
      title: null,
      markdown: input.text,
      metadata: null,
      contentTrusted: 1,
      curatedByHuman: 1,
    },
    { text: input.text },
    resolveEnqueue(deps),
  );
}

/**
 * Mark an existing artifact as human-curated. Keyed by row id; sets ONLY
 * curated_by_human and never names content_trusted — page-derived content stays
 * untrusted-as-instructions forever, even once a human keeps it.
 */
export function curateArtifact(id: number, deps: { db: Database.Database }): void {
  deps.db.prepare('UPDATE studio_artifacts SET curated_by_human = 1 WHERE id = ?').run(id);
}

/** The embed/vector key scheme the capture pipeline writes (see insertArtifact:
 * `studio://<type>|<id>`). Centralized here so the read path parses exactly the
 * shape the write path constructs. */
const STUDIO_EMBED_PREFIX = 'studio://';

/** True for a shared-vector-store key that addresses a studio artifact. The `|`
 * makes it a deliberately NON-url-parseable key (it must never reach new URL() /
 * normalizeUrl — callers route on this before url hydration). */
export function isStudioEmbedKey(key: string): boolean {
  return key.startsWith(STUDIO_EMBED_PREFIX);
}

/** A studio artifact resolved for retrieval (find_similar / future read surfaces). */
export interface StudioArtifactRow {
  id: number;
  type: string;
  url: string | null;
  title: string | null;
  markdown: string | null;
  /** content_trusted as a boolean — safe AS INSTRUCTIONS (human note) vs not. */
  contentTrusted: boolean;
}

/**
 * Resolve a `studio://<type>|<id>` embed key to its artifact row, BY ID — never
 * constructs a URL from the key (the `|` is not URL-safe; that is the whole
 * reason the embedding hydration path must branch on key shape before url_cache
 * lookup). Returns null on a malformed key, a non-existent id, or a type/id
 * mismatch (a stale or forged key) — a clean miss the caller skips, never a
 * throw and never an empty-content surface.
 */
export function getStudioArtifactByEmbedKey(key: string): StudioArtifactRow | null {
  if (!isStudioEmbedKey(key)) return null;
  const rest = key.slice(STUDIO_EMBED_PREFIX.length); // <type>|<id>
  const sep = rest.lastIndexOf('|');
  if (sep <= 0 || sep >= rest.length - 1) return null;
  const type = rest.slice(0, sep);
  const id = Number(rest.slice(sep + 1));
  if (!Number.isInteger(id) || id <= 0) return null;

  const row = getDatabase()
    .prepare(
      'SELECT id, artifact_type, url, title, markdown, content_trusted FROM studio_artifacts WHERE id = ?',
    )
    .get(id) as
    | { id: number; artifact_type: string; url: string | null; title: string | null; markdown: string | null; content_trusted: number }
    | undefined;
  if (!row) return null;
  // The key's type must match the stored row — guards a stale/forged key that
  // points at a different artifact than its scheme claims.
  if (row.artifact_type !== type) return null;

  return {
    id: row.id,
    type: row.artifact_type,
    url: row.url,
    title: row.title,
    markdown: row.markdown,
    contentTrusted: row.content_trusted === 1,
  };
}
