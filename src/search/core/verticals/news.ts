import { HnAlgoliaEngine } from '../../engines/hn-algolia.js';
import { LobstersEngine } from '../../engines/lobsters.js';
import { BingNewsEngine } from '../../engines/bing-news.js';
import { DuckDuckGoEngine } from '../../engines/duckduckgo.js';
import { MojeekEngine } from '../../engines/mojeek.js';
import { wrapWithRetryAndBreaker, type EngineEntry } from '../engine-base.js';
import { RssFeedEngine } from '../rss/rss-engine.js';
import { loadFeedConfig } from '../rss/feed-config.js';
import { countFeedItems } from '../rss/feed-store.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('search');

let cached: EngineEntry[] | null = null;

function hasRssConfigured(): boolean {
  try {
    if (loadFeedConfig().feeds.length > 0) return true;
  } catch {
    // fall through
  }
  try {
    if (countFeedItems() > 0) return true;
  } catch {
    // fall through
  }
  return false;
}

/**
 * Returns the news vertical's engine list. Computed once and memoized.
 *
 * Follow-up: dynamic feed config reload requires resetting the vertical
 * cache (call `_resetNewsEnginesForTest()` for now).
 */
export function getNewsEngines(): EngineEntry[] {
  if (cached) return cached;
  const entries: EngineEntry[] = [
    { engine: wrapWithRetryAndBreaker(new HnAlgoliaEngine()), weight: 1.2, supportsDateFilter: true, quality: 'medium' },
    // Lobsters /search.json has no native date filter; engine applies client-side
    // filtering. Mark false so the orchestrator treats it as date-naive.
    // Quality tier 'low': frequently falls back to "N score · N comments" when
    // description is missing — see engine-quality.ts.
    { engine: wrapWithRetryAndBreaker(new LobstersEngine()), weight: 1.0, supportsDateFilter: false, quality: 'low' },
    // Bing News widens reach beyond HN/Lobsters' tech-only feed. The engine
    // scrapes /search?filters=tnews and surfaces .news_dt → published_date so
    // the recency layer can rank it like the other date-aware engines.
    { engine: wrapWithRetryAndBreaker(new BingNewsEngine()), weight: 0.9, supportsDateFilter: false, quality: 'medium' },
    // HN/Lobsters/Bing-News alone are too
    // tech-skewed and too thin for general news recall — a date-bounded news
    // query was collapsing to HN-Algolia's 2 results. Reusing the general
    // vertical's broad web engines (same adapters as verticals/general.ts)
    // adds independent lexical breadth. They have no server-side date filter
    // (supportsDateFilter:false); the orchestrator freshness-filters their
    // results client-side against the resolved window. `secondary` keeps them
    // from dominating consensus the same way they do in the general pool.
    { engine: wrapWithRetryAndBreaker(new DuckDuckGoEngine()), weight: 0.9, supportsDateFilter: false, secondary: true, quality: 'medium' },
    { engine: wrapWithRetryAndBreaker(new MojeekEngine()), weight: 0.7, supportsDateFilter: false, secondary: true, quality: 'low' },
  ];

  if (hasRssConfigured()) {
    entries.push({
      engine: wrapWithRetryAndBreaker(new RssFeedEngine()),
      weight: 1.5,
      supportsDateFilter: true,
      quality: 'medium',
    });
    log.info('news vertical: rss-feed engine attached');
  }

  cached = entries;
  return cached;
}

export function _resetNewsEnginesForTest(): void {
  cached = null;
}
