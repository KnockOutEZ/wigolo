import { describe, it, expect } from 'vitest';
import {
  isBrandCollisionSuspect,
  isIncludeDomainsOverFilter,
  isAllEnginesFailed,
  isTop1HighScoreLowOverlap,
  isEnginePoolCollapsed,
  evaluateSignals,
  SIGNAL_NAMES,
} from '../../../../src/search/hybrid/signals.js';
import type { SearchInput, SearchOutput, SearchResultItem } from '../../../../src/types.js';

function makeOutput(partial: Partial<SearchOutput>): SearchOutput {
  return {
    results: [],
    query: 'q',
    engines_used: [],
    total_time_ms: 0,
    ...partial,
  };
}

function makeResult(title: string, url: string, score = 0.5): SearchResultItem {
  return { title, url, snippet: '', relevance_score: score };
}

describe('isBrandCollisionSuspect', () => {
  it('fires for single-word common noun + brand hostname + low overlap', () => {
    const input: SearchInput = { query: 'next' };
    const output = makeOutput({
      results: [
        makeResult(
          'Next | Online Shopping Clothes Shoes Bags Homeware',
          'https://www.next.co.uk/',
        ),
      ],
    });
    expect(isBrandCollisionSuspect(input, output).fires).toBe(true);
  });

  it('does not fire when query has more than 2 tokens', () => {
    const input: SearchInput = { query: 'next js framework' };
    const output = makeOutput({
      results: [makeResult('Next | Online', 'https://next.co.uk/')],
    });
    expect(isBrandCollisionSuspect(input, output).fires).toBe(false);
  });

  it('does not fire when query token is not in common-noun list', () => {
    const input: SearchInput = { query: 'kubernetes' };
    const output = makeOutput({
      results: [makeResult('Kubernetes', 'https://kubernetes.io/')],
    });
    expect(isBrandCollisionSuspect(input, output).fires).toBe(false);
  });

  it('does not fire when hostname primary label does not match query', () => {
    const input: SearchInput = { query: 'next' };
    const output = makeOutput({
      results: [makeResult('Next.js by Vercel', 'https://nextjs.org/')],
    });
    expect(isBrandCollisionSuspect(input, output).fires).toBe(false);
  });

  it('does not fire when title-query overlap >= 30%', () => {
    const input: SearchInput = { query: 'next' };
    const output = makeOutput({
      results: [makeResult('Next docs', 'https://next.co.uk/')],
    });
    expect(isBrandCollisionSuspect(input, output).fires).toBe(false);
  });

  it('does not fire when there are no results', () => {
    const input: SearchInput = { query: 'next' };
    const output = makeOutput({ results: [] });
    expect(isBrandCollisionSuspect(input, output).fires).toBe(false);
  });

  it('handles array queries by using the first entry', () => {
    const input: SearchInput = { query: ['apple', 'fruit'] };
    const output = makeOutput({
      results: [
        makeResult(
          'Apple Online Store Shopping Products Today Offers',
          'https://apple.com/',
        ),
      ],
    });
    expect(isBrandCollisionSuspect(input, output).fires).toBe(true);
  });
});

describe('isIncludeDomainsOverFilter', () => {
  it('fires when include_domains is set and results < 2', () => {
    const input: SearchInput = { query: 'q', include_domains: ['example.com'] };
    const output = makeOutput({
      results: [makeResult('a', 'https://example.com/a')],
    });
    expect(isIncludeDomainsOverFilter(input, output).fires).toBe(true);
  });

  it('fires when include_domains is set and results = 0', () => {
    const input: SearchInput = { query: 'q', include_domains: ['example.com'] };
    const output = makeOutput({ results: [] });
    expect(isIncludeDomainsOverFilter(input, output).fires).toBe(true);
  });

  it('does not fire when include_domains is empty', () => {
    const input: SearchInput = { query: 'q', include_domains: [] };
    const output = makeOutput({ results: [] });
    expect(isIncludeDomainsOverFilter(input, output).fires).toBe(false);
  });

  it('does not fire when include_domains is unset', () => {
    const input: SearchInput = { query: 'q' };
    const output = makeOutput({ results: [] });
    expect(isIncludeDomainsOverFilter(input, output).fires).toBe(false);
  });

  it('does not fire when >= 2 results returned', () => {
    const input: SearchInput = { query: 'q', include_domains: ['example.com'] };
    const output = makeOutput({
      results: [
        makeResult('a', 'https://example.com/a'),
        makeResult('b', 'https://example.com/b'),
      ],
    });
    expect(isIncludeDomainsOverFilter(input, output).fires).toBe(false);
  });
});

describe('isAllEnginesFailed', () => {
  it('fires when results empty and every engine outcome failed', () => {
    const input: SearchInput = { query: 'q' };
    const output = makeOutput({
      results: [],
      engine_outcomes: [
        { engine: 'bing', ok: false, latency_ms: 1, result_count: 0, error: 'x' },
        { engine: 'ddg', ok: false, latency_ms: 1, result_count: 0, error: 'y' },
      ],
    });
    expect(isAllEnginesFailed(input, output).fires).toBe(true);
  });

  it('does not fire when results non-empty', () => {
    const input: SearchInput = { query: 'q' };
    const output = makeOutput({
      results: [makeResult('a', 'https://a.com/')],
      engine_outcomes: [
        { engine: 'bing', ok: false, latency_ms: 1, result_count: 0 },
      ],
    });
    expect(isAllEnginesFailed(input, output).fires).toBe(false);
  });

  it('does not fire when at least one engine succeeded', () => {
    const input: SearchInput = { query: 'q' };
    const output = makeOutput({
      results: [],
      engine_outcomes: [
        { engine: 'a', ok: true, latency_ms: 1, result_count: 0 },
        { engine: 'b', ok: false, latency_ms: 1, result_count: 0 },
      ],
    });
    expect(isAllEnginesFailed(input, output).fires).toBe(false);
  });

  it('fires when results empty and engine_outcomes absent (degenerate case)', () => {
    const input: SearchInput = { query: 'q' };
    const output = makeOutput({ results: [] });
    expect(isAllEnginesFailed(input, output).fires).toBe(true);
  });
});

describe('isTop1HighScoreLowOverlap', () => {
  it('fires when top1 score >= 0.99 and overlap < 30%', () => {
    const input: SearchInput = { query: 'apple' };
    const output = makeOutput({
      results: [
        makeResult(
          'Apple Online Store Shopping Products Today Offers',
          'https://apple.com/',
          1.0,
        ),
      ],
    });
    expect(isTop1HighScoreLowOverlap(input, output).fires).toBe(true);
  });

  it('does not fire when score < 0.99', () => {
    const input: SearchInput = { query: 'apple' };
    const output = makeOutput({
      results: [makeResult('Apple Online Store', 'https://apple.com/', 0.8)],
    });
    expect(isTop1HighScoreLowOverlap(input, output).fires).toBe(false);
  });

  it('does not fire when overlap >= 30%', () => {
    const input: SearchInput = { query: 'apple ios sdk' };
    const output = makeOutput({
      results: [
        makeResult('apple ios sdk reference', 'https://developer.apple.com/ios', 0.99),
      ],
    });
    expect(isTop1HighScoreLowOverlap(input, output).fires).toBe(false);
  });

  it('does not fire when results empty', () => {
    const input: SearchInput = { query: 'apple' };
    const output = makeOutput({ results: [] });
    expect(isTop1HighScoreLowOverlap(input, output).fires).toBe(false);
  });
});

describe('evaluateSignals', () => {
  it('returns all fired signal names', () => {
    const input: SearchInput = { query: 'next', include_domains: ['next.co.uk'] };
    const output = makeOutput({
      results: [
        makeResult(
          'Next | Online Shopping Bags Clothes Homeware',
          'https://next.co.uk/',
          1.0,
        ),
      ],
    });
    const fired = evaluateSignals(input, output);
    expect(fired).toContain('brand_collision_suspect');
    expect(fired).toContain('include_domains_over_filter');
    expect(fired).toContain('top1_high_score_low_overlap');
  });

  it('returns empty array when no signal fires', () => {
    const input: SearchInput = { query: 'kubernetes operator' };
    const output = makeOutput({
      results: [
        makeResult('Kubernetes Operators', 'https://kubernetes.io/operators', 0.7),
        makeResult('Operator Framework', 'https://operatorframework.io/', 0.6),
      ],
    });
    expect(evaluateSignals(input, output)).toEqual([]);
  });

  it('exports the canonical signal name list', () => {
    expect(SIGNAL_NAMES).toEqual([
      'brand_collision_suspect',
      'include_domains_over_filter',
      'all_engines_failed',
      'top1_high_score_low_overlap',
      'engine_pool_collapsed',
    ]);
  });
});

describe('isEnginePoolCollapsed', () => {
  const someResults = [makeResult('Postgres logical replication', 'https://postgresql.org/docs')];

  it('fires when the core pool collapsed, even though results came back', () => {
    // WHY: this is the case no other signal covers — a search answered by one
    // surviving engine still returns plausible results, so every results-shape
    // signal stays silent while quality is at its worst.
    const output = makeOutput({
      results: someResults,
      engine_pool: { healthy: 1, total: 5, degraded: true, reasons: ['pool_collapsed'] },
    });
    const r = isEnginePoolCollapsed({ query: 'q' }, output);
    expect(r.fires).toBe(true);
    expect(r.reason).toContain('1 of 5');
  });

  it('NEGATIVE: does not fire for a benign thin pool', () => {
    // thin_pool is advisory and common; treating it as a collapse would send
    // most ordinary searches through the fallback backend.
    const output = makeOutput({
      results: someResults,
      engine_pool: { healthy: 2, total: 4, degraded: true, reasons: ['thin_pool'] },
    });
    expect(isEnginePoolCollapsed({ query: 'q' }, output).fires).toBe(false);
  });

  it('NEGATIVE: does not fire for a starvation backfill that recovered recall', () => {
    const output = makeOutput({
      results: someResults,
      engine_pool: {
        healthy: 3,
        total: 6,
        degraded: true,
        reasons: ['starvation_redispatch'],
      },
    });
    expect(isEnginePoolCollapsed({ query: 'q' }, output).fires).toBe(false);
  });

  it('NEGATIVE: does not fire for a healthy pool or when pool health is absent', () => {
    const healthy = makeOutput({
      results: someResults,
      engine_pool: { healthy: 5, total: 5, degraded: false },
    });
    expect(isEnginePoolCollapsed({ query: 'q' }, healthy).fires).toBe(false);
    // Cache hits omit engine_pool entirely — must not fire on a missing field.
    expect(isEnginePoolCollapsed({ query: 'q' }, makeOutput({ results: someResults })).fires).toBe(
      false,
    );
  });

  it('is wired into evaluateSignals under its canonical name', () => {
    const output = makeOutput({
      results: someResults,
      engine_pool: { healthy: 1, total: 5, degraded: true, reasons: ['pool_collapsed'] },
    });
    expect(evaluateSignals({ query: 'q' }, output)).toContain('engine_pool_collapsed');
  });
});
