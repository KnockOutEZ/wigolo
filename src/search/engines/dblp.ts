import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const SNIPPET_LIMIT = 200;

interface DblpAuthor {
  text?: unknown;
}

interface DblpAuthors {
  // DBLP returns a single-author paper's author as a bare object, not an array.
  author?: DblpAuthor | DblpAuthor[];
}

interface DblpInfo {
  authors?: DblpAuthors;
  title?: unknown;
  venue?: unknown;
  year?: unknown;
  type?: unknown;
  doi?: unknown;
  ee?: unknown;
  url?: unknown;
}

interface DblpHit {
  info?: DblpInfo;
}

interface DblpHits {
  hit?: DblpHit[];
}

interface DblpResult {
  hits?: DblpHits;
}

interface DblpResponse {
  result?: DblpResult;
}

// Cap the author list so a many-author paper doesn't crowd venue/year out of
// the snippet.
const MAX_AUTHORS = 3;

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Author names, normalized across DBLP's two shapes: a single author is a bare
 * object, multiple authors are an array. Trimmed to the first {@link MAX_AUTHORS}
 * with an "et al." marker so the byline can't dominate the snippet.
 */
function authorNames(authors: DblpAuthors | undefined): string | undefined {
  const raw = authors?.author;
  if (!raw) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const names = list.map((a) => asString(a?.text)).filter((n): n is string => n !== undefined);
  if (names.length === 0) return undefined;
  const shown = names.slice(0, MAX_AUTHORS).join(', ');
  return names.length > MAX_AUTHORS ? `${shown} et al.` : shown;
}

export class DblpEngine implements SearchEngine {
  name = 'dblp';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({
      q: query,
      format: 'json',
      h: String(maxResults),
    });
    const url = `https://dblp.org/search/publ/api?${params}`;
    log.debug('dblp search', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) throw new Error(`DBLP returned ${response.status}`);

    const data = (await response.json()) as DblpResponse;
    return this.parseHits(data.result?.hits?.hit ?? []);
  }

  private parseHits(hits: DblpHit[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = hits.length;

    for (let i = 0; i < total; i++) {
      const info = hits[i].info;
      const title = asString(info?.title);
      if (!title) continue;

      // `ee` is the publisher/DOI link to the paper itself; `url` is the DBLP
      // record page. Prefer the paper, fall back to the record.
      const url = asString(info?.ee) ?? asString(info?.url);
      if (!url) continue;

      // DBLP returns bibliographic metadata, not abstracts, so the snippet is
      // assembled from every text-bearing field it does return — authors, then
      // venue and year — to give lexical alignment downstream some queryable
      // surface beyond the title. Authors lead because they are the field
      // users most often search a paper by.
      const authors = authorNames(info?.authors);
      const venue = asString(info?.venue);
      const year = asString(info?.year);
      const venueYear = [venue, year].filter(Boolean).join(' ');
      const snippet = [authors, venueYear].filter(Boolean).join(' — ').slice(0, SNIPPET_LIMIT);

      const published_date = year && /^\d{4}$/.test(year) ? `${year}-01-01T00:00:00.000Z` : undefined;

      results.push({
        title,
        url,
        snippet,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'dblp',
        ...(published_date ? { published_date } : {}),
      });
    }

    return results;
  }
}
