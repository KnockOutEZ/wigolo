import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatSearchResults,
  formatFetchResult,
  formatCrawlResult,
  formatMapResult,
  formatExtractResult,
  formatCacheResult,
  stripAnsi,
} from '../../../src/repl/formatters.js';
import type {
  SearchOutput,
  FetchOutput,
  CrawlOutput,
  MapOutput,
  ExtractOutput,
  CacheOutput,
} from '../../../src/types.js';

function normalizeWhitespace(text: string): string {
  return text.split('\n').map(l => l.trimEnd()).join('\n').trim();
}

function readGolden(name: string): string {
  return normalizeWhitespace(readFileSync(
    join(import.meta.dirname, '..', '..', 'fixtures', 'repl', 'golden', name),
    'utf-8',
  ));
}

describe('formatSearchResults', () => {
  const searchOutput: SearchOutput = {
    results: [
      { title: 'React Server Components', url: 'https://react.dev', snippet: 'React Server Components are a new kind of Component...', relevance_score: 0.95 },
      { title: 'Understanding RSC', url: 'https://vercel.com', snippet: 'RSC enables a new mental model...', relevance_score: 0.88 },
      { title: 'Server Components Deep Dive', url: 'https://blog.example.com', snippet: 'A deep dive into the internals of RSC...', relevance_score: 0.75 },
    ],
    query: 'react server components',
    engines_used: ['searxng'],
    total_time_ms: 150,
  };

  it('produces colored output matching golden file (stripped of ANSI)', () => {
    const formatted = formatSearchResults(searchOutput);
    const stripped = normalizeWhitespace(stripAnsi(formatted));
    const golden = readGolden('search.txt');
    expect(stripped).toBe(golden);
  });

  it('returns non-empty formatted string', () => {
    const formatted = formatSearchResults(searchOutput);
    expect(formatted.length).toBeGreaterThan(0);
    const stripped = stripAnsi(formatted);
    expect(stripped).toContain('react server components');
    expect(stripped).toContain('React Server Components');
  });

  it('handles empty results', () => {
    const empty: SearchOutput = {
      results: [],
      query: 'nothing',
      engines_used: [],
      total_time_ms: 50,
      error: 'No results found',
    };
    const formatted = formatSearchResults(empty);
    expect(stripAnsi(formatted)).toContain('No results found');
  });

  it('handles results with warning', () => {
    const withWarning: SearchOutput = {
      ...searchOutput,
      warning: 'SearXNG unavailable',
    };
    const formatted = formatSearchResults(withWarning);
    expect(stripAnsi(formatted)).toContain('SearXNG unavailable');
  });

  it('truncates very long snippets to 200 chars', () => {
    const longSnippet: SearchOutput = {
      results: [
        { title: 'Long', url: 'https://example.com', snippet: 'a'.repeat(500), relevance_score: 1 },
      ],
      query: 'test',
      engines_used: ['stub'],
      total_time_ms: 10,
    };
    const formatted = stripAnsi(formatSearchResults(longSnippet));
    expect(formatted.length).toBeLessThan(800);
  });
});

describe('formatFetchResult', () => {
  const fetchOutput: FetchOutput = {
    url: 'https://react.dev/reference/rsc/server-components',
    title: 'Server Components',
    markdown: '# Server Components\n\nServer Components are a new kind of Component that renders ahead of time...',
    metadata: {},
    links: [],
    images: [],
    cached: false,
  };

  it('produces output matching golden file (stripped)', () => {
    const formatted = formatFetchResult(fetchOutput);
    const stripped = normalizeWhitespace(stripAnsi(formatted));
    const golden = readGolden('fetch.txt');
    expect(stripped).toBe(golden);
  });

  it('shows cached indicator when cached is true', () => {
    const cachedOutput = { ...fetchOutput, cached: true };
    const formatted = stripAnsi(formatFetchResult(cachedOutput));
    expect(formatted).toContain('cached: true');
  });

  it('shows error when present', () => {
    const errorOutput: FetchOutput = {
      url: 'https://fail.com',
      title: '',
      markdown: '',
      metadata: {},
      links: [],
      images: [],
      cached: false,
      error: 'Connection refused',
    };
    const formatted = stripAnsi(formatFetchResult(errorOutput));
    expect(formatted).toContain('Connection refused');
  });

  it('handles empty markdown', () => {
    const emptyOutput = { ...fetchOutput, markdown: '' };
    const formatted = stripAnsi(formatFetchResult(emptyOutput));
    expect(formatted).toContain('0 chars');
  });
});

describe('formatCrawlResult', () => {
  const crawlOutput: CrawlOutput = {
    pages: [
      { url: 'https://docs.example.com/docs/intro', title: 'Introduction', markdown: 'a'.repeat(1204), depth: 0 },
      { url: 'https://docs.example.com/docs/quickstart', title: 'Quickstart', markdown: 'b'.repeat(893), depth: 1 },
      { url: 'https://docs.example.com/docs/api', title: 'API Reference', markdown: 'c'.repeat(2105), depth: 1 },
    ],
    total_found: 47,
    crawled: 3,
  };

  it('produces output matching golden file (stripped)', () => {
    const formatted = formatCrawlResult(crawlOutput, 'https://docs.example.com');
    const stripped = normalizeWhitespace(stripAnsi(formatted));
    const golden = readGolden('crawl.txt');
    expect(stripped).toBe(golden);
  });

  it('handles empty pages', () => {
    const emptyOutput: CrawlOutput = { pages: [], total_found: 0, crawled: 0 };
    const formatted = stripAnsi(formatCrawlResult(emptyOutput, 'https://empty.com'));
    expect(formatted).toContain('0 pages');
  });

  it('handles crawl error', () => {
    const errorOutput: CrawlOutput = { pages: [], total_found: 0, crawled: 0, error: 'Timeout' };
    const formatted = stripAnsi(formatCrawlResult(errorOutput, 'https://fail.com'));
    expect(formatted).toContain('Timeout');
  });
});

describe('formatExtractResult', () => {
  const extractOutput: ExtractOutput = {
    data: [
      { caption: undefined, headers: ['Plan', 'Price', 'Features'], rows: [
        { Plan: 'Free', Price: '$0', Features: '1000/mo' },
        { Plan: 'Pro', Price: '$29', Features: 'Unlimited' },
      ]},
    ],
    source_url: 'https://example.com/pricing',
    mode: 'tables',
  };

  it('produces output matching golden file (stripped)', () => {
    const formatted = formatExtractResult(extractOutput);
    const stripped = normalizeWhitespace(stripAnsi(formatted));
    const golden = readGolden('extract.txt');
    expect(stripped).toBe(golden);
  });

  it('handles selector mode with string data', () => {
    const selectorOutput: ExtractOutput = {
      data: 'Hello World',
      mode: 'selector',
    };
    const formatted = stripAnsi(formatExtractResult(selectorOutput));
    expect(formatted).toContain('Hello World');
  });

  it('handles metadata mode', () => {
    const metaOutput: ExtractOutput = {
      data: { title: 'My Page', description: 'A description', author: 'Jane' },
      mode: 'metadata',
    };
    const formatted = stripAnsi(formatExtractResult(metaOutput));
    expect(formatted).toContain('My Page');
    expect(formatted).toContain('A description');
  });

  it('handles schema mode with object data', () => {
    const schemaOutput: ExtractOutput = {
      data: { name: 'Widget', price: '$9.99' },
      mode: 'schema',
    };
    const formatted = stripAnsi(formatExtractResult(schemaOutput));
    expect(formatted).toContain('Widget');
    expect(formatted).toContain('$9.99');
  });

  it('handles error', () => {
    const errorOutput: ExtractOutput = { data: {}, mode: 'metadata', error: 'Parse failed' };
    const formatted = stripAnsi(formatExtractResult(errorOutput));
    expect(formatted).toContain('Parse failed');
  });
});

describe('formatCacheResult', () => {
  it('formats stats matching golden file (stripped)', () => {
    const statsOutput: CacheOutput = {
      stats: {
        total_urls: 42,
        total_size_mb: 12.5,
        oldest: '2024-01-15T10:30:00Z',
        newest: '2024-03-20T14:22:00Z',
      },
    };
    const formatted = formatCacheResult(statsOutput);
    const stripped = normalizeWhitespace(stripAnsi(formatted));
    const golden = readGolden('cache-stats.txt');
    expect(stripped).toBe(golden);
  });

  it('formats search results', () => {
    const searchOutput: CacheOutput = {
      results: [
        { url: 'https://react.dev/hooks', title: 'React Hooks', markdown: 'content...', fetched_at: '2024-03-20T14:22:00Z' },
      ],
    };
    const formatted = stripAnsi(formatCacheResult(searchOutput));
    expect(formatted).toContain('https://react.dev/hooks');
    expect(formatted).toContain('React Hooks');
  });

  it('formats clear result', () => {
    const clearOutput: CacheOutput = { cleared: 5 };
    const formatted = stripAnsi(formatCacheResult(clearOutput));
    expect(formatted).toContain('5');
    expect(formatted).toContain('cleared');
  });

  it('formats error', () => {
    const errorOutput: CacheOutput = { error: 'DB locked' };
    const formatted = stripAnsi(formatCacheResult(errorOutput));
    expect(formatted).toContain('DB locked');
  });

  it('handles empty search results', () => {
    const emptyOutput: CacheOutput = { results: [] };
    const formatted = stripAnsi(formatCacheResult(emptyOutput));
    expect(formatted).toContain('No cached');
  });
});

describe('formatMapResult', () => {
  it('formats map output with URL list', () => {
    const output: MapOutput = {
      urls: ['https://example.com/', 'https://example.com/about', 'https://example.com/docs'],
      total_found: 3,
      sitemap_found: true,
    };
    const formatted = stripAnsi(formatMapResult(output, 'https://example.com'));
    expect(formatted).toContain('Map:');
    expect(formatted).toContain('3 URLs found');
    expect(formatted).toContain('sitemap: yes');
    expect(formatted).toContain('/about');
    expect(formatted).toContain('/docs');
  });

  it('formats empty map output', () => {
    const output: MapOutput = {
      urls: [],
      total_found: 0,
      sitemap_found: false,
    };
    const formatted = stripAnsi(formatMapResult(output, 'https://example.com'));
    expect(formatted).toContain('No URLs found');
  });

  it('formats map output with error', () => {
    const output: MapOutput = {
      urls: [],
      total_found: 0,
      sitemap_found: false,
      error: 'timeout',
    };
    const formatted = stripAnsi(formatMapResult(output, 'https://example.com'));
    expect(formatted).toContain('timeout');
  });
});

describe('stripAnsi', () => {
  it('removes ANSI escape codes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
  });

  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});
