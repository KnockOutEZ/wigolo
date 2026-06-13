import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawSearchResult } from '../../../../src/types.js';
import type { Config } from '../../../../src/config.js';

const runV1Search = vi.fn();
vi.mock('../../../../src/search/core/orchestrator.js', () => ({ runV1Search }));
vi.mock('../../../../src/search/content-fetch.js', () => ({ fetchContentForResults: vi.fn(async () => {}) }));

// Mock the cross-encoder rerank-fold so we control its OUTPUT directly. This
// is the seam guard: the fold is the step that injects tier-0 near-zero scores
// into `processed`, and the floor MUST run after it. A passthrough default
// keeps the fast-tier tests (where the fold never runs) behaving exactly as
// the real helper would on already-scored input.
const foldRerankIntoOrdering = vi.fn(async (results: RawSearchResult[]) => results);
vi.mock('../../../../src/search/core/rerank-fold.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/search/core/rerank-fold.js')>();
  return { ...actual, foldRerankIntoOrdering };
});

// Mock config so we can flip the reranker on for the balanced-tier seam test
// without touching the others. Default mirrors the keyless path: reranker off
// (fast/balanced both skip the fold), no relevance threshold.
function cfg(over: Partial<Config> = {}): Config {
  // logLevel is read by createLogger() at module-load time (before any
  // beforeEach), so the default must carry it or the import graph throws.
  return { reranker: 'none', relevanceThreshold: 0, logLevel: 'error', ...over } as Config;
}

const getConfig = vi.fn(() => cfg());
vi.mock('../../../../src/config.js', () => ({ getConfig }));

const { CoreSearchProvider } = await import('../../../../src/search/core/core-provider.js');

function res(url: string, score: number): RawSearchResult {
  return { title: url, url, snippet: 's', relevance_score: score, engine: 'e1' };
}

function dispatchOf(results: RawSearchResult[]) {
  return { results, enginesUsed: ['e1'], outcomes: [], degraded: false };
}

describe('core-provider relevance-score floor (final-ordering seam)', () => {
  beforeEach(() => {
    runV1Search.mockReset();
    foldRerankIntoOrdering.mockReset();
    foldRerankIntoOrdering.mockImplementation(async (results: RawSearchResult[]) => results);
    getConfig.mockReset();
    getConfig.mockReturnValue(cfg());
  });

  it('drops the A1 near-zero tail from the returned top-N (fast tier, single dispatch)', async () => {
    // Scores mirror the post-rerank A1 distribution: 3 on-topic above the
    // floor, 2 Cambridge-dictionary results in the tier-0 near-zero band.
    runV1Search.mockResolvedValue(
      dispatchOf([
        res('https://en.wikipedia.org/wiki/Reciprocal_rank_fusion', 1.0),
        res('https://safjan.com/rrf-python', 0.71),
        res('https://plg.uwaterloo.ca/cormack-rrf.pdf', 0.63),
        res('https://dictionary.cambridge.org/dictionary/english/reciprocal', 0.0097),
        res('https://dictionary.cambridge.org/dictionary/english/rank', 0.0003),
      ]),
    );
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'reciprocal rank fusion explained', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const urls = out.data.results.map((r) => r.url);
    expect(urls).not.toContain('https://dictionary.cambridge.org/dictionary/english/reciprocal');
    expect(urls).not.toContain('https://dictionary.cambridge.org/dictionary/english/rank');
    expect(urls).toContain('https://en.wikipedia.org/wiki/Reciprocal_rank_fusion');
    expect(urls).toContain('https://safjan.com/rrf-python');
    expect(urls).toContain('https://plg.uwaterloo.ca/cormack-rrf.pdf');
    expect(out.data.results).toHaveLength(3);
  });

  it('keeps all results when none fall below the floor', async () => {
    runV1Search.mockResolvedValue(
      dispatchOf([res('https://a.com', 1.0), res('https://b.com', 0.4), res('https://c.com', 0.2)]),
    );
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'some query', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results).toHaveLength(3);
  });

  it('never empties the result set even if every score is below the floor', async () => {
    runV1Search.mockResolvedValue(
      dispatchOf([res('https://a.com', 0.004), res('https://b.com', 0.002)]),
    );
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'opaque', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results).toHaveLength(1);
    expect(out.data.results[0].url).toBe('https://a.com');
  });

  it('SEAM GUARD: floor runs AFTER the rerank-fold, not before', async () => {
    // The whole point of the seam is ordering: the rerank-fold is what INJECTS
    // the tier-0 near-zero scores, so the floor only works if it runs after it.
    // Here runV1Search returns BENIGN mid-range scores that would all survive a
    // floor applied before the fold. The (mocked) fold then OUTPUTS the A1
    // near-zero distribution. With the correct ordering the floor drops the
    // tail the fold produced. If a refactor moved applyScoreFloor above
    // foldRerankIntoOrdering, the fold would re-inject the near-zero scores
    // AFTER the floor already ran (the original bug) and this test would FAIL.
    getConfig.mockReturnValue(cfg({ reranker: 'onnx' }));
    runV1Search.mockResolvedValue(
      dispatchOf([
        res('https://en.wikipedia.org/wiki/Reciprocal_rank_fusion', 0.6),
        res('https://safjan.com/rrf-python', 0.55),
        res('https://plg.uwaterloo.ca/cormack-rrf.pdf', 0.52),
        res('https://dictionary.cambridge.org/dictionary/english/reciprocal', 0.51),
        res('https://dictionary.cambridge.org/dictionary/english/rank', 0.5),
      ]),
    );
    // The fold reorders + rescores: on-topic up into the tier-1 band, the two
    // dictionary results down into the tier-0 near-zero band (0.0097 / 0.0003).
    foldRerankIntoOrdering.mockResolvedValue([
      res('https://en.wikipedia.org/wiki/Reciprocal_rank_fusion', 0.98),
      res('https://safjan.com/rrf-python', 0.71),
      res('https://plg.uwaterloo.ca/cormack-rrf.pdf', 0.63),
      res('https://dictionary.cambridge.org/dictionary/english/reciprocal', 0.0097),
      res('https://dictionary.cambridge.org/dictionary/english/rank', 0.0003),
    ]);

    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'reciprocal rank fusion explained', search_depth: 'balanced', include_content: false },
      { router: undefined } as never,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The fold actually ran (balanced + onnx) — this guards the precondition:
    // if the fold were skipped the test would pass vacuously on the benign
    // pre-fold scores, which would NOT pin the ordering invariant.
    expect(foldRerankIntoOrdering).toHaveBeenCalledTimes(1);
    const urls = out.data.results.map((r) => r.url);
    expect(urls).not.toContain('https://dictionary.cambridge.org/dictionary/english/reciprocal');
    expect(urls).not.toContain('https://dictionary.cambridge.org/dictionary/english/rank');
    expect(urls).toContain('https://en.wikipedia.org/wiki/Reciprocal_rank_fusion');
    expect(out.data.results).toHaveLength(3);
  });
});
