import { parseSitemap, parseSitemapIndex, extractSitemapUrlFromRobots } from './sitemap.js';
import type { RawFetchResult } from '../types.js';

const PROBE_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap.xml.gz'];
const SITEMAP_MIN_URLS = 5;
const MAX_INDEX_CHILDREN = 5;

export type RawFetchFn = (url: string) => Promise<RawFetchResult>;

/**
 * Probe an origin for a usable sitemap. Returns the discovered URL list if
 * at least SITEMAP_MIN_URLS were found; otherwise null so the caller can
 * fall back to a traversal strategy.
 *
 * Order: robots.txt → /sitemap.xml → /sitemap_index.xml. .gz is skipped
 * (decompression deferred).
 */
export async function probeSitemap(origin: string, rawFetch: RawFetchFn): Promise<string[] | null> {
  try {
    const robots = await rawFetch(`${origin}/robots.txt`);
    if (robots.html) {
      const sitemapUrls = extractSitemapUrlFromRobots(robots.html);
      for (const smUrl of sitemapUrls) {
        const urls = await fetchAndParseSitemap(smUrl, rawFetch);
        if (urls && urls.length >= SITEMAP_MIN_URLS) return urls;
      }
    }
  } catch {
    // ignore; fall through to direct probe
  }

  for (const path of PROBE_PATHS) {
    if (path.endsWith('.gz')) continue;
    const urls = await fetchAndParseSitemap(`${origin}${path}`, rawFetch);
    if (urls && urls.length >= SITEMAP_MIN_URLS) return urls;
  }
  return null;
}

async function fetchAndParseSitemap(url: string, rawFetch: RawFetchFn): Promise<string[] | null> {
  try {
    const result = await rawFetch(url);
    if (!result.html) return null;
    if (result.statusCode && result.statusCode >= 400) return null;

    if (result.html.includes('<sitemapindex')) {
      const children = parseSitemapIndex(result.html);
      const all: string[] = [];
      for (const child of children.slice(0, MAX_INDEX_CHILDREN)) {
        const grand = await fetchAndParseSitemap(child, rawFetch);
        if (grand) all.push(...grand);
      }
      return all.length > 0 ? all : null;
    }

    const urls = parseSitemap(result.html);
    return urls.length > 0 ? urls : null;
  } catch {
    return null;
  }
}
