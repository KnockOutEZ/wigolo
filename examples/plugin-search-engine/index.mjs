// Minimal `searchEngine` plugin: queries the Hacker News Algolia API
// (https://hn.algolia.com/api) — a free, keyless, public JSON endpoint —
// and maps its hits onto wigolo's RawSearchResult shape.
//
// Copy this file (and package.json) as a starting point for your own
// search engine plugin. The only hard requirements are:
//   - export a `searchEngine` object
//   - `searchEngine.name` is a non-empty string
//   - `searchEngine.search(query, options?)` returns a Promise of an array
//     of `{ title, url, snippet, relevance_score, engine, ... }` objects
//
// See src/plugins/validate.ts (`validateSearchEngine`) for the exact
// contract the loader enforces.

const HN_ALGOLIA_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';

function toRawSearchResult(hit) {
  // Story/comment titles live in different fields depending on hit type.
  const title = hit.title ?? hit.story_title ?? hit.comment_text?.slice(0, 80) ?? '(untitled)';
  const url = hit.url ?? hit.story_url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`;
  const snippet = hit.comment_text ?? hit._highlightResult?.title?.value ?? title;

  return {
    title,
    url,
    snippet,
    // Algolia doesn't return a normalized relevance score for the public
    // search endpoint; points count is a reasonable proxy, clamped to [0, 1].
    relevance_score: Math.min(1, (hit.points ?? 0) / 100),
    engine: 'hn-algolia-example',
    published_date: hit.created_at,
  };
}

export const searchEngine = {
  name: 'hn-algolia-example',

  async search(query, options = {}) {
    const maxResults = options.maxResults ?? 10;

    const url = new URL(HN_ALGOLIA_SEARCH_URL);
    url.searchParams.set('query', query);
    url.searchParams.set('tags', 'story');
    url.searchParams.set('hitsPerPage', String(maxResults));

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 10_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HN Algolia search failed: ${response.status} ${response.statusText}`);
      }
      const body = await response.json();
      const hits = Array.isArray(body.hits) ? body.hits : [];
      return hits.slice(0, maxResults).map(toRawSearchResult);
    } finally {
      clearTimeout(timeout);
    }
  },
};
