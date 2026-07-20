import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const SNIPPET_LIMIT = 200;

interface NvdCveDescription {
  lang: string;
  value: string;
}

interface NvdCveItem {
  cve: {
    id: string;
    published: string;
    descriptions?: NvdCveDescription[];
  };
}

interface NvdResponse {
  vulnerabilities?: NvdCveItem[];
  totalResults?: number;
}

export class NvdEngine implements SearchEngine {
  name = 'nvd';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({
      keywordSearch: query,
      resultsPerPage: String(maxResults),
    });

    // NVD accepts pubStartDate and pubEndDate in ISO 8601 extended format with timezone.
    // E.g., 2024-01-01T00:00:00.000%2B00:00
    // But they have strict limitations (max 120 days range) without an API key,
    // so we will apply date filters client-side just like arxiv does.

    const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?${params}`;
    log.debug('nvd search', { query });

    const fetchOptions: RequestInit = {
      signal: AbortSignal.timeout(timeoutMs),
      // Set a User-Agent as a courtesy to the NIST NVD team
      headers: { 'User-Agent': 'Wigolo Search Agent' },
    };

    // If an API key is available in the environment in the future, we can add it:
    // if (process.env.NVD_API_KEY) fetchOptions.headers['apiKey'] = process.env.NVD_API_KEY;

    const response = await fetch(url, fetchOptions);
    if (!response.ok) throw new Error(`NVD returned ${response.status}`);

    const data = (await response.json()) as NvdResponse;
    const mapped = this.parseCves(data.vulnerabilities ?? []);
    
    return applyDateFilter(mapped, options);
  }

  private parseCves(vulns: NvdCveItem[]): RawSearchResult[] {
    const results: RawSearchResult[] = [];
    const total = vulns.length;

    for (let i = 0; i < total; i++) {
      const cveObj = vulns[i].cve;
      if (!cveObj || !cveObj.id) continue;

      const title = cveObj.id;
      const url = `https://nvd.nist.gov/vuln/detail/${cveObj.id}`;
      
      let description = '';
      if (cveObj.descriptions) {
        const enDesc = cveObj.descriptions.find((d) => d.lang === 'en');
        if (enDesc) description = enDesc.value;
      }
      
      const snippet = description.slice(0, SNIPPET_LIMIT);

      let published_date: string | undefined;
      if (cveObj.published) {
        const pubStr = cveObj.published.endsWith('Z') ? cveObj.published : cveObj.published + 'Z';
        const d = new Date(pubStr);
        if (!isNaN(d.getTime())) published_date = d.toISOString();
      }

      results.push({
        title,
        url,
        snippet,
        // NVD doesn't explicitly return a relevance score but we requested keyword search
        // and results are typically returned with best matches first.
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'nvd',
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
