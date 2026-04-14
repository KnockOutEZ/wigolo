import { describe, it, expect, expectTypeOf } from 'vitest';
import type { SearchInput, SearchOutput } from '../../src/types.js';

describe('SearchInput multi-query types', () => {
  it('accepts string query', () => {
    const input: SearchInput = { query: 'single query' };
    expectTypeOf(input.query).toMatchTypeOf<string | string[]>();
  });

  it('accepts string[] query', () => {
    const input: SearchInput = { query: ['query one', 'query two'] };
    expectTypeOf(input.query).toMatchTypeOf<string | string[]>();
  });

  it('preserves all existing SearchInput fields', () => {
    const input: SearchInput = {
      query: ['a', 'b'],
      max_results: 10,
      include_content: true,
      content_max_chars: 5000,
      max_total_chars: 50000,
      time_range: 'week',
      search_engines: ['searxng'],
      language: 'en',
      include_domains: ['example.com'],
      exclude_domains: ['spam.com'],
      from_date: '2025-01-01',
      to_date: '2025-12-31',
      category: 'general',
      format: 'context',
    };
    expectTypeOf(input).toMatchTypeOf<SearchInput>();
  });
});

describe('SearchOutput multi-query types', () => {
  it('has queries_executed optional field', () => {
    const output: SearchOutput = {
      results: [],
      query: 'test',
      engines_used: [],
      total_time_ms: 100,
      queries_executed: ['test variant 1', 'test variant 2'],
    };
    expectTypeOf(output.queries_executed).toMatchTypeOf<string[] | undefined>();
  });

  it('queries_executed is optional', () => {
    const output: SearchOutput = {
      results: [],
      query: 'test',
      engines_used: [],
      total_time_ms: 100,
    };
    expect(output.queries_executed).toBeUndefined();
  });
});
