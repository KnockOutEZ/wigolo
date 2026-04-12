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

  // Date filtering is best-effort on direct scraping engines.
  // SearXNG handles dates natively via time_range. For fallback engines,
  // snippet text doesn't reliably contain dates, so we keep all results.
  return results;
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
