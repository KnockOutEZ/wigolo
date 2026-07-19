import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const SNIPPET_LIMIT = 200;

// npm registry public search API: free, no API key, structured JSON. Adds a
// package-registry signal to the code vertical so library-name queries (e.g.
// "react query", "left-pad alternatives") resolve directly to the canonical
// npm package page instead of relying on GitHub/StackOverflow text matches.
// Docs: https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#get-v1search
interface NpmPackage {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  date?: unknown;
  links?: { npm?: unknown };
}

interface NpmObject {
  package?: NpmPackage;
}

interface NpmSearchResponse {
  objects?: NpmObject[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export class NpmRegistryEngine implements SearchEngine {
  name = 'npm-registry';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({
      text: query,
      size: String(maxResults),
    });
    const url = `https://registry.npmjs.org/-/v1/search?${params}`;

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
    return this.parseObjects(data.objects ?? []);
  }

  private parseObjects(objects: NpmObject[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = objects.length;

    for (let i = 0; i < total; i++) {
      const pkg = objects[i]?.package;
      const name = asString(pkg?.name);
      const npmUrl = asString(pkg?.links?.npm);
      if (!name || !npmUrl) continue;

      const version = asString(pkg?.version);
      const title = version ? `${name}@${version}` : name;

      const description = asString(pkg?.description) ?? '';
      const snippet = description.slice(0, SNIPPET_LIMIT);

      const updated = asString(pkg?.date);
      const published_date = updated && !isNaN(new Date(updated).getTime()) ? updated : undefined;

      results.push({
        title,
        url: npmUrl,
        snippet,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'npm-registry',
        ...(published_date ? { published_date } : {}),
      });
    }

    return results;
  }
}
