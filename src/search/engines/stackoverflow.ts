import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

interface SoItem {
  title?: unknown;
  link?: unknown;
  body?: unknown;
  creation_date?: unknown;
}

interface SoResponse {
  items?: SoItem[];
}

const SNIPPET_LIMIT = 200;

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toEpochSeconds(iso: string): number | undefined {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return undefined;
  return Math.floor(t / 1000);
}

export class StackOverflowEngine implements SearchEngine {
  name = 'stackoverflow';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({
      order: 'desc',
      sort: 'relevance',
      q: query,
      site: 'stackoverflow',
      filter: 'withbody',
      pagesize: String(maxResults),
    });

    if (options.fromDate) {
      const epoch = toEpochSeconds(options.fromDate);
      if (epoch !== undefined) params.set('fromdate', String(epoch));
    }
    if (options.toDate) {
      const epoch = toEpochSeconds(options.toDate);
      if (epoch !== undefined) params.set('todate', String(epoch));
    }

    const url = `https://api.stackexchange.com/2.3/search/advanced?${params}`;
    log.debug('stackoverflow search', { query });

    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`StackOverflow returned ${response.status}`);

    const data = (await response.json()) as SoResponse;
    return this.parseItems(data.items ?? []);
  }

  private parseItems(items: SoItem[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = items.length;

    for (let i = 0; i < total; i++) {
      const item = items[i];
      const title = asString(item.title);
      const link = asString(item.link);
      if (!title || !link) continue;

      const bodyHtml = asString(item.body) ?? '';
      const snippet = stripHtml(bodyHtml).slice(0, SNIPPET_LIMIT);

      const createdAt = asNumber(item.creation_date);
      const published_date = createdAt ? new Date(createdAt * 1000).toISOString() : undefined;

      results.push({
        title,
        url: link,
        snippet,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'stackoverflow',
        ...(published_date ? { published_date } : {}),
      });
    }

    return results;
  }
}
