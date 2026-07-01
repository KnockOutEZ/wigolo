import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config.js';

const log = createLogger('search');

interface GhRepository {
  full_name?: unknown;
  description?: unknown;
}

interface GhCodeItem {
  name?: unknown;
  path?: unknown;
  html_url?: unknown;
  repository?: GhRepository;
}

interface GhResponse {
  items?: GhCodeItem[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export class GithubCodeEngine implements SearchEngine {
  name = 'github-code';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({
      q: query,
      per_page: String(maxResults),
    });
    const url = `https://api.github.com/search/code?${params}`;
    log.debug('github code search', { query });

    // Wire WIGOLO_GITHUB_TOKEN into the request. The
    // engine_warnings hint already names the env var, but the adapter
    // previously wasn't reading it — so users who set the var still hit 401.
    // When present, the token is sent as a Bearer credential and the
    // recommended `X-GitHub-Api-Version` header is added for stability.
    // Unauthed mode is still supported (no header fabricated).
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = getConfig().githubToken;
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });

    if (response.status === 403) {
      throw new Error(`GitHub code rate-limited (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`GitHub code returned ${response.status}`);
    }

    const data = (await response.json()) as GhResponse;
    return this.parseItems(data.items ?? []);
  }

  private parseItems(items: GhCodeItem[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = items.length;

    for (let i = 0; i < total; i++) {
      const item = items[i];
      const repoName = asString(item.repository?.full_name);
      const path = asString(item.path);
      const htmlUrl = asString(item.html_url);
      if (!repoName || !path || !htmlUrl) continue;

      const description = asString(item.repository?.description);
      // S11b: include both repo description and path in the snippet when
      // both are present. Lexical alignment scoring downstream uses snippet
      // tokens; pre-S11b we lost ~half the queryable surface by emitting
      // only one or the other. When description is missing, fall back to
      // path alone so we don't pad noise.
      const snippet = description ? `${description} — ${path}` : path;

      results.push({
        title: `${repoName} — ${path}`,
        url: htmlUrl,
        snippet,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'github-code',
      });
    }

    return results;
  }
}
