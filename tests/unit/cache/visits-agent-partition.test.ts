import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VectorSearchResult } from '../../../src/providers/vector-store.js';
import type { RawFetchResult, ExtractionResult, SearchEngine, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

/**
 * A-18-5, THE MERGE CONDITION — agent tools cannot surface a visit row.
 *
 * History-with-content is what a HUMAN read. Law 4 keeps the user's own tabs invisible to
 * every agent, and A-18-5 extends that to the content those tabs held: `studio_visits` /
 * `studio_visit_pages` are absent from `url_cache`, from `studio_artifacts`, from the
 * artifact-provider union, and from every FTS/vector index `cache`, `find_similar` and
 * `research` read.
 *
 * Every arm here needs an OUTSIDE SIGNAL, or "no visit row came back" is satisfied by a
 * search that returned nothing at all. So each arm seeds a control the tool MUST return for
 * the same query, in the same call, and asserts both halves: the control arrives, the visit
 * does not.
 *
 * The flip-test that proves this suite can fail is recorded in the issue's demo: unioning
 * `studio_visit_pages_fts` into the hybrid path turns the FTS and hybrid arms red.
 */

const vecState: { size: number; results: VectorSearchResult[] } = { size: 0, results: [] };

vi.mock('../../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(async () => ({
    modelId: 'test',
    dim: 4,
    embed: vi.fn(async () => [new Float32Array([1, 0, 0, 0])]),
  })),
}));
vi.mock('../../../src/providers/vector-store.js', () => ({
  getVectorStore: vi.fn(async () => ({
    upsert: vi.fn(),
    delete: vi.fn(),
    size: vi.fn(async () => vecState.size),
    search: vi.fn(async () => vecState.results),
  })),
}));

const mockEmbeddingState = {
  available: false,
  subprocessReady: false,
  /** Non-zero so the embedding lane is not short-circuited on an empty index. */
  indexSize: 2,
  /** Counts the embedding lane actually running — an inert lane cannot prove a partition. */
  calls: 0,
  findSimilarImpl: null as ((q: string, k: number, ex?: Set<string>) => Promise<Array<{ url: string; score: number }>>) | null,
};

const mockIndex = {
  size: () => mockEmbeddingState.indexSize,
  add: vi.fn(),
  remove: vi.fn(),
  has: vi.fn(),
  get: vi.fn(),
  clear: vi.fn(),
  findSimilar: vi.fn(),
  loadFromBuffers: vi.fn(),
  getAllUrls: vi.fn(),
};

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({
    isAvailable: () => mockEmbeddingState.available,
    isSubprocessReady: () => mockEmbeddingState.subprocessReady,
    ensureProviderReady: vi.fn(async () => mockEmbeddingState.subprocessReady),
    setAvailable: vi.fn(),
    getIndex: () => mockIndex,
    init: vi.fn(),
    embedAsync: vi.fn(),
    embedAndStore: vi.fn().mockResolvedValue(undefined),
    findSimilar: vi.fn(async (q: string, k: number, ex?: Set<string>) => {
      mockEmbeddingState.calls += 1;
      return mockEmbeddingState.findSimilarImpl ? mockEmbeddingState.findSimilarImpl(q, k, ex) : [];
    }),
    shutdown: vi.fn(),
  }),
  resetEmbeddingService: vi.fn(),
  EmbeddingService: class {},
}));

const { initDatabase, closeDatabase, getDatabase } = await import('../../../src/cache/db.js');
const { cacheContent } = await import('../../../src/cache/store.js');
const { recordVisit, searchVisits } = await import('../../../src/cache/visit-store.js');
const { handleCache } = await import('../../../src/tools/cache.js');
const { handleFindSimilar } = await import('../../../src/tools/find-similar.js');
const { resetConfig } = await import('../../../src/config.js');

/**
 * A term that exists ONLY in the visit's stored body. Nonsense on purpose: a real word could
 * be matched through stemming or a co-occurring token in some other corpus, and then a green
 * arm would not be evidence of the partition.
 */
const VISIT_TERM = 'quokkasentinel';
const VISIT_URL = 'https://history.example.com/private-reading';
const VISIT_BODY = `${VISIT_TERM} — a page the human read in their own tab, captured as history.`;

/** The control: an ordinary fetched page carrying the SAME term, which the tools MUST return. */
const CONTROL_URL = 'https://fetched.example.com/doc';
const CONTROL_BODY = `${VISIT_TERM} appears here too, in a page wigolo fetched on an agent's behalf.`;

function seedControlPage(): void {
  const raw: RawFetchResult = {
    url: CONTROL_URL,
    finalUrl: CONTROL_URL,
    html: `<html><body><p>${CONTROL_BODY}</p></body></html>`,
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  const extraction: ExtractionResult = {
    title: 'Control Doc',
    markdown: CONTROL_BODY,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
  cacheContent(raw, extraction);
}

function seedVisit(): void {
  const out = recordVisit({
    url: VISIT_URL,
    title: 'Private Reading',
    ts: '2026-09-03 10:00:00',
    tabId: 'tab-human-1',
    markdown: VISIT_BODY,
  });
  expect(out.stored, 'the visit fixture itself must land, or the arm proves nothing').toBe(true);
  expect(out.bodyStored).toBe(true);
  // The visit IS searchable — through the visits store, and only there. Without this the arms
  // below would pass on a fixture that was never indexed.
  expect(searchVisits({ query: VISIT_TERM }).map((r) => r.url)).toEqual([VISIT_URL]);
}

const engine: SearchEngine = { name: 'mock', search: vi.fn().mockResolvedValue([] satisfies RawSearchResult[]) };
const router = { fetch: vi.fn() } as unknown as SmartRouter;

describe('A-18-5 — the visits corpus is invisible to agent tools', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_LEVEL: 'error' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
    vecState.size = 0;
    vecState.results = [];
    mockEmbeddingState.available = false;
    mockEmbeddingState.subprocessReady = false;
    mockEmbeddingState.indexSize = 2;
    mockEmbeddingState.calls = 0;
    mockEmbeddingState.findSimilarImpl = null;
    seedControlPage();
    seedVisit();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('cache (FTS mode) returns the fetched control and NO visit row', async () => {
    const out = await handleCache({ query: VISIT_TERM, limit: 50 });
    expect(out.error).toBeUndefined();
    const urls = (out.results ?? []).map((r) => r.url);
    expect(urls, 'the control must arrive, or "no visit row" is trivially true').toContain(CONTROL_URL);
    expect(urls).not.toContain(VISIT_URL);
    // Nor under any other identity: no result may carry the visit's body text either.
    expect((out.results ?? []).some((r) => (r.markdown ?? '').includes(VISIT_BODY))).toBe(false);
  });

  it('cache (hybrid mode) returns the fetched control and NO visit row', async () => {
    vecState.size = 2;
    vecState.results = [
      { id: CONTROL_URL, score: 0.9, metadata: { url: CONTROL_URL, contentHash: 'h', modelId: 'test' } },
      // The visit's URL offered to the vector side on purpose: even a caller that hands the
      // hybrid path a visit identity must not get a hydrated visit body back, because the
      // hydration only knows how to read agent-facing rows.
      { id: VISIT_URL, score: 0.95, metadata: { url: VISIT_URL, contentHash: 'h2', modelId: 'test' } },
    ];
    const out = await handleCache({ query: VISIT_TERM, mode: 'hybrid', limit: 50 });
    expect(out.error).toBeUndefined();
    const urls = (out.results ?? []).map((r) => r.url);
    expect(urls).toContain(CONTROL_URL);
    expect(urls).not.toContain(VISIT_URL);
    expect((out.results ?? []).some((r) => (r.markdown ?? '').includes(VISIT_BODY))).toBe(false);
  });

  it('find_similar returns the fetched control and NO visit row', async () => {
    const out = await handleFindSimilar(
      { concept: VISIT_TERM, include_cache: true, include_web: false, include_full_markdown: true },
      [engine],
      router,
    );
    expect(out.ok).toBe(true);
    const results = out.ok ? out.data.results : [];
    const urls = results.map((r) => r.url);
    expect(urls, 'the control must arrive, or "no visit row" is trivially true').toContain(CONTROL_URL);
    expect(urls).not.toContain(VISIT_URL);
    expect(results.some((r) => (r.markdown ?? '').includes(VISIT_BODY))).toBe(false);
  });

  it('find_similar with the embedding lane ON still returns no visit row', async () => {
    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    // The embedding lane is handed the visit's URL as its top hit. Visits are never embedded
    // (no vec partition until seq:451), so the only way this could surface is a hydration path
    // that reads visit rows — which is what must not exist.
    mockEmbeddingState.findSimilarImpl = async () => [
      { url: VISIT_URL, score: 0.99 },
      { url: CONTROL_URL, score: 0.5 },
    ];
    const out = await handleFindSimilar(
      { concept: VISIT_TERM, include_cache: true, include_web: false, include_full_markdown: true },
      [engine],
      router,
    );
    expect(out.ok).toBe(true);
    // The lane must have RUN. Measured 2026-09-03: with the mocked index reporting size 0 this
    // arm passed while the embedding lane was skipped entirely — green because nothing ran.
    expect(mockEmbeddingState.calls, 'the embedding lane did not run — this arm proves nothing').toBeGreaterThan(0);
    const results = out.ok ? out.data.results : [];
    expect(results.map((r) => r.url), 'the control must arrive through the same call').toContain(CONTROL_URL);
    expect(results.map((r) => r.url)).not.toContain(VISIT_URL);
    expect(results.some((r) => (r.markdown ?? '').includes(VISIT_BODY))).toBe(false);
  });

  it('keeps the visits FTS index out of every agent-facing query in src/', () => {
    // Structural, not behavioural: the arms above pin the tools that exist today, and this
    // pins that a NEW agent-facing read cannot reach the tables at all. The visits tables may
    // be named only where the store, its migration and its local-only subpath live.
    const srcRoot = fileURLToPath(new URL('../../../src/', import.meta.url));
    const allowed = new Set([
      join(srcRoot, 'cache', 'visit-store.ts'),
      join(srcRoot, 'cache', 'library.ts'),
      join(srcRoot, 'cache', 'migrations', 'runner.ts'),
    ]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts')) continue;
        if (allowed.has(full)) continue;
        if (/studio_visit/.test(readFileSync(full, 'utf8'))) offenders.push(full.slice(srcRoot.length));
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  it('keeps the visits tables out of the broker wire and the artifact key space', async () => {
    const { BROKER_TABLES } = await import('../../../src/companion-contract/broker.js');
    const { isArtifactKey } = await import('../../../src/cache/artifact-registry.js');
    for (const table of ['studio_visits', 'studio_visit_pages', 'studio_visit_pages_fts', 'studio_visit_site_prefs']) {
      expect(BROKER_TABLES as readonly string[]).not.toContain(table);
    }
    // A visit is addressed by its own URL, not by a `studio://` artifact key, so no artifact
    // provider can be asked to resolve one.
    expect(isArtifactKey(VISIT_URL)).toBe(false);
    expect(
      getDatabase().prepare(`SELECT COUNT(*) AS n FROM studio_artifacts`).get(),
    ).toEqual({ n: 0 });
  });
});
