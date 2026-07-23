import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

interface CrateHit {
  name?: unknown;
  description?: unknown;
  downloads?: unknown;
  max_version?: unknown;
}

interface CratesIoResponse {
  crates?: CrateHit[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

// crates.io's public crate-search API: free, no key, returns name/description/
// downloads for matching crates. Adds a canonical Rust-package-registry signal
// to the code vertical — useful when a query names or resembles a crate (e.g.
// "tokio async runtime") so the ecosystem's own metadata (not just blog posts
// or Stack Overflow) surfaces directly.
//
// crates.io's crawler policy requires a descriptive User-Agent identifying the
// calling application; a generic/browser UA risks being blocked.
export class CratesIoEngine implements SearchEngine {
  name = 'crates-io';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({
      q: query,
      per_page: String(maxResults),
    });

    const url = `https://crates.io/api/v1/crates?${params}`;
    log.debug('crates.io search', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'wigolo/0.1 (https://github.com/KnockOutEZ/wigolo)',
        Accept: 'application/json',
      },
    });

    if (!response.ok) throw new Error(`crates.io returned ${response.status}`);

    const data = (await response.json()) as CratesIoResponse;
    return this.parseCrates(data.crates ?? []);
  }

  private parseCrates(crates: CrateHit[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = crates.length;

    for (let i = 0; i < total; i++) {
      const crate = crates[i];
      const name = asString(crate.name);
      if (!name) continue;

      const description = asString(crate.description) ?? '';
      const downloads = asNumber(crate.downloads) ?? 0;
      const maxVersion = asString(crate.max_version);
      const snippet = maxVersion ? `${description} (v${maxVersion}, ${downloads} downloads)` : description;

      results.push({
        title: name,
        url: `https://crates.io/crates/${name}`,
        snippet,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'crates-io',
      });
    }

    return results;
  }
}
