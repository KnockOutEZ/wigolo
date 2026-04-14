import { describe, it, expect } from 'vitest';
import { formatSearchContext } from '../../../src/search/context-formatter.js';
import type { SearchResultItem } from '../../../src/types.js';

function makeResult(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    title: overrides.title ?? 'Test Title',
    url: overrides.url ?? 'https://example.com',
    snippet: overrides.snippet ?? 'A test snippet',
    relevance_score: overrides.relevance_score ?? 0.9,
    markdown_content: overrides.markdown_content,
    fetch_failed: overrides.fetch_failed,
    content_truncated: overrides.content_truncated,
  };
}

describe('formatSearchContext', () => {
  it('formats multiple results within budget', () => {
    const results: SearchResultItem[] = [
      makeResult({
        title: 'React Hooks',
        url: 'https://react.dev/hooks',
        markdown_content: 'React Hooks let you use state and other features without classes.',
      }),
      makeResult({
        title: 'Vue Composition API',
        url: 'https://vuejs.org/api',
        markdown_content: 'The Composition API is a set of function-based APIs.',
      }),
      makeResult({
        title: 'Svelte Stores',
        url: 'https://svelte.dev/stores',
        markdown_content: 'Svelte stores provide reactive state management.',
      }),
    ];

    const text = formatSearchContext(results, 10000);

    expect(text).toContain('Source: React Hooks (https://react.dev/hooks)');
    expect(text).toContain('React Hooks let you use state');
    expect(text).toContain('Source: Vue Composition API (https://vuejs.org/api)');
    expect(text).toContain('Source: Svelte Stores (https://svelte.dev/stores)');
  });

  it('returns empty string for empty results', () => {
    expect(formatSearchContext([], 10000)).toBe('');
  });

  it('returns empty string for zero budget', () => {
    const results = [makeResult({ markdown_content: 'content' })];
    expect(formatSearchContext(results, 0)).toBe('');
  });

  it('truncates content per-result to fit budget with ellipsis', () => {
    const results = [
      makeResult({
        title: 'Long',
        url: 'https://example.com/long',
        markdown_content: 'a'.repeat(5000),
      }),
    ];

    const text = formatSearchContext(results, 200);

    expect(text).toContain('Source: Long (https://example.com/long)');
    expect(text).toContain('...');
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it('stops adding results when next result would not fit', () => {
    const results = [
      makeResult({
        title: 'First',
        url: 'https://a.com',
        markdown_content: 'First content here.',
      }),
      makeResult({
        title: 'Second',
        url: 'https://b.com',
        markdown_content: 'Second content here that is also reasonably long and would push us over budget.',
      }),
    ];

    const headerLen = 'Source: First (https://a.com)\n'.length;
    const contentLen = 'First content here.'.length;
    const budget = headerLen + contentLen + 5;

    const text = formatSearchContext(results, budget);

    expect(text).toContain('Source: First');
    expect(text).not.toContain('Source: Second');
  });

  it('falls back to snippet when markdown_content is absent', () => {
    const results = [
      makeResult({
        title: 'Snippet Only',
        url: 'https://snippet.com',
        snippet: 'This is the snippet text',
        markdown_content: undefined,
      }),
    ];

    const text = formatSearchContext(results, 10000);
    expect(text).toContain('This is the snippet text');
  });

  it('falls back to snippet when fetch_failed is set', () => {
    const results = [
      makeResult({
        title: 'Failed Fetch',
        url: 'https://failed.com',
        snippet: 'Fallback snippet',
        markdown_content: undefined,
        fetch_failed: 'timeout',
      }),
    ];

    const text = formatSearchContext(results, 10000);
    expect(text).toContain('Fallback snippet');
  });

  it('handles unicode content correctly', () => {
    const results = [
      makeResult({
        title: 'Unicode Test',
        url: 'https://example.com/unicode',
        markdown_content: 'React 18 hat viele Verbesserungen.',
      }),
    ];

    const text = formatSearchContext(results, 10000);
    expect(text).toContain('React 18 hat viele Verbesserungen');
  });

  it('handles very long titles gracefully', () => {
    const longTitle = 'T'.repeat(500);
    const results = [
      makeResult({
        title: longTitle,
        url: 'https://example.com',
        markdown_content: 'content',
      }),
    ];

    const text = formatSearchContext(results, 10000);
    expect(text).toContain('Source:');
    expect(text).toContain('content');
  });

  it('handles very long URLs gracefully', () => {
    const longUrl = 'https://example.com/' + 'path/'.repeat(100);
    const results = [
      makeResult({
        title: 'Long URL',
        url: longUrl,
        markdown_content: 'content',
      }),
    ];

    const text = formatSearchContext(results, 10000);
    expect(text).toContain('Source: Long URL');
  });

  it('distributes budget across multiple results', () => {
    const results = [
      makeResult({ title: 'A', url: 'https://a.com', markdown_content: 'x'.repeat(200) }),
      makeResult({ title: 'B', url: 'https://b.com', markdown_content: 'y'.repeat(200) }),
      makeResult({ title: 'C', url: 'https://c.com', markdown_content: 'z'.repeat(200) }),
    ];

    const text = formatSearchContext(results, 10000);
    expect(text).toContain('Source: A');
    expect(text).toContain('Source: B');
    expect(text).toContain('Source: C');
  });

  it('first result always included even if it exceeds budget', () => {
    const results = [
      makeResult({
        title: 'Only',
        url: 'https://only.com',
        markdown_content: 'a'.repeat(1000),
      }),
    ];

    const text = formatSearchContext(results, 50);
    expect(text).toContain('Source: Only');
    expect(text.length).toBeLessThanOrEqual(50);
  });

  it('separates results with double newline', () => {
    const results = [
      makeResult({ title: 'A', url: 'https://a.com', markdown_content: 'first' }),
      makeResult({ title: 'B', url: 'https://b.com', markdown_content: 'second' }),
    ];

    const text = formatSearchContext(results, 10000);
    expect(text).toContain('\n\n');
  });

  it('produces no trailing whitespace or newlines', () => {
    const results = [
      makeResult({ title: 'A', url: 'https://a.com', markdown_content: 'content' }),
    ];

    const text = formatSearchContext(results, 10000);
    expect(text).toBe(text.trimEnd());
  });

  it('handles result with empty content and empty snippet', () => {
    const results = [
      makeResult({
        title: 'Empty',
        url: 'https://empty.com',
        snippet: '',
        markdown_content: '',
      }),
    ];

    const text = formatSearchContext(results, 10000);
    expect(text).toContain('Source: Empty');
  });
});
