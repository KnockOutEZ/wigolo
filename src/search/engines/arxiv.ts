import { parseHTML } from 'linkedom';
import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const SNIPPET_LIMIT = 200;

function textContent(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export class ArxivEngine implements SearchEngine {
  name = 'arxiv';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({
      search_query: `all:${query}`,
      max_results: String(maxResults),
      sortBy: 'relevance',
    });
    const url = `http://export.arxiv.org/api/query?${params}`;
    log.debug('arxiv search', { query });

    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`arXiv returned ${response.status}`);

    const xml = await response.text();
    const mapped = this.parseAtom(xml);
    return applyDateFilter(mapped, options);
  }

  private parseAtom(xml: string): RawSearchResult[] {
    const { document } = parseHTML(xml);
    const entries = Array.from(document.querySelectorAll('entry'));
    const results: RawSearchResult[] = [];
    const total = entries.length;

    for (let i = 0; i < total; i++) {
      const entry = entries[i];
      const id = textContent(entry.querySelector('id'));
      const title = textContent(entry.querySelector('title'));
      const summary = textContent(entry.querySelector('summary'));
      const published = textContent(entry.querySelector('published'));
      if (!id || !title) continue;

      let published_date: string | undefined;
      if (published) {
        const d = new Date(published);
        if (!isNaN(d.getTime())) published_date = d.toISOString();
      }

      results.push({
        title,
        url: id,
        snippet: summary.slice(0, SNIPPET_LIMIT),
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'arxiv',
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
