import { join } from 'node:path';
import { createLogger } from '../logger.js';
import { initDatabase, closeDatabase, isVecExtensionLoaded } from './db.js';
import { getEmbedProvider } from '../providers/embed-provider.js';
import { getVectorStore } from '../providers/vector-store.js';

const log = createLogger('cache');

export interface BackfillOptions {
  dataDir: string;
  limit?: number;
  batchSize?: number;
  dryRun?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface BackfillResult {
  scanned: number;
  embedded: number;
  skipped: number;
  errors: number;
  modelId: string;
  reason?: string;
}

interface CacheRow {
  url: string;
  title: string | null;
  markdown: string | null;
  content_hash: string | null;
}

const SELECT_PENDING_SQL = `
  SELECT url, title, markdown, content_hash
  FROM url_cache uc
  WHERE NOT EXISTS (
    SELECT 1 FROM vec_id_map vm WHERE vm.external_id = uc.url
  )
  ORDER BY uc.id ASC
`;

/**
 * Walk url_cache rows that have no corresponding vec_id_map entry, embed
 * title + a snippet of markdown, and upsert into the vector store. Used to
 * recover pages cached before the sqlite-vec switch — find_similar's
 * embedding path skips them otherwise.
 */
export async function backfillEmbeddings(opts: BackfillOptions): Promise<BackfillResult> {
  const { dataDir, limit, batchSize = 32, dryRun = false, onProgress } = opts;

  const db = initDatabase(join(dataDir, 'wigolo.db'));
  try {
    if (!isVecExtensionLoaded()) {
      return {
        scanned: 0,
        embedded: 0,
        skipped: 0,
        errors: 0,
        modelId: '',
        reason: 'sqlite-vec extension not loaded — backfill skipped',
      };
    }

    let provider: Awaited<ReturnType<typeof getEmbedProvider>>;
    let store: Awaited<ReturnType<typeof getVectorStore>>;
    try {
      provider = await getEmbedProvider();
      store = await getVectorStore();
    } catch (err) {
      return {
        scanned: 0,
        embedded: 0,
        skipped: 0,
        errors: 0,
        modelId: '',
        reason: `embedding pipeline unavailable: ${err instanceof Error ? err.message : String(err)} — run \`wigolo warmup --embeddings\` first`,
      };
    }

    let rows = db.prepare(SELECT_PENDING_SQL).all() as CacheRow[];
    if (typeof limit === 'number' && limit > 0) {
      rows = rows.slice(0, limit);
    }

    const result: BackfillResult = {
      scanned: rows.length,
      embedded: 0,
      skipped: 0,
      errors: 0,
      modelId: provider.modelId,
    };

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const usable = batch.filter(
        (r) => (r.title && r.title.trim().length > 0) || (r.markdown && r.markdown.trim().length > 0),
      );
      result.skipped += batch.length - usable.length;
      if (usable.length === 0) {
        onProgress?.(i + batch.length, rows.length);
        continue;
      }

      const texts = usable.map((r) => {
        const title = (r.title ?? '').trim();
        const body = (r.markdown ?? '').slice(0, 500).trim();
        return `${title}\n${body}`.trim();
      });

      try {
        // Reacquire each batch. The idle timer can release the model between
        // batches, and a stale handle would reload it into the old provider.
        provider = await getEmbedProvider();
        const vectors = await provider.embed(texts);
        if (!dryRun) {
          await store.upsert(
            usable.map((r, idx) => ({
              id: r.url,
              vector: vectors[idx],
              metadata: {
                url: r.url,
                contentHash: r.content_hash ?? '',
                modelId: provider.modelId,
              },
            })),
          );
        }
        result.embedded += usable.length;
      } catch (err) {
        log.warn('backfill batch failed', {
          batchStart: i,
          batchSize: usable.length,
          error: err instanceof Error ? err.message : String(err),
        });
        result.errors += usable.length;
      }

      onProgress?.(i + batch.length, rows.length);
    }

    return result;
  } finally {
    closeDatabase();
  }
}
