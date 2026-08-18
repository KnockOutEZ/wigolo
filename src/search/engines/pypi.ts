import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const JSON_URL = 'https://pypi.org/pypi';
const MAX_CANDIDATES = 5;

// PEP 508 / packaging project names: ASCII letters, digits, `_`, `-`, `.`,
// starting and ending with alphanumeric. Used to reject query tokens before
// interpolating them into a URL.
const PROJECT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'for',
  'to',
  'of',
  'in',
  'on',
  'with',
  'from',
  'by',
  'is',
  'are',
  'how',
  'what',
  'why',
  'can',
  'using',
  'use',
  'vs',
  'python',
  'py',
  'lib',
  'library',
  'package',
  'module',
]);

interface PypiInfo {
  name?: unknown;
  version?: unknown;
  summary?: unknown;
  yanked?: unknown;
  package_url?: unknown;
  project_url?: unknown;
}

interface PypiFile {
  upload_time_iso_8601?: unknown;
}

interface PypiResponse {
  info?: PypiInfo;
  urls?: PypiFile[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function pep503Normalize(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

function isProjectName(raw: string): boolean {
  return PROJECT_NAME.test(raw);
}

/**
 * Turn a free-text code query into a small set of PyPI project names.
 *
 * PyPI has no public search JSON API (XML-RPC search is disabled; `/search/`
 * is HTML-only and not a supported integration). The documented JSON API is
 * exact project lookup (`GET /pypi/<name>/json`), so we derive candidates:
 * the whole query hyphenated when every token looks like a name (so
 * "google cloud storage" tries `google-cloud-storage`), then each remaining
 * name-like token.
 */
export function candidatesFromQuery(query: string, maxCandidates: number): string[] {
  const cap = Math.min(Math.max(maxCandidates, 1), MAX_CANDIDATES);
  const trimmed = query.trim();
  if (!trimmed) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  const tokens = trimmed.split(/\s+/);

  const add = (raw: string): void => {
    if (out.length >= cap) return;
    if (!isProjectName(raw)) return;
    const normalized = pep503Normalize(raw);
    if (!normalized || STOPWORDS.has(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  // Hyphenate the whole phrase only when every token looks like a name.
  // "how to use requests" must not become how-to-use-requests.
  const tokenNorms = tokens.map((token) => pep503Normalize(token));
  if (tokens.length > 1 && tokenNorms.every((token) => token && !STOPWORDS.has(token))) {
    add(trimmed.replace(/\s+/g, '-'));
  }
  for (const token of tokens) add(token);
  return out;
}

function projectPageUrl(name: string, candidate: unknown): string {
  const fallback = `https://pypi.org/project/${name}`;
  const raw = asString(candidate);
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return fallback;
    if (parsed.hostname !== 'pypi.org' && parsed.hostname !== 'www.pypi.org') return fallback;
    if (!parsed.pathname.startsWith('/project/')) return fallback;
    return raw;
  } catch {
    return fallback;
  }
}

function parseUploadTime(stamp: string): number | undefined {
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : undefined;
}

function latestUpload(urls: unknown): string | undefined {
  if (!Array.isArray(urls)) return undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  let latest: string | undefined;
  for (const file of urls) {
    if (!file || typeof file !== 'object') continue;
    const stamp = asString((file as PypiFile).upload_time_iso_8601);
    if (!stamp) continue;
    const ms = parseUploadTime(stamp);
    if (ms === undefined) continue;
    if (ms > latestMs) {
      latestMs = ms;
      latest = stamp;
    }
  }
  return latest;
}

function parseProject(data: PypiResponse, fallbackName: string): RawSearchResult | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const info = data.info;
  if (!info || typeof info !== 'object') return null;
  const rawName = asString(info.name);
  if (!rawName || !isProjectName(rawName) || info.yanked === true) return null;

  const name = pep503Normalize(rawName) || fallbackName;
  const summary = asString(info.summary) ?? '';
  const version = asString(info.version);
  const snippet = [summary, version ? `(v${version})` : ''].filter((part) => part.length > 0).join(' ');
  const url = projectPageUrl(name, info.package_url ?? info.project_url);
  const published_date = latestUpload(data.urls);

  return {
    title: rawName,
    url,
    snippet,
    relevance_score: 0,
    engine: 'pypi',
    ...(published_date ? { published_date } : {}),
  };
}

// PyPI's public JSON API: free, no key, returns name/summary/version for a
// known project. Adds a canonical Python-package-registry signal to the code
// vertical — useful when a query names or resembles a PyPI project (e.g.
// "httpx async client") so the ecosystem's own metadata (not just blog posts
// or Stack Overflow) surfaces directly.
//
// PyPI asks callers to send a descriptive User-Agent; a generic or missing UA
// can be throttled. Lookups are serial and capped so a multi-word query does
// not fan out into an unmetered request burst.
export class PypiEngine implements SearchEngine {
  name = 'pypi';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;
    const candidates = candidatesFromQuery(query, MAX_CANDIDATES);
    if (candidates.length === 0) return [];

    log.debug('pypi search', { query, candidates });

    const signal = AbortSignal.timeout(timeoutMs);
    const results: RawSearchResult[] = [];

    for (const candidate of candidates) {
      if (results.length >= maxResults) break;

      const url = `${JSON_URL}/${encodeURIComponent(candidate)}/json`;
      const response = await fetch(url, {
        signal,
        headers: {
          'User-Agent': 'wigolo/0.1 (https://github.com/KnockOutEZ/wigolo)',
          Accept: 'application/json',
        },
      });

      // 404/400: this candidate is not a project. Keep going rather than
      // failing the whole search (unknown names are the common case).
      if (response.status === 404 || response.status === 400) continue;
      if (!response.ok) throw new Error(`pypi returned ${response.status}`);

      const data = (await response.json()) as unknown;
      if (!data || typeof data !== 'object') continue;
      const parsed = parseProject(data as PypiResponse, candidate);
      if (!parsed) continue;
      results.push(parsed);
    }

    const total = results.length;
    return results.map((result, i) => ({
      ...result,
      relevance_score: 1 - i / Math.max(total, 1),
    }));
  }
}
