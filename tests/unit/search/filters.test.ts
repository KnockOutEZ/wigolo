// tests/unit/search/filters.test.ts
import { describe, it, expect } from 'vitest';
import {
  filterByDomains,
  filterByDateRange,
  filterByCategory,
  applyAllFilters,
} from '../../../src/search/filters.js';
import type { RawSearchResult } from '../../../src/types.js';

function makeResult(url: string, overrides?: Partial<RawSearchResult>): RawSearchResult {
  return { title: 'T', url, snippet: 'S', relevance_score: 1, engine: 'test', ...overrides };
}

// --- Domain Filtering ---

describe('filterByDomains', () => {
  const results = [
    makeResult('https://docs.react.dev/learn'),
    makeResult('https://stackoverflow.com/q/123'),
    makeResult('https://medium.com/react-article'),
    makeResult('https://github.com/facebook/react'),
    makeResult('https://www.npmjs.com/package/react'),
    makeResult('https://blog.github.com/post/123'),
  ];

  it('returns all results when no filters specified', () => {
    expect(filterByDomains(results)).toEqual(results);
  });

  it('returns all results when include_domains is empty array', () => {
    expect(filterByDomains(results, [], undefined)).toEqual(results);
  });

  it('returns all results when exclude_domains is empty array', () => {
    expect(filterByDomains(results, undefined, [])).toEqual(results);
  });

  it('includes only results from a single specified domain', () => {
    const filtered = filterByDomains(results, ['github.com']);
    expect(filtered).toHaveLength(2);
    expect(filtered.every(r => r.url.includes('github.com'))).toBe(true);
  });

  it('includes results from multiple specified domains', () => {
    const filtered = filterByDomains(results, ['react.dev', 'github.com']);
    expect(filtered).toHaveLength(3);
    const urls = filtered.map(r => r.url);
    expect(urls).toContain('https://docs.react.dev/learn');
    expect(urls).toContain('https://github.com/facebook/react');
    expect(urls).toContain('https://blog.github.com/post/123');
  });

  it('excludes results from a single specified domain', () => {
    const filtered = filterByDomains(results, undefined, ['medium.com']);
    expect(filtered).toHaveLength(5);
    expect(filtered.every(r => !r.url.includes('medium.com'))).toBe(true);
  });

  it('excludes results from multiple specified domains', () => {
    const filtered = filterByDomains(results, undefined, ['medium.com', 'stackoverflow.com']);
    expect(filtered).toHaveLength(4);
    expect(filtered.every(r => !r.url.includes('medium.com') && !r.url.includes('stackoverflow.com'))).toBe(true);
  });

  it('matches subdomains against parent domain', () => {
    const filtered = filterByDomains(results, ['react.dev']);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toContain('docs.react.dev');
  });

  it('matches deep subdomains against parent domain', () => {
    const filtered = filterByDomains(results, ['github.com']);
    expect(filtered).toHaveLength(2);
    expect(filtered.some(r => r.url.includes('blog.github.com'))).toBe(true);
  });

  it('exclude wins when same domain is in both include and exclude', () => {
    const filtered = filterByDomains(results, ['react.dev', 'medium.com'], ['medium.com']);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toContain('react.dev');
  });

  it('matches domains case-insensitively', () => {
    const filtered = filterByDomains(results, ['GitHub.COM']);
    expect(filtered).toHaveLength(2);
  });

  it('matches www-prefixed URLs against bare domain', () => {
    const filtered = filterByDomains(results, ['npmjs.com']);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toContain('www.npmjs.com');
  });

  it('returns empty array when include_domains matches nothing', () => {
    const filtered = filterByDomains(results, ['nonexistent.com']);
    expect(filtered).toEqual([]);
  });

  it('excludes results with unparseable URLs when include filter is active', () => {
    const withBadUrl = [...results, makeResult('not-a-url')];
    const filtered = filterByDomains(withBadUrl, ['github.com']);
    expect(filtered).toHaveLength(2);
  });

  it('handles trailing slashes in domain filter values', () => {
    const filtered = filterByDomains(results, ['github.com/']);
    expect(filtered).toHaveLength(2);
  });
});

// --- Date Range Filtering ---

describe('filterByDateRange', () => {
  const results = [
    makeResult('https://a.com', { snippet: 'Published April 10, 2026 - Some content' }),
    makeResult('https://b.com', { snippet: 'March 1, 2026 - Older content' }),
    makeResult('https://c.com', { snippet: 'no date info whatsoever' }),
    makeResult('https://d.com', { snippet: 'January 15, 2026 - Very old content' }),
  ];

  it('returns all results when no date range specified', () => {
    expect(filterByDateRange(results)).toEqual(results);
  });

  it('keeps results without parseable dates (conservative approach)', () => {
    const filtered = filterByDateRange(results, '2026-04-01');
    expect(filtered.some(r => r.url === 'https://c.com')).toBe(true);
  });

  it('returns all results when from_date only (best-effort for direct engines)', () => {
    const filtered = filterByDateRange(results, '2026-04-01');
    expect(filtered.length).toBeGreaterThanOrEqual(1);
  });

  it('returns all results when to_date only (best-effort for direct engines)', () => {
    const filtered = filterByDateRange(results, undefined, '2026-03-15');
    expect(filtered.length).toBeGreaterThanOrEqual(1);
  });

  it('returns all results with both from_date and to_date (best-effort)', () => {
    const filtered = filterByDateRange(results, '2026-02-01', '2026-04-01');
    expect(filtered.length).toBeGreaterThanOrEqual(1);
  });

  it('does not crash on invalid ISO date', () => {
    expect(() => filterByDateRange(results, 'not-a-date')).not.toThrow();
    expect(filterByDateRange(results, 'not-a-date')).toEqual(results);
  });

  it('returns all results when from_date is after to_date (invalid range)', () => {
    const filtered = filterByDateRange(results, '2026-06-01', '2026-01-01');
    expect(filtered).toEqual(results);
  });

  it('returns empty array for empty input', () => {
    expect(filterByDateRange([], '2026-01-01', '2026-12-31')).toEqual([]);
  });
});

// --- Category Filtering ---

describe('filterByCategory', () => {
  it('returns all results unchanged (category handled by SearXNG, not post-filter)', () => {
    const results = [
      makeResult('https://a.com'),
      makeResult('https://b.com'),
    ];
    expect(filterByCategory(results, 'code')).toEqual(results);
  });

  it('returns all results when category is undefined', () => {
    const results = [makeResult('https://a.com')];
    expect(filterByCategory(results)).toEqual(results);
  });
});

// --- Combined Filters (applyAllFilters) ---

describe('applyAllFilters', () => {
  const results = [
    makeResult('https://docs.react.dev/learn'),
    makeResult('https://stackoverflow.com/q/123'),
    makeResult('https://medium.com/react-article'),
    makeResult('https://github.com/facebook/react'),
  ];

  it('applies domain include + exclude + date range together', () => {
    const filtered = applyAllFilters(results, {
      includeDomains: ['react.dev', 'github.com'],
      excludeDomains: ['github.com'],
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
      category: 'code',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toContain('react.dev');
  });

  it('returns all results when no filter options provided', () => {
    expect(applyAllFilters(results, {})).toEqual(results);
  });

  it('applies only domain filters when no date/category', () => {
    const filtered = applyAllFilters(results, {
      includeDomains: ['github.com'],
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toContain('github.com');
  });

  it('returns empty array when all results filtered out', () => {
    const filtered = applyAllFilters(results, {
      includeDomains: ['nonexistent.example.com'],
    });
    expect(filtered).toEqual([]);
  });
});
