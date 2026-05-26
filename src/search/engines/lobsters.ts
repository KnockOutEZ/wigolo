import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

// Lobste.rs /search.json sometimes returns an array directly, sometimes a
// { results: [...] } envelope. Both shapes are handled defensively.
interface LobsterHit {
  short_id?: unknown;
  title?: unknown;
  url?: unknown;
  score?: unknown;
  description?: unknown;
  comment_count?: unknown;
  created_at?: unknown;
  short_id_url?: unknown;
}

const SNIPPET_LIMIT = 200;

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

function extractHits(data: unknown): LobsterHit[] {
  if (Array.isArray(data)) return data as LobsterHit[];
  if (data && typeof data === 'object' && 'results' in data) {
    const r = (data as { results?: unknown }).results;
    if (Array.isArray(r)) return r as LobsterHit[];
  }
  return [];
}

export class LobstersEngine implements SearchEngine {
  name = 'lobsters';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({ q: query, what: 'stories' });
    const url = `https://lobste.rs/search.json?${params}`;
    log.debug('lobsters search', { query });

    // Lobste.rs's Rack middleware treats UA-less requests as bot traffic and
    // returns 400 — the audit's "lobsters 400 on multi-word queries" was
    // really "lobsters 400 on every request, more visible on multi-word
    // queries that exercise the engine more often". A stable identifier
    // restores 200s.
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'wigolo/0.1 (https://github.com/staticn0va/wigolo)',
      },
    });
    if (!response.ok) throw new Error(`Lobsters returned ${response.status}`);

    const data = (await response.json()) as unknown;
    const hits = extractHits(data);
    const mapped = this.parseHits(hits);
    const filtered = applyDateFilter(mapped, options);
    return filtered.slice(0, maxResults);
  }

  private parseHits(hits: LobsterHit[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = hits.length;

    for (let i = 0; i < total; i++) {
      const hit = hits[i];
      const title = asString(hit.title);
      if (!title) continue;

      const url = asString(hit.url) ?? asString(hit.short_id_url);
      if (!url) continue;

      const description = asString(hit.description);
      const score = asNumber(hit.score) ?? 0;
      const comments = asNumber(hit.comment_count) ?? 0;
      const snippet = description
        ? description.slice(0, SNIPPET_LIMIT)
        : `${score} score · ${comments} comments`;

      const createdAt = asString(hit.created_at);
      let published_date: string | undefined;
      if (createdAt) {
        const d = new Date(createdAt);
        if (!isNaN(d.getTime())) published_date = d.toISOString();
      }

      results.push({
        title,
        url,
        snippet,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'lobsters',
        ...(published_date ? { published_date } : {}),
      });
    }

    return results;
  }
}

function applyDateFilter(results: RawSearchResult[], options: SearchEngineOptions): RawSearchResult[] {
  if (!options.fromDate && !options.toDate) return results;
  const from = options.fromDate ? new Date(options.fromDate).getTime() : -Infinity;
  const to = options.toDate ? new Date(options.toDate).getTime() : Infinity;
  if (isNaN(from) || isNaN(to)) return results;
  return results.filter((r) => {
    if (!r.published_date) return false;
    const t = new Date(r.published_date).getTime();
    if (isNaN(t)) return false;
    return t >= from && t <= to;
  });
}
