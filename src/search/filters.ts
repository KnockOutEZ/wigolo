function getDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeDomain(domain: string): string {
  return domain.replace(/\/+$/, '').toLowerCase();
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = normalizeDomain(domain);
  return hostname === normalized || hostname.endsWith('.' + normalized);
}

export function filterByDomains<T extends { url: string }>(
  results: T[],
  includeDomains?: string[],
  excludeDomains?: string[],
): T[] {
  if (!includeDomains?.length && !excludeDomains?.length) return results;

  return results.filter((r) => {
    const hostname = getDomain(r.url);
    if (!hostname) {
      return !includeDomains?.length;
    }
    if (includeDomains?.length) {
      if (!includeDomains.some((d) => domainMatches(hostname, d))) return false;
    }
    if (excludeDomains?.length) {
      if (excludeDomains.some((d) => domainMatches(hostname, d))) return false;
    }
    return true;
  });
}

function isValidIsoDate(dateStr: string): boolean {
  const parsed = new Date(dateStr);
  return !isNaN(parsed.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

export function filterByDateRange<T>(
  results: T[],
  fromDate?: string,
  toDate?: string,
): T[] {
  if (!fromDate && !toDate) return results;

  if (fromDate && !isValidIsoDate(fromDate)) return results;
  if (toDate && !isValidIsoDate(toDate)) return results;

  if (fromDate && toDate && new Date(fromDate) > new Date(toDate)) return results;

  const fromMs = fromDate ? new Date(fromDate).getTime() : null;
  // toDate inclusive: treat as end-of-day so 'to=2026-01-31' keeps anything stamped Jan 31.
  const toMs = toDate ? new Date(toDate).getTime() + 24 * 3600 * 1000 - 1 : null;

  // Drop results with a published_date outside the window. Results without a
  // published_date pass through — SearXNG and most fallback engines do not
  // expose reliable dates per result, and the user's request for recency is
  // already biased via time_range on the upstream call.
  return results.filter((r) => {
    const published = (r as { published_date?: unknown }).published_date;
    if (typeof published !== 'string' || !published) return true;
    const t = Date.parse(published);
    if (isNaN(t)) return true;
    if (fromMs !== null && t < fromMs) return false;
    if (toMs !== null && t > toMs) return false;
    return true;
  });
}

export function filterByCategory<T>(
  results: T[],
  _category?: string,
): T[] {
  // Category filtering is handled by SearXNG natively.
  return results;
}

export interface FilterOptions {
  includeDomains?: string[];
  excludeDomains?: string[];
  fromDate?: string;
  toDate?: string;
  category?: string;
}

export function applyAllFilters<T extends { url: string }>(
  results: T[],
  options: FilterOptions,
): T[] {
  let filtered = filterByDomains(results, options.includeDomains, options.excludeDomains);
  filtered = filterByDateRange(filtered, options.fromDate, options.toDate);
  filtered = filterByCategory(filtered, options.category);
  return filtered;
}
