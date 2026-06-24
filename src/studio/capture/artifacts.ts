import type Database from 'better-sqlite3';
import { hashArtifact } from './hash.js';
import { normalizeUrl, sanitizeFtsQuery } from '../../cache/store.js';
import { getBackgroundIndexQueue, type IndexJobInput } from '../../embedding/background-queue.js';
import { getDatabase } from '../../cache/db.js';
import { isCredentialContext, type FieldSemantics } from '../credential.js';

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
  /**
   * Optional on the BASE so captureHumanNote (not a page-capture, never guarded) can share this deps
   * shape and ignore it. captureFromPage narrows it to REQUIRED via PageCaptureDeps below.
   */
  credentialContext?: { pageUrl?: string; fields?: FieldSemantics[] };
  /**
   * Phase 7e S1 — notify-only sink for a REAL captured-item insert (the host wires it to a
   * hub.broadcast({t:'artifact', …}) delta). Injected (like `enqueue`); session scoping comes from the
   * caller's closure. Fired post-commit, ONLY on a real insert AND only for captured types (NOT note/mark) —
   * a free function cannot host a class-style subscriber list without a module-global that cross-leaks the
   * per-session broadcast, so the dep-injection mirrors onRecord's notify-only semantics, session-safely.
   */
  onArtifact?: (delta: ArtifactDelta) => void;
}

/**
 * Slice 5b — the deps captureFromPage requires. `credentialContext` is the live page's credential
 * signal, resolved FRESH at capture-time by the host (a fresh snapshot's fields + the host-observed
 * page url). It is REQUIRED here (narrowing the optional base): an unwired page-capture path then fails
 * the type-check (fail-loud, structural) instead of silently skipping the guard and persisting a
 * credential — closing the fail-open of an absent provider. An empty object means "checked, no
 * credential context".
 */
export interface PageCaptureDeps extends CaptureDeps {
  credentialContext: { pageUrl?: string; fields?: FieldSemantics[] };
}

/**
 * Slice 5b — thrown by captureFromPage when the live page is a credential context, so the capture is
 * excluded ENTIRELY (no FTS row, no embed enqueue). Thrown (not returned) to preserve captureFromPage's
 * CaptureResult contract that its dedup-result callers depend on; the studio_capture handler catches it
 * and surfaces capture_refused. Carries NO page content/URL — nothing for a logger to leak.
 */
export class CaptureRefusedError extends Error {
  constructor(public readonly reason: 'credential_context' | 'nav_epoch_stale') {
    super(`capture refused: ${reason}`);
    this.name = 'CaptureRefusedError';
  }
}

export interface CaptureResult {
  id: number;
  /** False when an existing row deduped the capture (no new row, no re-embed). */
  inserted: boolean;
  contentHash: string;
}

/**
 * Phase 7e S1 — the LIGHT projection of a freshly-inserted artifact that the notify-only `onArtifact`
 * hook hands to the host (which broadcasts it as the live {t:'artifact'} captured-items delta). It carries
 * the panel's display fields ONLY — NEVER the full markdown body (the body lives in the cache; the panel
 * reads title/url). `trusted` is content_trusted as a boolean.
 */
export interface ArtifactDelta {
  id: number;
  type: string;
  title: string | null;
  url: string | null;
  trusted: boolean;
  created_at: string;
}

/**
 * The captured-items panel's type scope (locked): one home per artifact type. `note` owns the comments
 * panel ({t:'comment'}) and `mark` owns the marks panel ({t:'mark'}); every other type (clip, qa) is a
 * captured item. This single predicate gates BOTH the live onArtifact delta (insertArtifact) and the
 * post-hello snapshot read (listSessionArtifacts) so neither channel can route a type to two panels.
 */
const CAPTURED_PANEL_EXCLUDED_TYPES = new Set(['note', 'mark']);
export function isCapturedPanelType(type: string): boolean {
  return !CAPTURED_PANEL_EXCLUDED_TYPES.has(type);
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
  onArtifact?: (delta: ArtifactDelta) => void,
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
      enqueue({ url: studioEmbedKey(row.type, id), text: embed.text, contentHash: row.contentHash });
    }

    return { id, inserted, contentHash: row.contentHash };
  });
  const result = tx();
  // 7e S1 — notify-only, POST-COMMIT (mirrors audit onRecord: observe-only, never mutates the row). Gated
  // on a REAL insert (the same `inserted` predicate the embed enqueue rides) AND the captured-type filter —
  // a dedup no-op fires nothing, and note/mark route to their own panels, never the captured channel. The
  // delta is the LIGHT projection — display fields only, never the markdown body.
  if (result.inserted && onArtifact && isCapturedPanelType(row.type)) {
    onArtifact({
      id: result.id,
      type: row.type,
      title: row.title,
      url: row.url,
      trusted: row.contentTrusted === 1,
      created_at: row.createdAt,
    });
  }
  return result;
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
export function captureFromPage(input: PageCapture, deps: PageCaptureDeps): CaptureResult {
  // Slice 5b — exclude ENTIRELY on a credential context (login URL OR a credential field present on
  // the page at capture-time), BEFORE the FTS row AND the embed enqueue (both live in insertArtifact).
  // The agent must never precipitate a login/secret into the durable cache. This is the single live
  // persist choke clip + qa both cross; captureHumanNote does NOT cross here, so a human noting their
  // own secret stays untouched. `credentialContext` is REQUIRED (PageCaptureDeps), so an unwired
  // caller fails the type-check rather than silently skipping this guard. Fail-closed: thrown before
  // any row is built; the handler surfaces it as capture_refused.
  if (isCredentialContext(deps.credentialContext)) {
    throw new CaptureRefusedError('credential_context');
  }
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
    // Both paths forward the hook; the captured-type filter in insertArtifact is the single structural
    // gate (clip/qa fire; a stray mark capture would be filtered there, not here).
    deps.onArtifact,
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
    // Forwarded for symmetry; type='note' is excluded by insertArtifact's captured-type filter, so a
    // human note never phantoms into the captured channel (it owns {t:'comment'}).
    deps.onArtifact,
  );
}

/** A human comment/annotation resolved for a session read surface (the comments-panel backfill). */
export interface SessionCommentRow {
  id: number;
  text: string;
}

/**
 * Session-scoped read of a session's human comments (artifact_type='note'), append-ordered (by id), capped to
 * the most-recent `limit`. The `WHERE session_id = ?` filter is the ISOLATION boundary: one session's comments
 * never leak into another session's read surface. This is the first session-scoped studio-artifact read (a
 * later slice generalizes it across artifact types). Reads THIS session's notes ascending, then `slice(-limit)`
 * keeps the most-recent tail — mirroring the audit snapshot's `slice(-N)`.
 */
export function listSessionComments(db: Database.Database, sessionId: string, limit: number): SessionCommentRow[] {
  const rows = db
    .prepare(
      "SELECT id, markdown FROM studio_artifacts WHERE session_id = ? AND artifact_type = 'note' ORDER BY id ASC",
    )
    .all(sessionId) as Array<{ id: number; markdown: string | null }>;
  return rows.slice(-limit).map((r) => ({ id: r.id, text: r.markdown ?? '' }));
}

/**
 * Phase 7e S2 — the captured-items panel's post-hello backfill read. Generalizes listSessionComments to
 * the captured scope: session-scoped (the `WHERE session_id = ?` ISOLATION boundary — one session's
 * captures never leak into another's panel), artifact_type NOT IN (note,mark) (one home per type: notes
 * own the comments panel, marks own the marks panel), append-ordered, capped to the most-recent `limit`
 * via slice(-limit). Returns the LIGHT projection — display fields only, NEVER the markdown body (the body
 * stays in the cache; the panel shows title/url). Identical to the live onArtifact delta shape so snapshot +
 * delta upsert by the same id on the client.
 */
export function listSessionArtifacts(db: Database.Database, sessionId: string, limit: number): ArtifactDelta[] {
  const rows = db
    .prepare(
      `SELECT id, artifact_type, title, url, content_trusted, created_at
       FROM studio_artifacts
       WHERE session_id = ? AND artifact_type NOT IN ('note', 'mark')
       ORDER BY id ASC`,
    )
    .all(sessionId) as Array<{
      id: number;
      artifact_type: string;
      title: string | null;
      url: string | null;
      content_trusted: number;
      created_at: string;
    }>;
  return rows.slice(-limit).map((r) => ({
    id: r.id,
    type: r.artifact_type,
    title: r.title,
    url: r.url,
    trusted: r.content_trusted === 1,
    created_at: r.created_at,
  }));
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

/** Build the embed/vector-store key for an artifact — the SINGLE source of truth
 * for the scheme. The write path (insertArtifact's embed enqueue) and the FTS
 * read path (searchStudioArtifactKeys) must emit the IDENTICAL string so a clip
 * that matches BOTH the embedding and FTS paths fuses to one result. */
export function studioEmbedKey(type: string, id: number): string {
  return `${STUDIO_EMBED_PREFIX}${type}|${id}`;
}

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
  /** Capture timestamp (studio_artifacts.fetched_at) — for cache-tool fetched_at. */
  fetchedAt: string;
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
      'SELECT id, artifact_type, url, title, markdown, content_trusted, fetched_at FROM studio_artifacts WHERE id = ?',
    )
    .get(id) as
    | { id: number; artifact_type: string; url: string | null; title: string | null; markdown: string | null; content_trusted: number; fetched_at: string }
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
    fetchedAt: row.fetched_at,
  };
}

/**
 * FTS5 search over studio_artifacts_fts (title + markdown), returning the embed
 * keys of matches in BM25 rank order. Mirrors store.ts::searchCache's
 * sanitize-then-MATCH, on the studio index. The caller hydrates each key via
 * getStudioArtifactByEmbedKey (the shared SELECT-by-id read — no re-derivation).
 */
export function searchStudioArtifactKeys(query: string, limit: number): string[] {
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
  return rows.map((r) => studioEmbedKey(r.type, r.id));
}
