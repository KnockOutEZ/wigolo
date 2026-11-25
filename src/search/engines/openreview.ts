import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const SNIPPET_LIMIT = 200;

// OpenReview wraps every content field as `{ value: ... }`.
interface OrField {
  value?: unknown;
}

interface OrContent {
  title?: OrField;
  abstract?: OrField;
}

interface OrNote {
  forum?: unknown;
  content?: OrContent;
}

interface OrResponse {
  notes?: OrNote[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export class OpenReviewEngine implements SearchEngine {
  name = 'openreview';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    // `source=forum` restricts results to the note that opened each forum — the
    // paper submission itself — so reviews and comments (which carry no title
    // and only reference the paper) never enter the result set.
    const params = new URLSearchParams({
      query,
      source: 'forum',
      limit: String(maxResults),
    });
    const url = `https://api2.openreview.net/notes/search?${params}`;
    log.debug('openreview search', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) throw new Error(`OpenReview returned ${response.status}`);

    const data = (await response.json()) as OrResponse;
    return this.parseNotes(data.notes ?? []);
  }

  private parseNotes(notes: OrNote[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = notes.length;

    for (let i = 0; i < total; i++) {
      const note = notes[i];

      const title = asString(note.content?.title?.value);
      if (!title) continue;

      // `forum` is the paper's thread id; the forum URL is the paper page.
      const forum = asString(note.forum);
      if (!forum) continue;
      const url = `https://openreview.net/forum?id=${forum}`;

      const abstract = asString(note.content?.abstract?.value) ?? '';
      const snippet = abstract.slice(0, SNIPPET_LIMIT);

      results.push({
        title,
        url,
        snippet,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'openreview',
      });
    }

    return results;
  }
}
