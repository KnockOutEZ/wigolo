import { describe, it, expect } from 'vitest';
import type {
  FetchInput,
  FetchOutput,
  SearchInput,
  SearchOutput,
  SearchResultItem,
  RawSearchResult,
} from '../../src/types.js';

describe('types', () => {
  it('FetchInput accepts minimal input', () => {
    const input: FetchInput = { url: 'https://example.com' };
    expect(input.url).toBe('https://example.com');
    expect(input.render_js).toBeUndefined();
  });

  it('FetchOutput has required fields', () => {
    const output: FetchOutput = {
      url: 'https://example.com',
      title: 'Example',
      markdown: '# Example',
      metadata: {},
      links: [],
      images: [],
      cached: false,
    };
    expect(output.title).toBe('Example');
  });
});

describe('search types', () => {
  it('SearchInput accepts minimal input', () => {
    const input: SearchInput = { query: 'typescript tutorial' };
    expect(input.query).toBe('typescript tutorial');
    expect(input.max_results).toBeUndefined();
    expect(input.include_content).toBeUndefined();
  });

  it('SearchOutput has required fields', () => {
    const output: SearchOutput = {
      results: [],
      query: 'test',
      engines_used: ['searxng'],
      total_time_ms: 150,
    };
    expect(output.results).toEqual([]);
    expect(output.engines_used).toContain('searxng');
  });

  it('SearchResultItem supports content and failure fields', () => {
    const item: SearchResultItem = {
      title: 'Example',
      url: 'https://example.com',
      snippet: 'An example page',
      relevance_score: 0.95,
      markdown_content: '# Example',
    };
    expect(item.fetch_failed).toBeUndefined();
    expect(item.content_truncated).toBeUndefined();
  });

  it('RawSearchResult has engine field', () => {
    const raw: RawSearchResult = {
      title: 'Result',
      url: 'https://example.com',
      snippet: 'Snippet',
      relevance_score: 0.8,
      engine: 'duckduckgo',
    };
    expect(raw.engine).toBe('duckduckgo');
  });
});
