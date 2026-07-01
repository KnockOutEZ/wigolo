// Drop results the agent has already seen.
//
// Normalizes URLs for comparison: lowercased host, drops default ports,
// strips trailing slash + fragment, removes tracking params (utm_*, gclid,
// fbclid), sorts remaining params. Malformed URLs are kept (we don't drop
// on parse error).
//
// For hosts known to serve paths case-insensitively (IIS, docs.microsoft.com,
// archive.org, etc.) the path is also lowercased so /A and /a normalize the
// same way. Callers can extend the allowlist via
// WIGOLO_DEDUP_CASE_INSENSITIVE_HOSTS=a.com,b.org. Paths on github.com,
// pypi.org, etc. stay case-sensitive (RFC 3986 default).

import type { RawSearchResult } from '../../types.js';

const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAM_EXACT = new Set(['gclid', 'fbclid']);

const DEFAULT_CASE_INSENSITIVE_HOSTS: ReadonlySet<string> = new Set([
  'microsoft.com',
  'learn.microsoft.com',
  'docs.microsoft.com',
  'msdn.microsoft.com',
  'support.microsoft.com',
  'archive.org',
  'web.archive.org',
]);

function isTrackingParam(name: string): boolean {
  if (TRACKING_PARAM_EXACT.has(name)) return true;
  for (const p of TRACKING_PARAM_PREFIXES) if (name.startsWith(p)) return true;
  return false;
}

function caseInsensitiveHosts(): Set<string> {
  const set = new Set(DEFAULT_CASE_INSENSITIVE_HOSTS);
  const extra = process.env.WIGOLO_DEDUP_CASE_INSENSITIVE_HOSTS;
  if (extra) {
    for (const raw of extra.split(',')) {
      const h = raw.trim().toLowerCase();
      if (h) set.add(h);
    }
  }
  return set;
}

export function shouldLowercasePathForHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  const hosts = caseInsensitiveHosts();
  if (hosts.has(h)) return true;
  for (const known of hosts) {
    if (h.endsWith('.' + known)) return true;
  }
  return false;
}

/** Normalize a URL for dedup comparison. Throws on malformed input. */
export function normalizeUrlForDedup(url: string): string {
  const u = new URL(url);
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';
  if (
    (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443')
  ) {
    u.port = '';
  }

  if (shouldLowercasePathForHost(u.hostname)) {
    u.pathname = u.pathname.toLowerCase();
  }

  const params = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k));
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);

  let out = u.toString();
  // Drop trailing slash on the path when there are no params (URL serializer
  // keeps "https://x.com/" — we want "https://x.com").
  if (u.pathname !== '/' && out.endsWith('/') && !out.includes('?')) {
    out = out.slice(0, -1);
  } else if (u.pathname === '/' && !u.search) {
    out = out.replace(/\/$/, '');
  }
  return out;
}

function tryNormalize(url: string): string | null {
  try {
    return normalizeUrlForDedup(url);
  } catch {
    return null;
  }
}

export function dedupAgainstRecentUrls(
  results: RawSearchResult[],
  recentUrls: string[] | undefined,
): RawSearchResult[] {
  if (!recentUrls || recentUrls.length === 0) return results;
  const seen = new Set<string>();
  for (const u of recentUrls) {
    const n = tryNormalize(u);
    if (n !== null) seen.add(n);
  }
  if (seen.size === 0) return results;

  return results.filter((r) => {
    const n = tryNormalize(r.url);
    if (n === null) return true; // keep on parse error
    return !seen.has(n);
  });
}
