import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawSearchResult } from '../../../../src/types.js';
import type { Config } from '../../../../src/config.js';

const runV1Search = vi.fn();
vi.mock('../../../../src/search/core/orchestrator.js', () => ({ runV1Search }));
vi.mock('../../../../src/search/content-fetch.js', () => ({ fetchContentForResults: vi.fn(async () => {}) }));

function cfg(over: Partial<Config> = {}): Config {
  return { reranker: 'none', relevanceThreshold: 0, logLevel: 'error', ...over } as Config;
}
const getConfig = vi.fn(() => cfg());
vi.mock('../../../../src/config.js', () => ({ getConfig }));

const { CoreSearchProvider } = await import('../../../../src/search/core/core-provider.js');

function res(url: string, score: number, engine: string): RawSearchResult {
  return { title: url, url, snippet: 's', relevance_score: score, engine };
}

function dispatchOf(results: RawSearchResult[]) {
  return { results, enginesUsed: [...new Set(results.map((r) => r.engine))], outcomes: [], degraded: false };
}

describe('core-provider kept-0 floor (dominant vertical vs correct general-engine results)', () => {
  beforeEach(() => {
    runV1Search.mockReset();
    getConfig.mockReset();
    getConfig.mockReturnValue(cfg());
  });

  it('rescues the correct-entity general-engine result the dominant vertical would floor out', async () => {
    // The kept-0 scenario: the docs vertical (mdn) returned wrong-entity
    // glossary pages that score high (they literally contain the query's
    // doc-phrase tokens), while the general engine (bing) returned
    // correct-entity results that all landed in the tier-0 near-zero band and
    // would be floored to 0/N by the query-wide floor.
    runV1Search.mockResolvedValue(
      dispatchOf([
        res('https://developer.mozilla.org/glossary-wrong-1', 0.95, 'mdn'),
        res('https://developer.mozilla.org/glossary-wrong-2', 0.85, 'mdn'),
        res('https://developer.mozilla.org/glossary-wrong-3', 0.75, 'mdn'),
        res('https://correct-entity.example/a', 0.03, 'bing'),
        res('https://correct-entity.example/b', 0.02, 'bing'),
        res('https://correct-entity.example/c', 0.01, 'bing'),
      ]),
    );
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'ambiguous docs phrase', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const urls = out.data.results.map((r) => r.url);
    // The general engine (bing) is NOT floored to zero — its best correct-entity
    // result survives so the kept set is like-for-like across engines.
    expect(urls).toContain('https://correct-entity.example/a');
    // The dominant vertical still keeps its on-merit survivors.
    expect(urls).toContain('https://developer.mozilla.org/glossary-wrong-1');
    // Budget-bounded: only bing's best is rescued, not its whole tail.
    expect(urls).not.toContain('https://correct-entity.example/b');
    expect(urls).not.toContain('https://correct-entity.example/c');
  });

  it('does NOT rescue a floored engine whose sole survivor is genuine off-topic junk (fast path)', async () => {
    // On the fast/none path there is no rerank guard to damp junk first, so the
    // floor's rescue must itself refuse pure junk: an engine that returned only
    // far-below-floor off-topic results stays fully dropped — the rescue is for
    // correct-entity results that landed JUST below the floor, not any junk.
    runV1Search.mockResolvedValue(
      dispatchOf([
        res('https://developer.mozilla.org/a', 0.95, 'mdn'),
        res('https://developer.mozilla.org/b', 0.85, 'mdn'),
        res('https://off-topic-junk.example/x', 0.006, 'bing'),
        res('https://off-topic-junk.example/y', 0.004, 'bing'),
      ]),
    );
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'ambiguous docs phrase', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const urls = out.data.results.map((r) => r.url);
    // The junk engine is NOT rescued — its far-below-floor results stay dropped.
    expect(urls).not.toContain('https://off-topic-junk.example/x');
    expect(urls).not.toContain('https://off-topic-junk.example/y');
    expect(urls).toContain('https://developer.mozilla.org/a');
  });

  it('does NOT rescue when the general engine already has an above-floor survivor', async () => {
    runV1Search.mockResolvedValue(
      dispatchOf([
        res('https://developer.mozilla.org/a', 0.95, 'mdn'),
        res('https://correct.example/top', 0.6, 'bing'),
        res('https://correct.example/junk', 0.01, 'bing'),
      ]),
    );
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'ambiguous docs phrase', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const urls = out.data.results.map((r) => r.url);
    expect(urls).toContain('https://correct.example/top');
    // bing is already represented above the floor; its junk is NOT rescued.
    expect(urls).not.toContain('https://correct.example/junk');
  });
});
