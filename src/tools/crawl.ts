import type { CrawlInput, CrawlOutput } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import { Crawler } from '../crawl/crawler.js';
import { deduplicatePages } from '../crawl/dedup.js';
import { handleFetch } from './fetch.js';
import { createLogger } from '../logger.js';

const log = createLogger('crawl');

const DEFAULT_MAX_TOTAL_CHARS = 100000;

export async function handleCrawl(
  input: CrawlInput,
  router: SmartRouter,
): Promise<CrawlOutput> {
  try {
    const fetchFn = async (url: string) =>
      handleFetch({ url, use_auth: input.use_auth }, router);

    const rawFetchFn = async (url: string) =>
      router.fetch(url, { renderJs: 'never' });

    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl(input);

    // Deduplicate cross-page content (pass domain for SQLite boilerplate caching)
    const domain = new URL(input.url).hostname;
    const dedupedPages = deduplicatePages(
      result.pages.map((p) => ({ url: p.url, markdown: p.markdown })),
      domain,
    );

    // Apply deduped markdown back to pages
    const pages = result.pages.map((page, i) => ({
      ...page,
      markdown: dedupedPages[i]?.markdown ?? page.markdown,
    }));

    // Enforce max_total_chars budget
    const maxTotalChars = input.max_total_chars ?? DEFAULT_MAX_TOTAL_CHARS;
    const budgetedPages = [];
    let charCount = 0;

    for (const page of pages) {
      if (charCount + page.markdown.length > maxTotalChars && budgetedPages.length > 0) {
        break;
      }
      budgetedPages.push(page);
      charCount += page.markdown.length;
    }

    log.info('Crawl complete', {
      url: input.url,
      crawled: result.crawled,
      returned: budgetedPages.length,
      totalChars: charCount,
    });

    return {
      pages: budgetedPages,
      total_found: result.total_found,
      crawled: result.crawled,
      ...(result.links ? { links: result.links } : {}),
    };
  } catch (err) {
    log.error('Crawl failed', { url: input.url, error: String(err) });
    return {
      pages: [],
      total_found: 0,
      crawled: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
