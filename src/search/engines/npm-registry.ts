import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const MAX_SIZE = 250;

interface NpmPackage {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  date?: unknown;
  links?: {
    npm?: unknown;
  };
}

interface NpmSearchObject {
  package?: NpmPackage;
}

interface NpmSearchResponse {
  objects?: NpmSearchObject[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function packagePageUrl(name: string, candidate: unknown): string {
  const fallback = `https://www.npmjs.com/package/${name}`;
  const raw = asString(candidate);
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return fallback;
    if (parsed.hostname !== 'www.npmjs.com' && parsed.hostname !== 'npmjs.com') return fallback;
    if (!parsed.pathname.startsWith('/package/')) return fallback;
    return raw;
  } catch {
    return fallback;
  }
}

// npm's public registry search API: free, no key, returns name/description/
// version for matching packages. Adds a canonical JavaScript-package-registry
// signal to the code vertical — useful when a query names or resembles an
// npm package (e.g. "zod schema validation") so the ecosystem's own metadata
// (not just blog posts or Stack Overflow) surfaces directly.
//
// The registry asks callers to send a descriptive User-Agent; a generic or
// missing UA can be throttled.
export class NpmRegistryEngine implements SearchEngine {
  name = 'npm-registry';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;
    const size = Math.min(Math.max(maxResults, 1), MAX_SIZE);

    const params = new URLSearchParams({
      text: query,
      size: String(size),
    });

    const url = `${SEARCH_URL}?${params}`;
    log.debug('npm registry search', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'wigolo/0.1 (https://github.com/KnockOutEZ/wigolo)',
        Accept: 'application/json',
      },
    });

    if (!response.ok) throw new Error(`npm registry returned ${response.status}`);

    const data = (await response.json()) as NpmSearchResponse;
    const objects = Array.isArray(data.objects) ? data.objects : [];
    return this.parseObjects(objects, size);
  }

  private parseObjects(objects: NpmSearchObject[], maxResults: number): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = objects.length;

    for (let i = 0; i < total; i++) {
      if (results.length >= maxResults) break;
      const pkg = objects[i].package;
      const name = asString(pkg?.name);
      if (!name) continue;

      const description = asString(pkg?.description) ?? '';
      const version = asString(pkg?.version);
      const snippet = version ? `${description} (v${version})` : description;
      const url = packagePageUrl(name, pkg?.links?.npm);
      const published_date = asString(pkg?.date);

      results.push({
        title: name,
        url,
        snippet,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'npm-registry',
        ...(published_date ? { published_date } : {}),
      });
    }

    return results;
  }
}
