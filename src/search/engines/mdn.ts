import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

interface MdnDoc {
  mdn_url?: unknown;
  title?: unknown;
  summary?: unknown;
}

interface MdnResponse {
  documents?: MdnDoc[];
}

const MDN_HOST = 'https://developer.mozilla.org';

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export class MdnEngine implements SearchEngine {
  name = 'mdn';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({
      q: query,
      locale: 'en-US',
      size: String(maxResults),
    });
    const url = `${MDN_HOST}/api/v1/search?${params}`;
    log.debug('mdn search', { query });

    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`MDN returned ${response.status}`);

    const data = (await response.json()) as MdnResponse;
    return this.parseDocs(data.documents ?? []);
  }

  private parseDocs(docs: MdnDoc[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = docs.length;

    for (let i = 0; i < total; i++) {
      const doc = docs[i];
      const title = asString(doc.title);
      const path = asString(doc.mdn_url);
      if (!title || !path) continue;

      const summary = asString(doc.summary) ?? '';
      const url = path.startsWith('http') ? path : `${MDN_HOST}${path}`;

      results.push({
        title,
        url,
        snippet: summary,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'mdn',
      });
    }

    return results;
  }
}
