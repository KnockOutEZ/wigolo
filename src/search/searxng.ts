import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../types.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

// 'docs' deliberately routes to 'general' instead of SearXNG's 'it' category.
// SearXNG 'it' returns generic developer docs (MDN, Docker, Stack Overflow, etc.)
// regardless of the query subject — e.g. "Next.js authentication" surfaces
// MDN WebRTC docs. Domain scoping (include_domains) + reranking handle relevance
// far better than category narrowing for AI-driven queries.
const CATEGORY_MAP: Record<string, string> = {
  general: 'general',
  news: 'news',
  code: 'it',
  docs: 'general',
  papers: 'science',
  images: 'images',
};

function computeTimeRange(fromDate?: string, toDate?: string): string | null {
  if (!fromDate) return null;
  const from = new Date(fromDate);
  if (isNaN(from.getTime())) return null;
  const now = toDate ? new Date(toDate) : new Date();
  if (isNaN(now.getTime())) return null;
  const diffDays = Math.round((now.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays <= 1) return 'day';
  if (diffDays <= 7) return 'week';
  if (diffDays <= 30) return 'month';
  return 'year';
}

interface SearxngApiResult {
  title: string;
  url: string;
  content: string;
  score?: number | null;
  engine: string;
  engines: string[];
  publishedDate?: string | null;
  pubdate?: string | null;
}

interface SearxngApiResponse {
  results: SearxngApiResult[];
  query: string;
  number_of_results: number;
}

export class SearxngClient implements SearchEngine {
  name = 'searxng';

  constructor(private readonly baseUrl: string) {}

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const config = getConfig();
    const timeoutMs = options.timeoutMs ?? config.searxngQueryTimeoutMs;
    const maxResults = options.maxResults ?? 10;

    // Build query with domain site: operators
    let queryStr = query;
    if (options.includeDomains?.length) {
      // Best-effort: site: syntax works on Google/Bing but not all SearXNG engines.
      // Post-filter in filters.ts handles the gap for engines that ignore it.
      const siteFilter = options.includeDomains.map(d => `site:${d}`).join(' OR ');
      queryStr = options.includeDomains.length === 1
        ? `${query} site:${options.includeDomains[0]}`
        : `${query} (${siteFilter})`;
    }
    // exclude_domains are NOT passed to SearXNG — handled by post-filter

    const params = new URLSearchParams({
      q: queryStr,
      format: 'json',
      pageno: '1',
    });

    if (options.timeRange) params.set('time_range', options.timeRange);
    if (options.language) params.set('language', options.language);

    // Category pass-through
    if (options.category) {
      params.set('categories', CATEGORY_MAP[options.category] ?? 'general');
    }

    // Date range -> time_range bucket (SearXNG doesn't support arbitrary dates)
    if (!options.timeRange && (options.fromDate || options.toDate)) {
      const range = computeTimeRange(options.fromDate, options.toDate);
      if (range) params.set('time_range', range);
    }

    const url = `${this.baseUrl}/search?${params}`;
    log.debug('querying searxng', { query: queryStr, url });

    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

    if (!response.ok) {
      throw new Error(`SearXNG returned ${response.status}`);
    }

    const data = (await response.json()) as SearxngApiResponse;
    const total = data.results.length;

    return data.results.slice(0, maxResults).map((r, i) => {
      const published = r.publishedDate ?? r.pubdate ?? undefined;
      return {
        title: r.title,
        url: r.url,
        snippet: r.content,
        relevance_score: r.score != null ? Math.min(r.score, 1) : 1 - i / Math.max(total, 1),
        engine: 'searxng',
        ...(published ? { published_date: published } : {}),
      };
    });
  }
}
