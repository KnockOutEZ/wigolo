import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SearchOutput } from '../../../src/types.js';
import { isDatabaseInitialized } from '../../../src/cache/db.js';

/**
 * The SERP's injected broker stage (`wigolo/companion-stages`), beside the two in `stages.test.ts`.
 *
 * What is worth pinning here is the ADAPTATION, not the search pipeline underneath — that has its own
 * suites. Four things can silently break the in-app SERP and none of them is visible from the pipeline
 * side: whether the input crosses unreshaped (a dropped `search_depth` answers at `balanced` while the
 * view's header says `deep`), whether the output crosses unreshaped (a projection strips the
 * `evidence_score` breakdown the SERP view exists to render), whether a refusal throws or arrives as
 * an empty result set the view cannot tell from "the engines had nothing", and whether the module
 * opens a database from the side that does not own the file.
 */
const handleSearch = vi.fn();
const embeddingInit = vi.fn();

vi.mock('../../../src/tools/search.js', () => ({
  handleSearch: (...args: unknown[]) => handleSearch(...args),
}));
vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({ init: () => embeddingInit() }),
}));

const { createSearchStage, SearchStageError, FindSimilarStageError } = await import(
  '../../../src/companion/stages.js'
);

/**
 * A result carrying the full component breakdown. Hand-built rather than minimal on purpose: the
 * fields below are exactly what `SerpResultDto`/`EvidenceScoreDto` put on the wire in #366 and what
 * the SERP's evidence chips read, so a stage that projected results would drop them here.
 */
const OUTPUT = {
  query: 'local first search',
  engines_used: ['bing'],
  total_time_ms: 12,
  results: [
    {
      title: 'Local-first software',
      url: 'https://example.dev/local-first',
      snippet: 'A page about local-first software.',
      relevance_score: 0.81,
      evidence_score: {
        final: 0.81,
        components: {
          base_rrf: 0.016,
          context_cosine: 0.42,
          domain_quality: 1.1,
          lexical_alignment: 0.66,
          recency_boost: 1,
          engine_consensus: 2,
          cross_encoder: 0.74,
          rare_terms: 1.2,
        },
        explanation: 'two engines agreed; strong lexical alignment',
      },
    },
  ],
} as unknown as SearchOutput;

beforeEach(() => {
  handleSearch.mockReset();
  embeddingInit.mockReset();
  embeddingInit.mockResolvedValue(undefined);
});

describe('createSearchStage', () => {
  it('answers with the handler payload unwrapped, not the StageResult envelope', async () => {
    handleSearch.mockResolvedValue({ ok: true, data: OUTPUT });

    // The app reads `out.results`; an envelope would make every hit invisible while the call succeeds.
    await expect(createSearchStage()({ query: 'local first search' })).resolves.toBe(OUTPUT);
  });

  it('binds core-built engines, a router and a backend status, and offers no sampling peer', async () => {
    handleSearch.mockResolvedValue({ ok: true, data: OUTPUT });

    await createSearchStage()({ query: 'local first search' });

    const [, engines, router, backendStatus, samplingServer, onProgress] = handleSearch.mock
      .calls[0] as [unknown, unknown[], unknown, unknown, unknown, unknown];
    // Two built-in engines is core's own construction; an empty array would be a stage that silently
    // cannot answer, and `undefined` collaborators would throw deep inside the pipeline.
    expect(engines).toHaveLength(2);
    expect(router).toBeDefined();
    expect(backendStatus).toBeDefined();
    // The SERP has no MCP sampling peer and nothing on the IPC path consumes a progress tick; passing
    // either would advertise a capability the surface does not have.
    expect(samplingServer).toBeUndefined();
    expect(onProgress).toBeUndefined();
  });

  it('crosses the input unreshaped, so search_depth reaches the provider that spends it', async () => {
    handleSearch.mockResolvedValue({ ok: true, data: OUTPUT });

    const input = {
      query: 'local first search',
      search_depth: 'deep',
      max_results: 5,
      include_domains: ['example.dev'],
    } as const;
    await createSearchStage()({ ...input });

    // Whole-object equality, deliberately: the depth tier changes reranking and content-fetch budgets
    // inside the core provider, so a stage that normalised or dropped a field would answer at
    // `balanced` while the SERP header said `deep` — and nothing downstream could tell.
    expect(handleSearch.mock.calls[0]![0]).toEqual(input);
  });

  it('preserves the full evidence_score breakdown the SERP chips render', async () => {
    handleSearch.mockResolvedValue({ ok: true, data: OUTPUT });

    const out = await createSearchStage()({ query: 'local first search' });

    const evidence = out.results[0]!.evidence_score!;
    expect(evidence.final).toBe(0.81);
    expect(evidence.explanation).toBe('two engines agreed; strong lexical alignment');
    // Named component-by-component rather than by object identity: the view reads these keys, and a
    // stage that rebuilt a result from `title`/`url`/`score` would still return a plausible result.
    expect(Object.keys(evidence.components).sort()).toEqual([
      'base_rrf',
      'context_cosine',
      'cross_encoder',
      'domain_quality',
      'engine_consensus',
      'lexical_alignment',
      'rare_terms',
      'recency_boost',
    ]);
  });

  it('throws a typed refusal carrying the handler code rather than an empty result set', async () => {
    handleSearch.mockResolvedValue({
      ok: false,
      error: 'invalid_input',
      error_reason: 'Query is empty',
      stage: 'search',
    });

    const err = await createSearchStage()({ query: '  ' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SearchStageError);
    // An empty `SearchOutput` is a legitimate answer, so a refusal that degraded to one would be
    // indistinguishable from a real query the engines had nothing for.
    expect((err as InstanceType<typeof SearchStageError>).code).toBe('invalid_input');
    expect((err as Error).message).toBe('Query is empty');
    // Its own class: the SERP branches on which rail refused without string-matching a message.
    expect(err).not.toBeInstanceOf(FindSimilarStageError);
  });

  it('initialises the embedding service once per factory, not once per call', async () => {
    handleSearch.mockResolvedValue({ ok: true, data: OUTPUT });

    const stage = createSearchStage();
    await stage({ query: 'a' });
    await stage({ query: 'b' });

    // The init provisions the vector store and runs the legacy migration; per-call would pay it on
    // every SERP query.
    expect(embeddingInit).toHaveBeenCalledTimes(1);
  });

  it('still answers when the embedding init fails — it is not a ranking input', async () => {
    embeddingInit.mockRejectedValue(new Error('sqlite-vec unavailable'));
    handleSearch.mockResolvedValue({ ok: true, data: OUTPUT });

    await expect(createSearchStage()({ query: 'a' })).resolves.toBe(OUTPUT);
  });

  it('skips the embedding init when the caller already ran initSubsystems in-process', async () => {
    handleSearch.mockResolvedValue({ ok: true, data: OUTPUT });

    await createSearchStage({ skipEmbeddingInit: true })({ query: 'a' });

    expect(embeddingInit).not.toHaveBeenCalled();
  });

  it('opens no database — the host owns the handle, this module borrows it', async () => {
    handleSearch.mockResolvedValue({ ok: true, data: OUTPUT });

    // Asserted against the REAL `cache/db` module, not a spy on one call site: the claim is that
    // NOTHING in the factory's construction or its call path mints a handle, and the global flag is
    // the one signal that a second `initDatabase` from the side that does not own the file would move.
    expect(isDatabaseInitialized()).toBe(false);
    const stage = createSearchStage();
    expect(isDatabaseInitialized()).toBe(false);
    await stage({ query: 'a' });
    expect(isDatabaseInitialized()).toBe(false);
  });
});
