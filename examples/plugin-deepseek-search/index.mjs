// DeepSeek search-engine plugin for wigolo.
//
// The API accepts only query, count, and need_content. wigolo's maxResults maps
// to count and options.timeoutMs bounds the request. The remaining
// SearchEngineOptions (language, fromDate, toDate, includeDomains,
// excludeDomains, country, timeRange, category) have no DeepSeek equivalent and
// are ignored. Content is never requested: wigolo fetches pages itself.

// Matches wigolo's own FETCH_TIMEOUT_MS default, so a caller that passes no
// timeout still gets a deadline instead of hanging on a stalled socket.
const DEFAULT_TIMEOUT_MS = 10000;

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function clampCount(value) {
  const n = typeof value === 'number' && !Number.isNaN(value) ? Math.floor(value) : 10;
  return Math.min(50, Math.max(1, n));
}

function abortSignal(timeout) {
  return AbortSignal.timeout(timeout);
}

function toResult(item, title, url) {
  const summary = asString(item.summary).trim();
  const date = asString(item.date).trim();

  const result = {
    title,
    url,
    snippet: summary || asString(item.snippet),
    // DeepSeek documents rerank_score on a 0-3 scale; wigolo scores are 0-1.
    relevance_score: Number.isFinite(item.rerank_score) ? item.rerank_score / 3 : 0,
    engine: 'deepseek',
  };
  if (date) result.published_date = date;

  return result;
}

function mapResults(items) {
  const results = [];

  for (const item of items) {
    const title = asString(item?.title);
    const url = asString(item?.url);
    if (!title || !url) continue;

    results.push(toResult(item, title, url));
  }

  return results;
}

async function errorDetail(response) {
  const text = await response.text().catch(() => '');

  try {
    const message = JSON.parse(text)?.error?.message;
    if (typeof message === 'string' && message !== '') return `: ${message}`;
  } catch {
    // Body was not JSON; the raw text below is the best description available.
  }

  const trimmed = text.trim().slice(0, 300);
  return trimmed === '' ? '' : `: ${trimmed}`;
}

async function parseResponse(response) {
  if (!response.ok) {
    throw new Error(`deepseek returned ${response.status}${await errorDetail(response)}`);
  }

  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload?.results)) {
    throw new Error('deepseek returned an unparsable body');
  }

  const results = mapResults(payload.results);
  if (payload.results.length > 0 && results.length === 0) {
    throw new Error('deepseek returned no usable results');
  }

  return results;
}

export function createDeepSeekEngine({
  fetchImpl = globalThis.fetch,
  endpoint = process.env.WIGOLO_DEEPSEEK_ENDPOINT ?? 'https://api.deepseek.com/v1/tools/search',
  key = process.env.DEEPSEEK_API_KEY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return {
    name: 'deepseek',

    async search(query, options = {}) {
      if (!key) throw new Error('DEEPSEEK_API_KEY is not set');

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, count: clampCount(options.maxResults ?? 10) }),
        signal: abortSignal(options.timeoutMs ?? timeoutMs),
      });

      return parseResponse(response);
    },
  };
}

export const searchEngine = {
  name: 'deepseek',
  search(query, options) {
    return createDeepSeekEngine().search(query, options);
  },
};
