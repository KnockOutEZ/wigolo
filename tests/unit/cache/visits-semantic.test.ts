import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

/**
 * SD7 A-18-11 — history searched by MEANING, and still invisible to every agent.
 *
 * Two claims live here and they pull in opposite directions, which is why they
 * share a suite: the visits corpus must be reachable by semantic similarity for
 * the human who owns it, and unreachable by every agent-facing read of the same
 * shared index. A suite that proved only the second could be satisfied by never
 * indexing anything.
 *
 * WHAT IS REAL AND WHAT IS NOT. The vector store is the real `SqliteVecStore`
 * over a real on-disk database with the real migrations — the partition guard,
 * the RRF fusion, the hydration and the eviction all execute. Only the embedding
 * MODEL is replaced, by a lookup that maps a topic word to a fixed axis. That is
 * the whole point of the substitution: a real model would make "the paraphrase
 * matched" a statement about that model's training rather than about this code,
 * and would take seconds per call. The toy embedder shares no literal token
 * between a query and the body it matches, so a green semantic arm cannot be
 * explained by keyword overlap leaking through.
 *
 * THE FLIP-TEST (run 2026-09-03, restored). Deleting the `scopeVisible` guard
 * from `SqliteVecStore.search` — the one line that makes a partition
 * default-deny — reds `agent-facing hybrid drops a visit vector that carries a
 * corpus URL` and `an unfiltered store read cannot see a visit vector`, while
 * every semantic arm here stays green. Deleting the `evictVisitVectors` call in
 * `deleteVisits` reds `deleting history deletes its vector too` alone.
 */

const VEC_DIMS = 384;

/**
 * A toy embedding model: one axis per topic, chosen by a marker token.
 *
 * The markers are deliberately DISJOINT between a query and the body it should
 * match ("puppy" vs "dog", "money" vs "invoice"). If either arm below went green
 * on shared tokens rather than on the vector leg, the FTS control in the same
 * test would have gone green too — and it is asserted empty.
 */
const TOPICS: Array<{ axis: number; markers: string[] }> = [
  { axis: 0, markers: ['puppy', 'dog', 'kennel'] },
  { axis: 1, markers: ['money', 'invoice', 'ledger'] },
  { axis: 2, markers: ['telescope', 'nebula'] },
];

function toyVector(text: string): Float32Array {
  const v = new Float32Array(VEC_DIMS);
  const lower = text.toLowerCase();
  const topic = TOPICS.find((t) => t.markers.some((m) => lower.includes(m)));
  // An unrecognised text lands on its own axis so it is never accidentally
  // nearest to a fixture it has nothing to do with.
  v[topic ? topic.axis : VEC_DIMS - 1] = 1;
  return v;
}

vi.mock('../../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(async () => ({
    modelId: 'toy-topic-axis',
    dim: VEC_DIMS,
    embed: vi.fn(async (texts: string[]) => texts.map(toyVector)),
  })),
  _resetEmbedProviderForTest: vi.fn(),
}));

const { initDatabase, closeDatabase, getDatabase, isVecExtensionLoaded } = await import(
  '../../../src/cache/db.js'
);
const { getVectorStore, _resetVectorStoreForTest } = await import(
  '../../../src/providers/vector-store.js'
);
const { VEC_SCOPE_KEY } = await import('../../../src/cache/sqlite-vec-store.js');
const { recordVisit, searchVisits, deleteVisits } = await import(
  '../../../src/cache/visit-store.js'
);
const { indexVisitPage, VISIT_VEC_SCOPE, visitVectorId } = await import(
  '../../../src/cache/visit-vec.js'
);
const { runHybridSearch } = await import('../../../src/cache/hybrid-search.js');
const { cacheContent } = await import('../../../src/cache/store.js');
const { resetConfig } = await import('../../../src/config.js');

/** The visit whose meaning is findable and whose text shares no word with the query. */
const DOG_URL = 'https://blog.example.com/crate-schedules';
const DOG_BODY = 'Housebreaking a young dog: crate schedules, reward timing, and kennel routine.';
const DOG_QUERY = 'puppy';

/** A second visit on an unrelated axis — present so "found it" is a ranking claim, not a count of one. */
const MONEY_URL = 'https://books.example.com/invoice-runs';
const MONEY_BODY = 'Monthly invoice runs and the ledger entries they post against.';

/** An ordinary fetched page: the agent corpus, which every agent-facing arm MUST still return. */
const CORPUS_URL = 'https://fetched.example.com/accounting';
const CORPUS_BODY = 'An invoice and ledger primer wigolo fetched on an agent behalf.';

/**
 * A second fetched page, used ONLY as the identity a leaked visit vector would
 * borrow. It exists in `url_cache`, so hydration succeeds for it — which is what
 * makes the exclusion arm test the scope guard rather than a hydration miss.
 */
const BORROWED_URL = 'https://fetched.example.com/kennels';
const BORROWED_BODY = 'A page about boarding kennels that wigolo fetched.';

function seedFetched(url: string, body: string, title: string): void {
  const raw: RawFetchResult = {
    url,
    finalUrl: url,
    html: `<html><body><p>${body}</p></body></html>`,
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  const extraction: ExtractionResult = {
    title,
    markdown: body,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
  cacheContent(raw, extraction);
}

function hashOf(url: string): string {
  const row = getDatabase()
    .prepare('SELECT content_hash FROM studio_visits WHERE url = ? ORDER BY id DESC LIMIT 1')
    .get(url) as { content_hash: string | null } | undefined;
  if (!row?.content_hash) throw new Error(`no stored body for ${url}`);
  return row.content_hash;
}

/** Does the visits FTS index alone answer this query? The outside signal every semantic arm needs. */
function ftsFinds(query: string): number {
  return (
    getDatabase()
      .prepare(
        `SELECT COUNT(*) AS n FROM studio_visit_pages_fts WHERE studio_visit_pages_fts MATCH ?`,
      )
      .get(query) as { n: number }
  ).n;
}

function vectorIds(): string[] {
  return (
    getDatabase().prepare('SELECT external_id FROM vec_id_map ORDER BY rowid').all() as Array<{
      external_id: string;
    }>
  ).map((r) => r.external_id);
}

describe('A-18-11 — the visits semantic arm', () => {
  let dir: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv, LOG_LEVEL: 'error' };
    resetConfig();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-visits-sem-'));
    initDatabase(join(dir, 'wigolo.db'));
    _resetVectorStoreForTest();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    _resetVectorStoreForTest();
    rmSync(dir, { recursive: true, force: true });
    process.env = originalEnv;
    resetConfig();
  });

  /**
   * The vec0 virtual table only exists where the sqlite-vec extension loaded
   * (alpine/musl ships without it), and migration 001 is skipped there. Rather
   * than skipping silently — a suite that reports success for work it did not do
   * — each arm asserts the platform-appropriate outcome: on a machine without
   * vectors, `searchVisits` must still answer, and must say `fts`.
   */
  function vectorsAvailable(): boolean {
    return isVecExtensionLoaded();
  }

  async function seedVisits(): Promise<{ dogHash: string; moneyHash: string }> {
    expect(recordVisit({ url: DOG_URL, title: 'Crate schedules', tabId: 't1', markdown: DOG_BODY }).bodyStored).toBe(true);
    expect(recordVisit({ url: MONEY_URL, title: 'Invoice runs', tabId: 't2', markdown: MONEY_BODY }).bodyStored).toBe(true);
    const dogHash = hashOf(DOG_URL);
    const moneyHash = hashOf(MONEY_URL);
    expect((await indexVisitPage(dogHash)).indexed).toBe(true);
    expect((await indexVisitPage(moneyHash)).indexed).toBe(true);
    return { dogHash, moneyHash };
  }

  it('finds a visit by meaning that the keyword index alone cannot reach', async () => {
    if (!vectorsAvailable()) {
      recordVisit({ url: DOG_URL, title: 'Crate schedules', tabId: 't1', markdown: DOG_BODY });
      expect((await searchVisits({ query: DOG_QUERY })).method).toBe('fts');
      return;
    }
    await seedVisits();

    // THE OUTSIDE SIGNAL: the keyword index has nothing for this query. Without
    // this the arm below could be satisfied by ordinary FTS and prove nothing
    // about the semantic leg.
    expect(ftsFinds(DOG_QUERY), 'FTS must MISS this query, or the semantic claim is untested').toBe(0);

    const { results, method } = await searchVisits({ query: DOG_QUERY });
    expect(method).toBe('hybrid');
    // A KNN leg has no distance floor — neither does the corpus hybrid — so the
    // unrelated visit is a far hit, not an absent one. The claim is about ORDER:
    // the paraphrase puts the page it means FIRST, where the keyword index put
    // nothing at all.
    expect(results[0].url).toBe(DOG_URL);
    expect(results.map((r) => r.url)).toContain(MONEY_URL);
    expect(results.findIndex((r) => r.url === MONEY_URL)).toBeGreaterThan(0);
    // A hit no keyword matched carries no BM25 score, and says so.
    expect(results[0].rank).toBeNull();
    expect(results[0].snippet).toContain('Housebreaking');
  });

  it('reports fts when nothing has been embedded, rather than implying it searched by meaning', async () => {
    recordVisit({ url: DOG_URL, title: 'Crate schedules', tabId: 't1', markdown: DOG_BODY });
    const { results, method } = await searchVisits({ query: 'crate' });
    expect(method).toBe('fts');
    expect(results.map((r) => r.url)).toEqual([DOG_URL]);
  });

  it('keeps the keyword leg intact: an exact term still returns its BM25 rank and snippet', async () => {
    if (!vectorsAvailable()) return;
    await seedVisits();
    const { results, method } = await searchVisits({ query: 'kennel' });
    expect(method).toBe('hybrid');
    expect(results[0].url).toBe(DOG_URL);
    // Resolved by the keyword leg, so the FTS rank and the highlighted snippet survive fusion
    // rather than being replaced by the semantic leg's rank-less head excerpt.
    expect(results[0].rank).not.toBeNull();
    expect(results[0].snippet).toContain('kennel');
  });

  it('honours the per-site scope on the semantic leg, not only on the keyword leg', async () => {
    if (!vectorsAvailable()) return;
    await seedVisits();
    expect(ftsFinds(DOG_QUERY)).toBe(0);
    // Unscoped, the semantic leg ranks the blog page first — the outside signal
    // that the filter below has something to remove.
    expect((await searchVisits({ query: DOG_QUERY })).results[0].url).toBe(DOG_URL);

    // Scoped to the other site, that top hit is gone while the site's own visit
    // still arrives: the filter removed a row rather than the search collapsing.
    const scoped = await searchVisits({ query: DOG_QUERY, site: 'books.example.com' });
    expect(scoped.results.map((r) => r.url)).toEqual([MONEY_URL]);
  });

  it('agent-facing hybrid drops a visit vector that carries a corpus URL', async () => {
    if (!vectorsAvailable()) return;
    seedFetched(CORPUS_URL, CORPUS_BODY, 'Accounting');
    seedFetched(BORROWED_URL, BORROWED_BODY, 'Kennels');
    const store = await getVectorStore();

    // The control: an ordinary corpus vector, unscoped, that the agent MUST get back.
    await store.upsert([
      {
        id: 'https://fetched.example.com/accounting',
        vector: toyVector(CORPUS_BODY),
        metadata: { url: CORPUS_URL, contentHash: 'c1', modelId: 'toy-topic-axis' },
      },
    ]);

    // The adversary: a visit-scoped vector that has BORROWED a real corpus URL,
    // so the hydration path — which normally drops a visit key because
    // `visit:<hash>` is in no agent-facing namespace — succeeds for it. That
    // defeat is the point: with identity containment out of the way, the only
    // thing left standing between this row and the agent is the scope guard.
    await store.upsert([
      {
        id: visitVectorId('borrowed-hash'),
        vector: toyVector(DOG_BODY),
        metadata: {
          url: BORROWED_URL,
          contentHash: 'borrowed-hash',
          modelId: 'toy-topic-axis',
          extra: { [VEC_SCOPE_KEY]: VISIT_VEC_SCOPE },
        },
      },
    ]);

    // A query on the visit's own axis: the borrowed row is the NEAREST vector
    // there is, so an unguarded vec leg ranks it first.
    const out = await runHybridSearch({ query: DOG_QUERY, limit: 20 });
    expect(out.method).toBe('hybrid');
    const urls = out.results.map((r) => r.url);
    expect(urls, 'the borrowed corpus URL must not be reachable through a visit vector').not.toContain(
      BORROWED_URL,
    );

    // And the same call must still be able to return corpus rows, or "no visit
    // row" would be satisfied by a hybrid path that returns nothing at all.
    const control = await runHybridSearch({ query: 'invoice', limit: 20 });
    expect(control.results.map((r) => r.url)).toContain(CORPUS_URL);
  });

  it('an unfiltered store read cannot see a visit vector, however it was written', async () => {
    if (!vectorsAvailable()) return;
    await seedVisits();
    const store = await getVectorStore();
    await store.upsert([
      {
        id: CORPUS_URL,
        vector: toyVector(DOG_BODY),
        metadata: { url: CORPUS_URL, contentHash: 'c1', modelId: 'toy-topic-axis' },
      },
    ]);

    // This is the shape `EmbeddingService.findSimilar` uses: a search with no
    // filter at all. It is the reader that would forget a caller-side filter,
    // and it is why the partition is enforced in the store.
    const hits = await store.search(toyVector(DOG_QUERY), 50);
    expect(hits.map((h) => h.id)).toEqual([CORPUS_URL]);
    expect(hits.every((h) => h.metadata.extra?.[VEC_SCOPE_KEY] === undefined)).toBe(true);

    // Naming the scope is the ONLY way in, and it works — otherwise this arm
    // would also pass against a store that had silently indexed nothing.
    const scoped = await store.search(toyVector(DOG_QUERY), 50, {
      extra: { [VEC_SCOPE_KEY]: VISIT_VEC_SCOPE },
    });
    expect(scoped.map((h) => h.id)).toContain(visitVectorId(hashOf(DOG_URL)));
  });

  it('deleting history deletes its vector too', async () => {
    if (!vectorsAvailable()) return;
    const { dogHash } = await seedVisits();
    expect(vectorIds()).toContain(visitVectorId(dogHash));

    deleteVisits({ site: 'blog.example.com' });

    expect(vectorIds(), 'a deleted page must not stay findable by meaning').not.toContain(
      visitVectorId(dogHash),
    );
    const { results } = await searchVisits({ query: DOG_QUERY });
    expect(results.map((r) => r.url)).not.toContain(DOG_URL);
    // The unrelated visit survives and is still reachable: the delete was scoped,
    // and so was the eviction.
    expect(results.map((r) => r.url)).toContain(MONEY_URL);
    expect(vectorIds()).toContain(visitVectorId(hashOf(MONEY_URL)));
  });

  it('a body swept by the retention bound loses its vector with it', async () => {
    if (!vectorsAvailable()) return;
    recordVisit({ url: DOG_URL, title: 'Crate schedules', tabId: 't1', markdown: DOG_BODY });
    const dogHash = hashOf(DOG_URL);
    expect((await indexVisitPage(dogHash)).indexed).toBe(true);
    expect(vectorIds()).toContain(visitVectorId(dogHash));

    // A byte bound small enough to evict the body already stored — forcing the
    // sweep rather than observing that it did not happen to run.
    recordVisit({
      url: MONEY_URL,
      title: 'Invoice runs',
      tabId: 't2',
      markdown: MONEY_BODY,
      retention: { maxVisits: 100, maxBytes: MONEY_BODY.length + 1, maxAgeDays: 365 },
    });

    expect(
      vectorIds(),
      'a body swept for retention left its embedding behind — the page would stay findable by meaning with no text to show',
    ).not.toContain(visitVectorId(dogHash));
  });

  it('one vector serves every visit that shares a body', async () => {
    if (!vectorsAvailable()) return;
    recordVisit({ url: DOG_URL, title: 'Crate schedules', tabId: 't1', markdown: DOG_BODY });
    recordVisit({ url: DOG_URL, title: 'Crate schedules', tabId: 't2', markdown: DOG_BODY });
    const dogHash = hashOf(DOG_URL);
    await indexVisitPage(dogHash);
    await indexVisitPage(dogHash);

    // Two visits, one deduped body, one vector — a page re-read fifty times must
    // not cost fifty embeddings or contribute fifty ranks to one fusion.
    expect(vectorIds().filter((id) => id.startsWith('visit:'))).toEqual([visitVectorId(dogHash)]);
    const { results } = await searchVisits({ query: DOG_QUERY });
    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.contentHash)).size).toBe(1);
  });
});
