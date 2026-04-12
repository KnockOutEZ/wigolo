import type { FetchOutput, CrawlInput, CrawlOutput, CrawlResultItem, LinkEdge, RawFetchResult } from '../types.js';
import { matchesPatterns } from './url-utils.js';
import { RateLimiter } from './rate-limiter.js';
import { RobotsParser } from './robots.js';
import { parseSitemap, parseSitemapIndex, extractSitemapUrlFromRobots } from './sitemap.js';
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

    // Queue: [url, depth]
    const queue: Array<[string, number]> = [[input.url, 0]];
    visited.add(input.url);

    while (queue.length > 0 && pages.length < maxPages) {
      const item = strategy === 'dfs' ? queue.pop()! : queue.shift()!;
      const [url, depth] = item;

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

      pages.push({
        url: fetchResult.url,
        title: fetchResult.title,
        markdown: fetchResult.markdown,
        depth,
      });

      // Discover links for traversal
      if (depth < maxDepth) {
        const newLinks = this.filterLinks(fetchResult.links, seedOrigin, visited, input.include_patterns, input.exclude_patterns, robotsParser);

        for (const link of newLinks) {
          visited.add(link);
          queue.push([link, depth + 1]);
        }

        if (input.extract_links) {
          for (const link of fetchResult.links) {
            allLinks.push({ from: url, to: link });
          }
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
    return links.filter((link) => {
      try {
        const parsed = new URL(link);
        // Same origin only
        if (parsed.origin !== seedOrigin) return false;
        // Not already visited
        if (visited.has(link)) return false;
        // Pattern matching
        if (!matchesPatterns(link, includePatterns, excludePatterns)) return false;
        // Robots.txt
        if (robotsParser && !robotsParser.isAllowed(parsed.pathname)) return false;
        return true;
      } catch {
        return false;
      }
    });
  }

  async crawlSitemap(
    input: CrawlInput,
    seedOrigin: string,
    maxPages: number,
    robotsParser: RobotsParser | null,
  ): Promise<CrawlOutput> {
    // Discover sitemap URLs (pass already-fetched robots.txt content)
    let sitemapUrls = await this.discoverSitemapUrls(seedOrigin, this.robotsTxtContent);

    if (sitemapUrls.length === 0) {
      log.info('No sitemap found, falling back to BFS');
      return this.crawlTraversal(input, seedOrigin, input.max_depth ?? 2, maxPages, 'bfs', robotsParser);
    }

    // Filter by patterns
    sitemapUrls = sitemapUrls.filter((url) =>
      matchesPatterns(url, input.include_patterns, input.exclude_patterns),
    );

    const totalFound = sitemapUrls.length;
    const toFetch = sitemapUrls.slice(0, maxPages);
    const pages: CrawlResultItem[] = [];
    const allLinks: LinkEdge[] = [];

    for (const url of toFetch) {
      if (pages.length >= maxPages) break;

      if (robotsParser && !robotsParser.isAllowed(new URL(url).pathname)) continue;

      const release = await this.rateLimiter.acquire(url);

      try {
        const result = await this.fetchFn(url);
        release();

        if (!result.error) {
          pages.push({ url: result.url, title: result.title, markdown: result.markdown, depth: 0 });

          if (input.extract_links) {
            for (const link of result.links) {
              allLinks.push({ from: url, to: link });
            }
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

  private async discoverSitemapUrls(origin: string, robotsTxt: string | null): Promise<string[]> {
    const sitemapLocations: string[] = [];

    // Check robots.txt for sitemap references (reuses already-fetched content)
    if (robotsTxt) {
      sitemapLocations.push(...extractSitemapUrlFromRobots(robotsTxt));
    }

    // Try default location
    if (sitemapLocations.length === 0) {
      sitemapLocations.push(`${origin}/sitemap.xml`);
    }

    const allUrls: string[] = [];

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
                allUrls.push(...parseSitemap(subResult.html));
              }
            } catch {
              // skip failed sub-sitemaps
            }
          }
        } else {
          allUrls.push(...parseSitemap(result.html));
        }
      } catch {
        // skip failed sitemap fetches
      }
    }

    return allUrls;
  }
}
