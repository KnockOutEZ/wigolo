import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadQueries,
  loadRelevanceJudgments,
  filterQueries,
  runSingleQueryBenchmark,
  runSearchBenchmark,
} from '../../../../benchmarks/search/runner.js';
import type { BenchmarkQuery } from '../../../../benchmarks/search/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

import { readFileSync, existsSync } from 'node:fs';

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleQueries = {
  version: '1.0.0',
  queries: [
    { id: 'q1', query: 'typescript generics', category: 'docs', tags: ['typescript'] },
    { id: 'q2', query: 'Cannot read properties of undefined', category: 'error', tags: ['javascript'] },
    { id: 'q3', query: 'event loop explanation', category: 'conceptual' },
  ],
};

const sampleRelevance = {
  version: '1.0.0',
  judgments: [
    { queryId: 'q1', url: 'https://ts.org/docs/generics', grade: 3 },
    { queryId: 'q1', url: 'https://example.com/blog', grade: 1 },
    { queryId: 'q2', url: 'https://stackoverflow.com/q/123', grade: 3 },
  ],
};

describe('loadQueries', () => {
  it('loads and parses queries JSON', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleQueries));
    const queries = loadQueries('/path/to/queries.json');
    expect(queries).toHaveLength(3);
    expect(queries[0].id).toBe('q1');
  });

  it('throws for invalid JSON', () => {
    mockReadFileSync.mockReturnValue('bad json');
    expect(() => loadQueries('/path')).toThrow();
  });

  it('throws for missing queries field', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));
    expect(() => loadQueries('/path')).toThrow();
  });

  it('throws for empty queries', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ queries: [] }));
    expect(() => loadQueries('/path')).toThrow();
  });
});

describe('loadRelevanceJudgments', () => {
  it('loads and parses relevance judgments', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleRelevance));
    const judgments = loadRelevanceJudgments('/path/to/relevance.json');
    expect(judgments).toHaveLength(3);
    expect(judgments[0].queryId).toBe('q1');
  });

  it('throws for invalid JSON', () => {
    mockReadFileSync.mockReturnValue('invalid');
    expect(() => loadRelevanceJudgments('/path')).toThrow();
  });

  it('throws for missing judgments field', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));
    expect(() => loadRelevanceJudgments('/path')).toThrow();
  });
});

describe('filterQueries', () => {
  const queries: BenchmarkQuery[] = sampleQueries.queries as BenchmarkQuery[];

  it('returns all when no filter', () => {
    expect(filterQueries(queries)).toHaveLength(3);
  });

  it('filters by category', () => {
    const filtered = filterQueries(queries, 'docs');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('q1');
  });

  it('filters by ID substring', () => {
    const filtered = filterQueries(queries, 'q2');
    expect(filtered).toHaveLength(1);
  });

  it('filters by tag', () => {
    const filtered = filterQueries(queries, 'typescript');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('q1');
  });

  it('returns empty for non-matching filter', () => {
    expect(filterQueries(queries, 'nonexistent')).toHaveLength(0);
  });
});

describe('runSingleQueryBenchmark', () => {
  it('returns metrics for successful search', async () => {
    const query: BenchmarkQuery = { id: 'q1', query: 'test', category: 'docs' };
    const mockResults = [
      { title: 'Result', url: 'https://ts.org/docs/generics', snippet: 'Test', relevance_score: 0.9 },
    ];
    const judgments = sampleRelevance.judgments as any[];

    const result = await runSingleQueryBenchmark(
      query,
      async () => mockResults,
      judgments,
    );

    expect(result.queryId).toBe('q1');
    expect(result.mrr).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('captures errors from search execution', async () => {
    const query: BenchmarkQuery = { id: 'q-err', query: 'test', category: 'error' };

    const result = await runSingleQueryBenchmark(
      query,
      async () => { throw new Error('search timeout'); },
      [],
    );

    expect(result.error).toBe('search timeout');
    expect(result.mrr).toBe(0);
  });

  it('handles empty search results', async () => {
    const query: BenchmarkQuery = { id: 'q-empty', query: 'test', category: 'docs' };

    const result = await runSingleQueryBenchmark(
      query,
      async () => [],
      [],
    );

    expect(result.resultCount).toBe(0);
    expect(result.hasRelevantResult).toBe(false);
  });
});

describe('runSearchBenchmark', () => {
  it('throws when queries path does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(runSearchBenchmark({
      queriesPath: '/nonexistent',
      relevancePath: '/rel',
      responsesDir: '/resp',
      outputDir: '/out',
    })).rejects.toThrow();
  });
});
