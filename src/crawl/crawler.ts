import type { FetchOutput, CrawlInput, CrawlOutput, CrawlResultItem, LinkEdge, RawFetchResult } from '../types.js';
import { matchesPatterns, canonicalForCrawl, canonicalForOutput, stripFragment } from './url-utils.js';
import { RateLimiter } from './rate-limiter.js';
import { RobotsParser } from './robots.js';
import {
  parseSitemap,
  parseSitemapIndex,
  parseSitemapEntries,
  sortSitemapEntries,
  extractSitemapUrlFromRobots,
  type SitemapEntry,
} from './sitemap.js';
import { probeSitemap } from './sitemap-first.js';
import { isIndexingEnabled, enqueueIndexCrawl } from './index-to-vec.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('crawl');

export type FetchFn = (url: string) => Promise<FetchOutput>;
export type RawFetchFn = (url: string) => Promise<RawFetchResult>;

export class Crawler {
  private fetchFn: FetchFn;
  private rawFetchFn: RawFetchFn;
  private rateLimiter = new RateLimiter();

  constructor(fetchFn: FetchFn, rawFetchFn: RawFetchFn) {
    this.fetchFn = fetchFn;
    this.rawFetchFn = rawFetchFn;
  }

  async crawl(input: CrawlInput): Promise<CrawlOutput> {
    const strategy = input.strategy ?? 'bfs';
    const maxDepth = input.max_depth ?? 2;
    const maxPages = input.max_pages ?? 20;

    const seedOrigin = new URL(input.url).origin;

    // Fetch and parse robots.txt if configured
    const config = getConfig();
    let robotsParser: RobotsParser | null = null;
    if (config.respectRobotsTxt) {
      robotsParser = await this.fetchRobots(seedOrigin);
    }

    if (strategy === 'auto') {
      const sitemapUrls = await probeSitemap(seedOrigin, this.rawFetchFn);
      if (sitemapUrls && sitemapUrls.length > 0) {
        log.info('auto strategy: using sitemap', { origin: seedOrigin, urls: sitemapUrls.length });
        return this.crawlFromExplicitUrls(input, sitemapUrls, maxPages, robotsParser);
      }
      log.info('auto strategy: no sitemap found, falling back to BFS', { origin: seedOrigin });
      return this.crawlTraversal(input, seedOrigin, maxDepth, maxPages, 'bfs', robotsParser);
    }

    if (strategy === 'sitemap') {
      return this.crawlSitemap(input, seedOrigin, maxPages, robotsParser);
    }

    const traversalStrategy = strategy === 'map' ? 'bfs' : strategy;
    return this.crawlTraversal(input, seedOrigin, maxDepth, maxPages, traversalStrategy, robotsParser);
  }

  private robotsTxtContent: string | null = null;

  private async fetchRobots(origin: string): Promise<RobotsParser | null> {
    try {
      const result = await this.rawFetchFn(`${origin}/robots.txt`);
      if (result.statusCode === 200 && result.html) {
        this.robotsTxtContent = result.html;
        const parser = new RobotsParser(result.html);
        const crawlDelay = parser.getCrawlDelay();
        if (crawlDelay !== null) {
          const domain = new URL(origin).hostname;
          this.rateLimiter.setRobotsCrawlDelay(domain, crawlDelay);
        }
        return parser;
      }
    } catch {
      log.debug('Could not fetch robots.txt', { origin });
    }
    return null;
  }

  private async crawlTraversal(
    input: CrawlInput,
    seedOrigin: string,
    maxDepth: number,
    maxPages: number,
    strategy: 'bfs' | 'dfs',
    robotsParser: RobotsParser | null,
  ): Promise<CrawlOutput> {
    const visited = new Set<string>();
    const pages: CrawlResultItem[] = [];
    const allLinks: LinkEdge[] = [];
    // track which (from, fragment-stripped to) pairs we've already emitted
    // into the link graph so /foo, /foo#a, /foo#b collapse to ONE edge.
    const seenEdges = new Set<string>();
    const indexing = isIndexingEnabled();

    // Queue: [url, depth]
    const queue: Array<[string, number]> = [[input.url, 0]];
    visited.add(canonicalForCrawl(input.url));

    while (queue.length > 0 && pages.length < maxPages) {
      const next = strategy === 'dfs' ? queue.pop()! : queue.shift()!;
      const [url, depth] = next;

      // Check robots.txt
      if (robotsParser && !robotsParser.isAllowed(new URL(url).pathname)) {
        log.debug('Blocked by robots.txt', { url });
        continue;
      }

      // Rate limit
      const release = await this.rateLimiter.acquire(url);

      let fetchResult: FetchOutput;
      try {
        fetchResult = await this.fetchFn(url);
      } catch (err) {
        log.warn('Fetch failed during crawl', { url, error: String(err) });
        release();
        continue;
      }

      release();

      if (fetchResult.error) {
        log.warn('Fetch returned error', { url, error: fetchResult.error });
        continue;
      }

      const item: CrawlResultItem = {
        url: canonicalForOutput(fetchResult.url),
        title: fetchResult.title,
        markdown: fetchResult.markdown,
        depth,
      };
      pages.push(item);

      if (indexing) await enqueueIndexCrawl(item);

      // Discover links for traversal
      if (depth < maxDepth) {
        const newLinks = this.filterLinks(fetchResult.links, seedOrigin, visited, input.include_patterns, input.exclude_patterns, robotsParser);

        // filterLinks() runs against the visited snapshot before this loop,
        // so two outbound links with the same canonical (e.g. /page#a and
        // /page#b — different anchors, same target) both pass. Re-check
        // here so we don't queue the same canonical twice and fetch the
        // same page repeatedly under different fragments.
        for (const link of newLinks) {
          const canonical = canonicalForCrawl(link);
          if (visited.has(canonical)) continue;
          visited.add(canonical);
          queue.push([link, depth + 1]);
        }

        if (input.extract_links) {
          // anchor fragments are intra-page navigation, not page
          // identity. Strip `#section-a` / `#section-b` before adding to
          // the link graph so /foo, /foo#a, /foo#b collapse to ONE edge.
          addUniqueEdges(allLinks, seenEdges, url, fetchResult.links);
        }
      }
    }

    // total_found = all unique URLs discovered (visited set), including unvisited queue items
    return {
      pages,
      total_found: visited.size,
      crawled: pages.length,
      ...(input.extract_links ? { links: allLinks } : {}),
    };
  }

  private filterLinks(
    links: string[],
    seedOrigin: string,
    visited: Set<string>,
    includePatterns: string[] | undefined,
    excludePatterns: string[] | undefined,
    robotsParser: RobotsParser | null,
  ): string[] {
    const filtered = links.filter((link) => {
      try {
        const parsed = new URL(link);
        if (parsed.origin !== seedOrigin) return false;
        if (visited.has(canonicalForCrawl(link))) return false;
        if (!matchesPatterns(link, includePatterns, excludePatterns)) return false;
        if (robotsParser && !robotsParser.isAllowed(parsed.pathname)) return false;
        return true;
      } catch {
        return false;
      }
    });

    // Prioritize documentation pages over marketing/nav pages
    return filtered.sort((a, b) => {
      const aDoc = isDocPage(a) ? 0 : 1;
      const bDoc = isDocPage(b) ? 0 : 1;
      return aDoc - bDoc;
    });
  }

  async crawlSitemap(
    input: CrawlInput,
    seedOrigin: string,
    maxPages: number,
    robotsParser: RobotsParser | null,
  ): Promise<CrawlOutput> {
    // Discover sitemap URLs (pass already-fetched robots.txt content)
    const sitemapUrls = await this.discoverSitemapUrls(seedOrigin, this.robotsTxtContent);

    if (sitemapUrls.length === 0) {
      log.info('No sitemap found, falling back to BFS');
      return this.crawlTraversal(input, seedOrigin, input.max_depth ?? 2, maxPages, 'bfs', robotsParser);
    }

    return this.crawlFromExplicitUrls(input, sitemapUrls, maxPages, robotsParser);
  }

  /**
   * Crawl an explicit list of URLs (e.g. from a sitemap probe). Applies
   * include/exclude patterns, robots.txt, max_pages, and rate limits the
   * same way as crawlSitemap.
   */
  private async crawlFromExplicitUrls(
    input: CrawlInput,
    urls: string[],
    maxPages: number,
    robotsParser: RobotsParser | null,
  ): Promise<CrawlOutput> {
    // De-duplicate by canonical form first so /foo and /foo/ collapse before
    // pattern filtering, then keep the first occurrence's original URL for
    // the network fetch (some servers 404 on the slash-stripped variant).
    const seenCanonical = new Set<string>();
    const dedupedUrls: string[] = [];
    for (const url of urls) {
      const canonical = canonicalForCrawl(url);
      if (seenCanonical.has(canonical)) continue;
      seenCanonical.add(canonical);
      dedupedUrls.push(url);
    }

    const filtered = dedupedUrls.filter((url) =>
      matchesPatterns(url, input.include_patterns, input.exclude_patterns),
    );

    const totalFound = filtered.length;
    const toFetch = filtered.slice(0, maxPages);
    const pages: CrawlResultItem[] = [];
    const allLinks: LinkEdge[] = [];
    // see crawlTraversal — same dedup key used here so the sitemap path
    // emits one edge per (from, canonical-to) pair.
    const seenEdges = new Set<string>();
    const indexing = isIndexingEnabled();

    for (const url of toFetch) {
      if (pages.length >= maxPages) break;

      if (robotsParser && !robotsParser.isAllowed(new URL(url).pathname)) continue;

      const release = await this.rateLimiter.acquire(url);

      try {
        const result = await this.fetchFn(url);
        release();

        if (!result.error) {
          const item: CrawlResultItem = { url: canonicalForOutput(result.url), title: result.title, markdown: result.markdown, depth: 0 };
          pages.push(item);

          if (indexing) await enqueueIndexCrawl(item);

          if (input.extract_links) {
            // dedupe fragment variants in the link graph.
            addUniqueEdges(allLinks, seenEdges, url, result.links);
          }
        }
      } catch (err) {
        release();
        log.warn('Sitemap fetch failed', { url, error: String(err) });
      }
    }

    return {
      pages,
      total_found: totalFound,
      crawled: pages.length,
      ...(input.extract_links ? { links: allLinks } : {}),
    };
  }

  private async discoverSitemapUrls(origin: string, robotsTxt: string | null | undefined): Promise<string[]> {
    const sitemapLocations: string[] = [];

    // Check robots.txt for sitemap references (reuses already-fetched content)
    if (robotsTxt) {
      sitemapLocations.push(...extractSitemapUrlFromRobots(robotsTxt));
    }

    // Try default location
    if (sitemapLocations.length === 0) {
      sitemapLocations.push(`${origin}/sitemap.xml`);
    }

    const allEntries: SitemapEntry[] = [];

    for (const sitemapUrl of sitemapLocations) {
      try {
        const result = await this.rawFetchFn(sitemapUrl);
        if (result.statusCode !== 200) continue;

        // Check if it's a sitemap index
        const indexUrls = parseSitemapIndex(result.html);
        if (indexUrls.length > 0) {
          // Fetch each sub-sitemap
          for (const subUrl of indexUrls) {
            try {
              const subResult = await this.rawFetchFn(subUrl);
              if (subResult.statusCode === 200) {
                allEntries.push(...parseSitemapEntries(subResult.html));
              }
            } catch {
              // skip failed sub-sitemaps
            }
          }
        } else {
          allEntries.push(...parseSitemapEntries(result.html));
        }
      } catch {
        // skip failed sitemap fetches
      }
    }

    // Sort so the most recently modified pages survive the max_pages cap.
    // Document order is usually alphabetical, which buried fresh content
    // under stale glossary pages.
    return sortSitemapEntries(allEntries).map(e => e.url);
  }
}

const DOC_PATH_PATTERNS = ['/docs/', '/guide/', '/api/', '/reference/'];

function isDocPage(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  return DOC_PATH_PATTERNS.some(p => path.includes(p));
}

// emit one LinkEdge per (from, fragment-stripped to). For example,
// /foo, /foo#section-a, /foo#section-b previously created three distinct
// edges; collapse to one by keying off the fragment-stripped target.
function addUniqueEdges(
  edges: LinkEdge[],
  seen: Set<string>,
  from: string,
  links: string[],
): void {
  for (const link of links) {
    const canonicalTo = stripFragment(link);
    const key = `${from} ${canonicalTo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to: canonicalTo });
  }
}
