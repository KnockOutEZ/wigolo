import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const SNIPPET_LIMIT = 200;

interface OaSource {
  landing_page_url?: unknown;
}

interface OaWork {
  id?: unknown;
  title?: unknown;
  publication_year?: unknown;
  publication_date?: unknown;
  primary_location?: OaSource;
  abstract_inverted_index?: unknown;
}

interface OaResponse {
  results?: OaWork[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * OpenAlex ships the abstract as an inverted index — `{ word: [positions] }` —
 * rather than plain text, to sidestep publishers' full-text redistribution
 * limits. Rebuild the prose by placing each word at each of its positions.
 * Returns undefined when the field is absent or malformed so the caller can
 * fall back cleanly.
 */
function reconstructAbstract(index: unknown): string | undefined {
  if (typeof index !== 'object' || index === null) return undefined;
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (typeof p === 'number' && p >= 0) slots[p] = word;
    }
  }
  const text = slots.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

export class OpenAlexEngine implements SearchEngine {
  name = 'openalex';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    // `mailto` opts into OpenAlex's faster "polite pool" and identifies the
    // client, as their usage policy requests. Keyless either way.
    const params = new URLSearchParams({
      search: query,
      per_page: String(maxResults),
      mailto: 'wigolo@users.noreply.github.com',
    });
    const url = `https://api.openalex.org/works?${params}`;
    log.debug('openalex search', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) throw new Error(`OpenAlex returned ${response.status}`);

    const data = (await response.json()) as OaResponse;
    return this.parseWorks(data.results ?? []);
  }

  private parseWorks(works: OaWork[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = works.length;

    for (let i = 0; i < total; i++) {
      const work = works[i];
      const title = asString(work.title);
      if (!title) continue;

      // primary_location is the publisher's page; the OpenAlex work URL is the
      // fallback so a record with no landing page still resolves.
      const url = asString(work.primary_location?.landing_page_url) ?? asString(work.id);
      if (!url) continue;

      const abstract = reconstructAbstract(work.abstract_inverted_index);
      const snippet = (abstract ?? '').slice(0, SNIPPET_LIMIT);

      const date = asString(work.publication_date);
      const year = typeof work.publication_year === 'number' ? work.publication_year : undefined;
      const published_date = date ?? (year ? `${year}-01-01T00:00:00.000Z` : undefined);

      results.push({
        title,
        url,
        snippet,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'openalex',
        ...(published_date ? { published_date } : {}),
      });
    }

    return results;
  }
}
