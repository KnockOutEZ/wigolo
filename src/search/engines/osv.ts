import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const SNIPPET_LIMIT = 200;

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  published?: string;
}

interface OsvResponse {
  vulns?: OsvVuln[];
}

// Map common keywords in queries to OSV ecosystems
const ECOSYSTEM_MAP: Record<string, string> = {
  python: 'PyPI',
  pypi: 'PyPI',
  pip: 'PyPI',
  node: 'npm',
  npm: 'npm',
  javascript: 'npm',
  typescript: 'npm',
  go: 'Go',
  golang: 'Go',
  rust: 'crates.io',
  cargo: 'crates.io',
  java: 'Maven',
  maven: 'Maven',
  ruby: 'RubyGems',
  gem: 'RubyGems',
  rubygems: 'RubyGems',
  php: 'Packagist',
  composer: 'Packagist',
  csharp: 'NuGet',
  dotnet: 'NuGet',
  nuget: 'NuGet',
};

// Extracted from query
interface OsvQueryParam {
  id?: string;
  package?: {
    name: string;
    ecosystem?: string;
  };
}

export class OsvEngine implements SearchEngine {
  name = 'osv';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10; // Note: OSV doesn't natively paginate via query params like this

    const qParam = this.extractQuery(query);
    if (!qParam) {
      log.debug('osv search: could not extract package/id from query', { query });
      return [];
    }

    let url = '';
    let method = 'GET';
    let body: string | undefined;

    if (qParam.id) {
      url = `https://api.osv.dev/v1/vulns/${encodeURIComponent(qParam.id)}`;
    } else if (qParam.package) {
      url = `https://api.osv.dev/v1/query`;
      method = 'POST';
      body = JSON.stringify({ package: qParam.package });
    } else {
      return [];
    }

    log.debug('osv search', { query, qParam });

    const response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      if (response.status === 404 && qParam.id) {
        // ID not found is a normal 404
        return [];
      }
      throw new Error(`OSV returned ${response.status}`);
    }

    const data = await response.json();
    let vulns: OsvVuln[] = [];
    
    if (qParam.id) {
      // /v1/vulns/{id} returns the vuln directly
      vulns = [data as OsvVuln];
    } else {
      // /v1/query returns { vulns: [...] }
      vulns = (data as OsvResponse).vulns ?? [];
    }

    // Limit client side
    vulns = vulns.slice(0, maxResults);
    
    const mapped = this.parseVulns(vulns);
    return applyDateFilter(mapped, options);
  }

  private extractQuery(query: string): OsvQueryParam | null {
    const trimmed = query.trim();
    if (!trimmed) return null;

    // 1. Check for specific IDs (CVE or GHSA)
    const idMatch = trimmed.match(/(CVE-\d{4}-\d+|GHSA(?:-[a-z0-9]{4}){3})/i);
    if (idMatch) {
      return { id: idMatch[1].toUpperCase() };
    }

    // 2. Heuristic package + ecosystem extraction
    // Remove common vulnerability/noise words to isolate the package name
    const noiseRe = /\b(cve|vulnerability|vulnerabilities|nvd|exploit|advisory|security|bug|issue|in|the|what|is|for|about|recent|latest|this|that|with|from)\b/gi;
    const cleaned = trimmed.replace(noiseRe, ' ').replace(/\s+/g, ' ').trim();
    
    if (!cleaned) return null;

    const tokens = cleaned.split(' ');
    let ecosystem: string | undefined;
    const packageTokens: string[] = [];

    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (ECOSYSTEM_MAP[lower]) {
        ecosystem = ECOSYSTEM_MAP[lower];
      } else {
        packageTokens.push(token);
      }
    }

    // If no ecosystem was detected and the remaining text is >2 tokens,
    // it's likely a general question, not a package name. Bail out.
    if (!ecosystem && packageTokens.length > 2) return null;

    const packageName = packageTokens.join(' ');
    if (!packageName) return null;

    return {
      package: {
        name: packageName,
        ...(ecosystem ? { ecosystem } : {}),
      }
    };
  }

  private parseVulns(vulns: OsvVuln[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = vulns.length;

    for (let i = 0; i < total; i++) {
      const v = vulns[i];
      if (!v.id) continue;

      const title = v.id;
      const url = `https://osv.dev/vulnerability/${v.id}`;
      
      const description = v.summary || v.details || '';
      const snippet = description.slice(0, SNIPPET_LIMIT);

      let published_date: string | undefined;
      if (v.published) {
        const d = new Date(v.published);
        if (!isNaN(d.getTime())) published_date = d.toISOString();
      }

      results.push({
        title,
        url,
        snippet,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'osv',
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
