import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SearxngClient } from '../../../src/search/searxng.js';

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({
    searxngQueryTimeoutMs: 5000,
  }),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function mockFetch(results: unknown[] = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ results, query: 'test', number_of_results: results.length }),
  });
}

describe('SearxngClient search filtering params', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // 1. Category mapping: 'code' -> SearXNG 'it'
  it('maps category "code" to SearXNG categories param "it"', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const client = new SearxngClient('http://localhost:8888');
    await client.search('react hooks', { category: 'code' });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.searchParams.get('categories')).toBe('it');
  });

  // 2. Category mapping: 'news' -> SearXNG 'news'
  it('maps category "news" to SearXNG categories param "news"', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const client = new SearxngClient('http://localhost:8888');
    await client.search('react', { category: 'news' });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.searchParams.get('categories')).toBe('news');
  });

  // 3. Category mapping: 'papers' -> SearXNG 'science'
  it('maps category "papers" to SearXNG categories param "science"', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const client = new SearxngClient('http://localhost:8888');
    await client.search('neural networks', { category: 'papers' });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.searchParams.get('categories')).toBe('science');
  });

  // 4. Category 'docs' without include_domains routes to 'general' to avoid generic
  // documentation noise (MDN, Docker docs) returned by SearXNG's 'it' category.
  // Relevance is left to reranking + post-filtering.
  it('maps category "docs" to SearXNG categories param "general" (no include_domains)', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const client = new SearxngClient('http://localhost:8888');
    await client.search('typescript generics', { category: 'docs' });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.searchParams.get('categories')).toBe('general');
  });

  // 4a. Category 'docs' with include_domains keeps 'general' too — domain scoping
  // already narrows the result set, IT category would be redundant.
  it('maps category "docs" + include_domains to SearXNG "general"', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const client = new SearxngClient('http://localhost:8888');
    await client.search('hooks', { category: 'docs', includeDomains: ['react.dev'] });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.searchParams.get('categories')).toBe('general');
    expect(calledUrl.searchParams.get('q')).toContain('site:react.dev');
  });

  // 5. No category — categories param not sent
  it('does not set categories param when category is undefined', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const client = new SearxngClient('http://localhost:8888');
    await client.search('react');

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.searchParams.has('categories')).toBe(false);
  });

  // 6. include_domains prepends site: operators to query
  it('prepends site: operators for include_domains', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const client = new SearxngClient('http://localhost:8888');
    await client.search('hooks', { includeDomains: ['react.dev', 'github.com'] });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    const q = calledUrl.searchParams.get('q');
    expect(q).toContain('site:react.dev');
    expect(q).toContain('site:github.com');
    expect(q).toContain('hooks');
  });

  // 7. Single include_domain — no OR needed
  it('prepends single site: operator for one include domain', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const client = new SearxngClient('http://localhost:8888');
    await client.search('hooks', { includeDomains: ['react.dev'] });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    const q = calledUrl.searchParams.get('q');
    expect(q).toContain('site:react.dev');
    expect(q).toContain('hooks');
  });

  // 8. from_date/to_date maps to time_range bucket 'day'
  it('passes time_range for from_date within last day', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const now = new Date();
    const yesterday = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const fromDate = yesterday.toISOString().split('T')[0];

    const client = new SearxngClient('http://localhost:8888');
    await client.search('react', { fromDate });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.searchParams.get('time_range')).toBe('day');
  });

  // 9. from_date within last week maps to 'week'
  it('passes time_range "week" for from_date within last 7 days', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const fromDate = fiveDaysAgo.toISOString().split('T')[0];

    const client = new SearxngClient('http://localhost:8888');
    await client.search('react', { fromDate });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.searchParams.get('time_range')).toBe('week');
  });

  // 10. from_date within last month maps to 'month'
  it('passes time_range "month" for from_date within last 30 days', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const now = new Date();
    const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
    const fromDate = twentyDaysAgo.toISOString().split('T')[0];

    const client = new SearxngClient('http://localhost:8888');
    await client.search('react', { fromDate });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.searchParams.get('time_range')).toBe('month');
  });

  // 11. No from_date — time_range not set
  it('does not set time_range when no date filters provided', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const client = new SearxngClient('http://localhost:8888');
    await client.search('react', {});

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.searchParams.has('time_range')).toBe(false);
  });

  // 12. exclude_domains are NOT sent to SearXNG (post-filtered only)
  it('does not modify query for exclude_domains (post-filter only)', async () => {
    const fetchSpy = mockFetch();
    globalThis.fetch = fetchSpy;

    const client = new SearxngClient('http://localhost:8888');
    await client.search('react', { excludeDomains: ['medium.com'] });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    const q = calledUrl.searchParams.get('q');
    expect(q).toBe('react');
    expect(q).not.toContain('medium.com');
  });
});
