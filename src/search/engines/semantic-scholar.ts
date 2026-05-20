import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

interface OpenAccessPdf {
  url?: unknown;
}

interface S2Paper {
  paperId?: unknown;
  title?: unknown;
  abstract?: unknown;
  year?: unknown;
  url?: unknown;
  openAccessPdf?: OpenAccessPdf;
}

interface S2Response {
  data?: S2Paper[];
}

const SNIPPET_LIMIT = 200;

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

function yearOf(iso: string): number | undefined {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return undefined;
  return new Date(t).getUTCFullYear();
}

export class SemanticScholarEngine implements SearchEngine {
  name = 'semantic-scholar';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({
      query,
      limit: String(maxResults),
      fields: 'title,abstract,year,url,authors,externalIds,openAccessPdf',
    });

    if (options.fromDate || options.toDate) {
      const fromY = options.fromDate ? yearOf(options.fromDate) : undefined;
      const toY = options.toDate ? yearOf(options.toDate) : undefined;
      if (fromY !== undefined || toY !== undefined) {
        params.set('year', `${fromY ?? ''}-${toY ?? ''}`);
      }
    }

    const url = `https://api.semanticscholar.org/graph/v1/paper/search?${params}`;
    log.debug('semantic-scholar search', { query });

    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Semantic Scholar returned ${response.status}`);

    const data = (await response.json()) as S2Response;
    return this.parsePapers(data.data ?? []);
  }

  private parsePapers(papers: S2Paper[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = papers.length;

    for (let i = 0; i < total; i++) {
      const p = papers[i];
      const title = asString(p.title);
      if (!title) continue;

      const pdfUrl = asString(p.openAccessPdf?.url);
      const baseUrl = asString(p.url);
      const url = pdfUrl ?? baseUrl;
      if (!url) continue;

      const abstract = asString(p.abstract) ?? '';
      const snippet = abstract.slice(0, SNIPPET_LIMIT);

      const year = asNumber(p.year);
      const published_date = year ? `${year}-01-01T00:00:00.000Z` : undefined;

      results.push({
        title,
        url,
        snippet,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'semantic-scholar',
        ...(published_date ? { published_date } : {}),
      });
    }

    return results;
  }
}
