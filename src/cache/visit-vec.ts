import type Database from 'better-sqlite3';
import { getEmbedProvider } from '../providers/embed-provider.js';
import { getVectorStore } from '../providers/vector-store.js';
import { VEC_SCOPE_KEY, deleteVectorsByExternalId } from './sqlite-vec-store.js';
import { readVisitPage } from './visit-store.js';
import { createLogger } from '../logger.js';

const log = createLogger('cache');

/**
 * SD7 A-18-11 — the visits semantic arm: history searched by MEANING, still
 * invisible to every agent.
 *
 * A-18-5 gave visits their own tables and their own FTS index. Semantic search
 * cannot have its own vec0 table for free — a second `vec0(embedding float[N])`
 * would fix a dimension in a second place, need its own migration, its own
 * eviction and its own store instance, and would drift from the corpus index
 * the first time the embedding model changes. So visits ride the SHARED vector
 * store under a partition marker instead, and the partition is enforced
 * default-deny inside `SqliteVecStore` — see `scopeVisible` there. A reader
 * that has never heard of visits cannot see one.
 *
 * Two independent things keep a visit out of an agent result, and they are not
 * the same predicate:
 *
 *   1. IDENTITY. A visit vector's external id and `metadata.url` are both the
 *      synthetic `visit:<content_hash>`. Every agent-facing consumer hydrates a
 *      vec hit by looking its key up in `url_cache`, so a visit key resolves to
 *      nothing even if it is somehow returned.
 *   2. SCOPE. The record carries `extra.scope = 'visit'`, and the store returns
 *      a scoped row only to a search that named that scope.
 *
 * (1) alone is incidental containment — it holds because of what hydration
 * happens to do, and it would end the moment anyone put a real URL in a visit
 * vector's metadata. (2) is the guarantee. The negative test defeats (1)
 * deliberately, so that what it proves is (2).
 */

/** The partition every visit vector carries. Agent-facing searches name no scope. */
export const VISIT_VEC_SCOPE = 'visit';

/** Namespace prefix for a visit vector's external id — never a URL. */
export const VISIT_VEC_ID_PREFIX = 'visit:';

/**
 * How much of a body is embedded.
 *
 * Matched to `backfill-embeddings.ts`, which embeds `title + body.slice(0, 500)`
 * into the same index with the same model: two texts of wildly different length
 * embedded by the same model do not sit in comparable regions of the space, and
 * a visits arm that embedded whole pages while the corpus embedded openings
 * would make a cross-partition comparison meaningless the day anyone tries one.
 */
const EMBED_BODY_CHARS = 500;

export interface VisitIndexResult {
  indexed: boolean;
  /** Why nothing was indexed — absent on success. */
  reason?: 'no_body' | 'unavailable' | 'empty_vector' | 'error';
}

/** The vec identity for a stored body. One body, one vector, however many visits share it. */
export function visitVectorId(contentHash: string): string {
  return `${VISIT_VEC_ID_PREFIX}${contentHash}`;
}

/** The body hash behind a visit vector id, or null when the id is not one. */
export function visitHashFromVectorId(id: string): string | null {
  return id.startsWith(VISIT_VEC_ID_PREFIX) ? id.slice(VISIT_VEC_ID_PREFIX.length) : null;
}

/**
 * Embed one stored visit body into the shared index, under the visits partition.
 *
 * NEVER THROWS, and is deliberately NOT called by `recordVisit`. Capture runs on
 * navigation-settle and `recordVisit` returns synchronously inside a
 * transaction; an embed is an awaitable subprocess round-trip and cannot live
 * there. The capture seam calls this after the visit lands, the same shape
 * `tools/fetch.ts` uses for the corpus (`cacheContent`, then the embedding
 * hook) — which also means the cost of the semantic arm is a number the seam
 * can choose to stop paying, rather than one welded to recording history.
 */
export async function indexVisitPage(contentHash: string): Promise<VisitIndexResult> {
  const page = readVisitPage(contentHash);
  if (!page || page.markdown.length === 0) return { indexed: false, reason: 'no_body' };

  let embedProvider;
  let store;
  try {
    [embedProvider, store] = await Promise.all([getEmbedProvider(), getVectorStore()]);
  } catch (err) {
    log.debug('visit embedding skipped — embed/vector provider unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { indexed: false, reason: 'unavailable' };
  }

  try {
    const [vector] = await embedProvider.embed([page.markdown.slice(0, EMBED_BODY_CHARS)]);
    if (!vector || vector.length === 0) return { indexed: false, reason: 'empty_vector' };

    await store.upsert([
      {
        id: visitVectorId(contentHash),
        vector,
        metadata: {
          // The synthetic id, NOT the visited URL. A-18-6 keeps a visit's own full
          // URL in the visits table and nowhere else; `vec_metadata` is read by the
          // shared index's readers, so putting a browsing URL there would place it
          // one forgotten filter away from an agent even though the row itself is
          // excluded.
          url: visitVectorId(contentHash),
          contentHash,
          modelId: embedProvider.modelId,
          extra: { [VEC_SCOPE_KEY]: VISIT_VEC_SCOPE },
        },
      },
    ]);
    return { indexed: true };
  } catch (err) {
    log.warn('visit embedding failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { indexed: false, reason: 'error' };
  }
}

/**
 * Embed a query into the visits partition and return the body hashes it matches,
 * best first.
 *
 * Returns null — not an empty array — when the semantic side is unavailable, so
 * the caller can report `method: 'fts'` honestly instead of reporting a hybrid
 * search that found nothing.
 */
export async function searchVisitVectors(
  query: string,
  limit: number,
): Promise<string[] | null> {
  // The store is resolved and probed BEFORE the embedding provider, not beside
  // it: `getEmbedProvider()` warms a real model on first use, and an install
  // with no vector extension or an empty index has nothing for that model to be
  // compared against. Resolving them together would pay seconds of model load
  // to discover there was no index to search.
  let store;
  try {
    store = await getVectorStore();
    if ((await store.size()) === 0) return null;
  } catch {
    return null;
  }

  let embedProvider;
  try {
    embedProvider = await getEmbedProvider();
  } catch {
    return null;
  }

  try {
    const [vector] = await embedProvider.embed([query]);
    if (!vector || vector.length === 0) return null;
    const hits = await store.search(vector, limit, {
      extra: { [VEC_SCOPE_KEY]: VISIT_VEC_SCOPE },
    });
    const hashes: string[] = [];
    for (const hit of hits) {
      const hash = visitHashFromVectorId(hit.id);
      if (hash) hashes.push(hash);
    }
    return hashes;
  } catch (err) {
    log.warn('visit vector search failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Drop the vectors for bodies that are gone, against the caller's handle.
 *
 * Synchronous and handle-taking so it can run INSIDE the transaction that
 * removed the bodies — `deleteVectorsByExternalId` was built for exactly this
 * shape on the cache-clear path. A deleted history that stayed semantically
 * searchable is the one outcome a delete control cannot have, so this is not an
 * optimisation: it is the second half of `deleteVisits` and of the retention
 * sweep. Returns the number of vectors actually removed.
 */
export function evictVisitVectors(db: Database.Database, contentHashes: string[]): number {
  if (contentHashes.length === 0) return 0;
  try {
    return deleteVectorsByExternalId(db, contentHashes.map(visitVectorId));
  } catch (err) {
    // The sweep runs on the capture path. A vec table that refuses a delete must
    // not take the navigation down with it; the orphaned vector is unreachable
    // anyway, since every read of it hydrates through a body row that is gone.
    log.warn('visit vector eviction failed', {
      count: contentHashes.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
