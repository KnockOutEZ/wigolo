/**
 * Seeding for the companion tables core still owns.
 *
 * The domain writers — `SessionAuditLog`, the capture pipeline, the flow recorder — left with the
 * extraction, so the tests that pin what core does WITH those rows (the prune verb, the retention
 * window, the artifact union in cache/research, the broker's table ops) can no longer seed through
 * them. They seed the rows directly instead, which is what the broker's own callers do: after D8
 * the tables are storage, and a row is the interface.
 *
 * Deliberately typed loosely at the edges — this is fixture code, not a schema mirror. What it must
 * get right is the FK order (a session before anything that references one) and the NOT NULL set,
 * so a drift in the migrations reds these callers rather than silently seeding nothing.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/** The flow id the recorder derived from a session id — reproduced so a seeded step is findable. */
export function flowIdForSession(sessionId: string): string {
  return 'flw_' + createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

/** The parent row every other companion table FKs. Idempotent. */
export function seedSession(db: Database.Database, sessionId: string): void {
  db.prepare('INSERT OR IGNORE INTO studio_sessions (id) VALUES (?)').run(sessionId);
}

export interface AuditSeed {
  sessionId: string;
  seq: number;
  action: string;
  ts: number;
  epoch?: number;
  outcomeOk?: boolean;
}

/** One audit row, as the session audit log wrote them: metadata only, never typed text. */
export function seedAuditRow(db: Database.Database, seed: AuditSeed): void {
  seedSession(db, seed.sessionId);
  db.prepare(
    `INSERT INTO studio_audit (session_id, seq, action, epoch, outcome_ok, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(seed.sessionId, seed.seq, seed.action, seed.epoch ?? 0, seed.outcomeOk === false ? 0 : 1, seed.ts);
}

export interface FlowStepSeed {
  flowId: string;
  sessionId: string;
  seq: number;
  auditSeq: number;
  action: string;
  ts: number;
  pageUrl?: string;
}

/** One recorded flow step — the half of the recording surface that carries page URLs. */
export function seedFlowStep(db: Database.Database, seed: FlowStepSeed): void {
  seedSession(db, seed.sessionId);
  db.prepare(
    `INSERT INTO studio_flow_steps (flow_id, session_id, seq, audit_seq, action, page_url, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(seed.flowId, seed.sessionId, seed.seq, seed.auditSeq, seed.action, seed.pageUrl ?? null, seed.ts);
}

export interface ArtifactSeed {
  sessionId?: string;
  type: string;
  contentHash: string;
  url?: string;
  title?: string;
  markdown?: string;
  contentTrusted?: 0 | 1;
  curatedByHuman?: 0 | 1;
  createdAt?: string;
}

/** One captured artifact row, as the capture pipeline wrote them. Returns its rowid. */
export function seedArtifact(db: Database.Database, seed: ArtifactSeed): number {
  const sessionId = seed.sessionId ?? 'sess';
  seedSession(db, sessionId);
  const now = seed.createdAt ?? new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO studio_artifacts
         (session_id, artifact_type, url, normalized_url, content_hash, fetched_at,
          created_at, title, markdown, metadata, content_trusted, curated_by_human)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      sessionId,
      seed.type,
      seed.url ?? null,
      seed.url ?? null,
      seed.contentHash,
      now,
      now,
      seed.title ?? null,
      seed.markdown ?? null,
      seed.contentTrusted ?? 0,
      seed.curatedByHuman ?? 0,
    );
  return Number(info.lastInsertRowid);
}

/**
 * A human note: markdown carries the text, and it is the one artifact class trusted as instructions
 * (`content_trusted = 1`), which is why several readers assert their trust mapping against it.
 * Returns the same `{id, inserted}` shape as {@link seedCapture} so callers read alike.
 */
export function seedNote(
  db: Database.Database,
  opts: { sessionId?: string; text: string },
): { id: number; inserted: boolean } {
  const id = seedArtifact(db, {
    sessionId: opts.sessionId,
    type: 'note',
    contentHash: createHash('sha256').update(opts.text).digest('hex'),
    markdown: opts.text,
    contentTrusted: 1,
    curatedByHuman: 1,
  });
  return { id, inserted: true };
}

/** What the curate surface did to a row: the human vouched for it. */
export function curateArtifact(db: Database.Database, id: number): void {
  db.prepare('UPDATE studio_artifacts SET curated_by_human = 1 WHERE id = ?').run(id);
}

export type CaptureSeed =
  | { type: 'clip'; sessionId?: string; url: string; title?: string; markdown: string }
  | { type: 'qa'; sessionId?: string; question: string; answer: string };

/**
 * One captured artifact, seeded the way the capture pipeline wrote it — including its dedup
 * identity, because several callers assert that re-capturing identical content returns the
 * existing id with `inserted: false` rather than a second row. That identity is the pair of
 * partial unique indexes on the table (url-ful and url-less), so this reproduces the writer's
 * INSERT-OR-IGNORE-then-resolve rather than assuming the insert took.
 */
export function seedCapture(db: Database.Database, input: CaptureSeed): { id: number; inserted: boolean } {
  const sessionId = input.sessionId ?? 'sess';
  seedSession(db, sessionId);
  const now = new Date().toISOString();
  const parts = input.type === 'clip' ? [input.markdown] : [input.question, input.answer];
  const contentHash = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  const url = input.type === 'clip' ? input.url : null;
  const title = input.type === 'clip' ? (input.title ?? null) : input.question;
  const markdown = input.type === 'clip' ? input.markdown : input.answer;
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO studio_artifacts
         (session_id, artifact_type, url, normalized_url, content_hash, fetched_at,
          created_at, title, markdown, metadata, content_trusted, curated_by_human)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0)`,
    )
    .run(sessionId, input.type, url, url, contentHash, now, now, title, markdown);
  const inserted = info.changes > 0;
  const existing = (
    url === null
      ? db
          .prepare('SELECT id FROM studio_artifacts WHERE artifact_type = ? AND content_hash = ? AND normalized_url IS NULL')
          .get(input.type, contentHash)
      : db
          .prepare('SELECT id FROM studio_artifacts WHERE artifact_type = ? AND content_hash = ? AND normalized_url = ?')
          .get(input.type, contentHash, url)
  ) as { id: number };
  return { id: existing.id, inserted };
}
