const cache = new Map<string, string>();

/**
 * Return a stable favicon URL for a result URL. Backed by Google's free
 * `s2/favicons` service so we don't have to fetch the source page just to
 * read a `<link rel="icon">`. Results cached per-host within the process.
 */
export function faviconUrlFor(resultUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(resultUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!host) return undefined;
  const cached = cache.get(host);
  if (cached) return cached;
  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  cache.set(host, url);
  return url;
}

export function _resetFaviconCacheForTest(): void {
  cache.clear();
}
