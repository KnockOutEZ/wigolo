import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

interface HnHit {
  objectID?: unknown;
  title?: unknown;
  url?: unknown;
  story_text?: unknown;
  points?: unknown;
  num_comments?: unknown;
  created_at_i?: unknown;
}

interface HnResponse {
  hits?: HnHit[];
}

const SNIPPET_LIMIT = 200;

function toEpoch(dateStr: string): number {
  const d = new Date(dateStr);
  const t = d.getTime();
  if (isNaN(t)) return 0;
  return Math.floor(t / 1000);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

export class HnAlgoliaEngine implements SearchEngine {
  name = 'hn-algolia';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({
      query,
      hitsPerPage: String(maxResults),
      tags: 'story',
    });

    if (options.fromDate || options.toDate) {
      const filters: string[] = [];
      if (options.fromDate) {
        const epoch = toEpoch(options.fromDate);
        if (epoch > 0) filters.push(`created_at_i>${epoch}`);
      }
      if (options.toDate) {
        const epoch = toEpoch(options.toDate);
        if (epoch > 0) filters.push(`created_at_i<${epoch}`);
      }
      if (filters.length) params.set('numericFilters', filters.join(','));
    }

    const url = `https://hn.algolia.com/api/v1/search?${params}`;
    log.debug('hn algolia search', { query });

    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HN Algolia returned ${response.status}`);

    const data = (await response.json()) as HnResponse;
    return this.parseHits(data.hits ?? []);
  }

  private parseHits(hits: HnHit[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = hits.length;

    for (let i = 0; i < total; i++) {
      const hit = hits[i];
      const title = asString(hit.title);
      if (!title) continue;

      const objectID = asString(hit.objectID);
      const url = asString(hit.url) ?? (objectID ? `https://news.ycombinator.com/item?id=${objectID}` : undefined);
      if (!url) continue;

      const storyText = asString(hit.story_text);
      const points = asNumber(hit.points) ?? 0;
      const comments = asNumber(hit.num_comments) ?? 0;
      const snippet = storyText
        ? storyText.slice(0, SNIPPET_LIMIT)
        : `${points} points · ${comments} comments`;

      const createdAt = asNumber(hit.created_at_i);
      const published_date = createdAt ? new Date(createdAt * 1000).toISOString() : undefined;

      results.push({
        title,
        url,
        snippet,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'hn-algolia',
        ...(published_date ? { published_date } : {}),
      });
    }

    return results;
  }
}
