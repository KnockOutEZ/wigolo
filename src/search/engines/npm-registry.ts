import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

interface NpmPublisher {
  username?: unknown;
}

interface NpmPackage {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  date?: unknown;
  publisher?: NpmPublisher;
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

// npm's public package-search API: free, no key, returns name/version/
// description/date/publisher for matching packages. Adds a canonical
// JavaScript-package-registry signal to the code vertical — useful when a
// query names or resembles an npm package (e.g. "fastify schema validation")
// so the ecosystem's own metadata (not just blog posts or Stack Overflow)
// surfaces directly. Complements crates-io, which plays the same role for Rust.
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
        Accept: 'application/json',
      },
    });

    if (!response.ok) throw new Error(`npm registry returned ${response.status}`);

    const data = (await response.json()) as NpmSearchResponse;
    return this.parseObjects(data.objects ?? []);
  }

  private parseObjects(objects: NpmSearchObject[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = objects.length;

    for (let i = 0; i < total; i++) {
      const pkg = objects[i].package;
      const name = asString(pkg?.name);
      if (!name) continue;

      const description = asString(pkg?.description) ?? '';
      const version = asString(pkg?.version);
      const publisher = asString(pkg?.publisher?.username);

      const meta: string[] = [];
      if (version) meta.push(`v${version}`);
      if (publisher) meta.push(`by ${publisher}`);
      const suffix = meta.length ? ` (${meta.join(', ')})` : '';
      const snippet = `${description}${suffix}`;

      const url = asString(pkg?.links?.npm) ?? `https://www.npmjs.com/package/${name}`;
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
