import { getDatabase } from '../../cache/db.js';
import type { LLMCallRecord } from './types.js';

export function ensureLLMCacheTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      model_id TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (model_id, prompt_hash, schema_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_llm_cache_expires ON llm_cache(expires_at);
  `);
}

export function lookupLLMCache(
  modelId: string,
  promptHash: string,
  schemaHash: string,
): string | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT response FROM llm_cache
       WHERE model_id = ? AND prompt_hash = ? AND schema_hash = ?
         AND expires_at > ?`,
    )
    .get(modelId, promptHash, schemaHash, Date.now()) as
    | { response: string }
    | undefined;
  return row?.response ?? null;
}

export function insertLLMCache(rec: LLMCallRecord): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO llm_cache (model_id, prompt_hash, schema_hash, response, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(model_id, prompt_hash, schema_hash) DO UPDATE SET
       response = excluded.response,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
  ).run(
    rec.modelId,
    rec.promptHash,
    rec.schemaHash,
    rec.response,
    rec.createdAt,
    rec.expiresAt,
  );
}
