import { parseHTML } from 'linkedom';
import { matchesPatterns } from './url-utils.js';
import { parseSitemap, parseSitemapIndex, extractSitemapUrlFromRobots } from './sitemap.js';
import { createLogger } from '../logger.js';
import type { MapOutput } from '../types.js';

const log = createLogger('crawl');

interface MapInput {
  url: string;
  max_depth?: number;
  max_pages?: number;
  include_patterns?: string[];
  exclude_patterns?: string[];
}

export type LightFetchFn = (url: string) => Promise<{ html: string; finalUrl: string; statusCode: number }>;

const IGNORED_PROTOCOLS = ['javascript:', 'mailto:', 'tel:', 'data:', 'blob:', 'ftp:'];

export function extractLinks(html: string, origin: string): string[] {
  if (!html || !html.trim()) return [];

  try {
    const { document: doc } = parseHTML(html);
    const anchors = doc.querySelectorAll('a[href]');
    const seen = new Set<string>();
    const links: string[] = [];
    const parsedOrigin = new URL(origin).origin;

    for (const anchor of Array.from(anchors)) {
      const href = anchor.getAttribute('href');
      if (!href) continue;

      const trimmed = href.trim();
      if (!trimmed) continue;

      // Skip fragment-only links
      if (trimmed.startsWith('#')) continue;

      // Skip non-http protocols
      if (IGNORED_PROTOCOLS.some((p) => trimmed.toLowerCase().startsWith(p))) continue;

      try {
        const resolved = new URL(trimmed, origin);

        // Same-origin check
        if (resolved.origin !== parsedOrigin) continue;

        // Strip fragment, keep path + query
        resolved.hash = '';
        const normalized = resolved.href;

        if (!seen.has(normalized)) {
          seen.add(normalized);
          links.push(normalized);
        }
      } catch {
        log.debug('Failed to resolve URL', { href: trimmed, origin });
      }
    }

    return links;
  } catch (err) {
    log.debug('Failed to parse HTML for link extraction', { error: String(err) });
    return [];
  }
}

export async function mapUrls(input: MapInput, fetchFn: LightFetchFn): Promise<MapOutput> {
  const maxDepth = input.max_depth ?? 3;
  const maxPages = input.max_pages ?? 200;

  let origin: string;
  try {
    origin = new URL(input.url).origin;
  } catch (err) {
    return {
      urls: [],
      total_found: 0,
      sitemap_found: false,
      error: `Invalid seed URL: ${String(err)}`,
    };
  }

  const discovered = new Set<string>([input.url]);
  const queue: Array<{ url: string; depth: number }> = [{ url: input.url, depth: 0 }];
  let sitemapFound = false;

  // Phase 1: Sitemap discovery (best-effort, errors are non-fatal)
  try {
    const sitemapUrls = await discoverSitemapUrls(origin, fetchFn);
    if (sitemapUrls.length > 0) {
      sitemapFound = true;
      for (const sitemapUrl of sitemapUrls) {
        if (discovered.size >= maxPages) break;
        if (matchesPatterns(sitemapUrl, input.include_patterns, input.exclude_patterns)) {
          discovered.add(sitemapUrl);
        }
      }
    }
  } catch (err) {
    log.debug('Sitemap discovery failed, continuing with BFS only', { error: String(err) });
  }

  // Phase 2: BFS link traversal
  let seedError: string | undefined;

  while (queue.length > 0 && discovered.size < maxPages) {
    const current = queue.shift()!;

    if (current.depth > maxDepth) continue;

    try {
      const { html } = await fetchFn(current.url);
      const links = extractLinks(html, origin);

      for (const link of links) {
        if (discovered.size >= maxPages) break;
        if (discovered.has(link)) continue;
        if (!matchesPatterns(link, input.include_patterns, input.exclude_patterns)) continue;

        discovered.add(link);

        // Only queue for further traversal if we haven't hit max depth
        if (current.depth + 1 <= maxDepth) {
          queue.push({ url: link, depth: current.depth + 1 });
        }
      }
    } catch (err) {
      if (current.url === input.url && current.depth === 0) {
        seedError = String(err);
        log.warn('Seed URL fetch failed during map', { url: current.url, error: String(err) });
      } else {
        log.debug('Child page fetch failed during map, skipping', { url: current.url, error: String(err) });
      }
    }
  }

  const urls = Array.from(discovered);

  return {
    urls,
    total_found: urls.length,
    sitemap_found: sitemapFound,
    ...(seedError !== undefined ? { error: seedError } : {}),
  };
}

async function discoverSitemapUrls(origin: string, fetchFn: LightFetchFn): Promise<string[]> {
  const sitemapLocations: string[] = [];

  // Try robots.txt first for Sitemap directives
  try {
    const { html: robotsTxt } = await fetchFn(`${origin}/robots.txt`);
    const fromRobots = extractSitemapUrlFromRobots(robotsTxt);
    sitemapLocations.push(...fromRobots);
  } catch {
    log.debug('robots.txt not found, trying default sitemap location');
  }

  // Fallback to default /sitemap.xml
  if (sitemapLocations.length === 0) {
    sitemapLocations.push(`${origin}/sitemap.xml`);
  }

  const allUrls: string[] = [];

  for (const sitemapUrl of sitemapLocations) {
    try {
      const { html: sitemapXml } = await fetchFn(sitemapUrl);

      // Check if it's a sitemap index (contains sub-sitemaps)
      const indexUrls = parseSitemapIndex(sitemapXml);
      if (indexUrls.length > 0) {
        for (const subUrl of indexUrls) {
          try {
            const { html: subXml } = await fetchFn(subUrl);
            allUrls.push(...parseSitemap(subXml));
          } catch {
            log.debug('Failed to fetch sub-sitemap', { url: subUrl });
          }
        }
      } else {
        allUrls.push(...parseSitemap(sitemapXml));
      }
    } catch {
      log.debug('Sitemap fetch failed', { url: sitemapUrl });
    }
  }

  return allUrls;
}
