export { Crawler } from './crawler.js';
export type { FetchFn, RawFetchFn } from './crawler.js';

export { RateLimiter } from './rate-limiter.js';
export type { RateLimiterOptions } from './rate-limiter.js';

export { RobotsParser } from './robots.js';

export { parseSitemap, parseSitemapIndex } from './sitemap.js';
export type { SitemapEntry } from './sitemap.js';
export { probeSitemap } from './sitemap-first.js';

export {
  deduplicatePages,
  normalizeBlockText,
  splitIntoBlocks,
  stripRepeatedNavigationLines,
} from './dedup.js';

export {
  canonicalForCrawl,
  canonicalForOutput,
  isPrivateUrl,
  matchesPatterns,
  stripFragment,
} from './url-utils.js';

export { conditionalFetch } from './etag-incremental.js';
export type { ConditionalFetchOptions } from './etag-incremental.js';
