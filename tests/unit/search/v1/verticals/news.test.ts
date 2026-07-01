import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getNewsEngines,
  _resetNewsEnginesForTest,
} from '../../../../../src/search/core/verticals/news.js';
import { _resetBreakersForTest } from '../../../../../src/search/core/engine-base.js';
import { initDatabase, closeDatabase } from '../../../../../src/cache/db.js';
import {
  upsertFeedItems,
  _clearFeedStoreForTest,
} from '../../../../../src/search/core/rss/feed-store.js';
import { resetConfig } from '../../../../../src/config.js';

const ORIG_ENV = process.env.WIGOLO_RSS_FEEDS;
const ORIG_DATA_DIR = process.env.WIGOLO_DATA_DIR;

describe('getNewsEngines', () => {
  let isolatedDataDir: string;

  beforeEach(() => {
    // Isolate from any real ~/.wigolo/rss-feeds.json on dev machines.
    isolatedDataDir = mkdtempSync(join(tmpdir(), 'wigolo-news-test-'));
    process.env.WIGOLO_DATA_DIR = isolatedDataDir;
    delete process.env.WIGOLO_RSS_FEEDS;
    resetConfig();
    _resetNewsEnginesForTest();
    _resetBreakersForTest();
  });

  afterEach(() => {
    rmSync(isolatedDataDir, { recursive: true, force: true });
    if (ORIG_ENV === undefined) delete process.env.WIGOLO_RSS_FEEDS;
    else process.env.WIGOLO_RSS_FEEDS = ORIG_ENV;
    if (ORIG_DATA_DIR === undefined) delete process.env.WIGOLO_DATA_DIR;
    else process.env.WIGOLO_DATA_DIR = ORIG_DATA_DIR;
    resetConfig();
    try {
      closeDatabase();
    } catch {
      // ignore
    }
  });

  it('returns five entries when no RSS configured and feed store empty', () => {
    expect(getNewsEngines()).toHaveLength(5);
  });

  it('wraps hn-algolia, lobsters, bing_news, duckduckgo, mojeek (preserving names)', () => {
    const names = getNewsEngines().map((e) => e.engine.name);
    expect(names).toEqual(['hn-algolia', 'lobsters', 'bing_news', 'duckduckgo', 'mojeek']);
  });

  // A news search with a time bound used to
  // collapse to HN-Algolia alone because the orchestrator dropped every
  // non-date-aware engine. Widening the vertical with the general web engines
  // (date-naive, client-side freshness-filtered) is half the recall fix.
  it('includes the general web engines duckduckgo + mojeek for breadth', () => {
    const names = getNewsEngines().map((e) => e.engine.name);
    expect(names).toContain('duckduckgo');
    expect(names).toContain('mojeek');
  });

  it('marks duckduckgo + mojeek as date-naive (they freshness-filter client-side)', () => {
    const entries = getNewsEngines();
    const ddg = entries.find((e) => e.engine.name === 'duckduckgo');
    const mojeek = entries.find((e) => e.engine.name === 'mojeek');
    expect(ddg?.supportsDateFilter).toBe(false);
    expect(mojeek?.supportsDateFilter).toBe(false);
  });

  it('weights bing_news lower than HN/lobsters (broader but noisier source)', () => {
    const entries = getNewsEngines();
    const bn = entries.find((e) => e.engine.name === 'bing_news');
    const hn = entries.find((e) => e.engine.name === 'hn-algolia');
    expect(bn?.weight).toBeLessThan(hn?.weight ?? Infinity);
  });

  it('memoizes — two calls return the same array reference', () => {
    const a = getNewsEngines();
    const b = getNewsEngines();
    expect(a).toBe(b);
  });

  it('_resetNewsEnginesForTest clears the cache', () => {
    const a = getNewsEngines();
    _resetNewsEnginesForTest();
    const b = getNewsEngines();
    expect(a).not.toBe(b);
  });

  it('weights HN higher than lobsters', () => {
    const entries = getNewsEngines();
    const hn = entries.find((e) => e.engine.name === 'hn-algolia');
    const lob = entries.find((e) => e.engine.name === 'lobsters');
    expect(hn?.weight).toBeGreaterThan(lob?.weight ?? 0);
  });

  it('marks supportsDateFilter true for hn-algolia and false for lobsters', () => {
    const entries = getNewsEngines();
    const hn = entries.find((e) => e.engine.name === 'hn-algolia');
    const lob = entries.find((e) => e.engine.name === 'lobsters');
    expect(hn?.supportsDateFilter).toBe(true);
    expect(lob?.supportsDateFilter).toBe(false);
  });

  describe('RSS feed integration', () => {
    it('adds rss-feed engine when env-configured (even with empty store)', () => {
      process.env.WIGOLO_RSS_FEEDS = 'https://blog.example.com/feed.xml';
      _resetNewsEnginesForTest();
      const entries = getNewsEngines();
      const names = entries.map((e) => e.engine.name);
      expect(names).toContain('rss-feed');
      const rss = entries.find((e) => e.engine.name === 'rss-feed');
      expect(rss?.weight).toBe(1.5);
      expect(rss?.supportsDateFilter).toBe(true);
    });

    it('adds rss-feed engine when feed store has rows (even if env unset)', () => {
      initDatabase(':memory:');
      _clearFeedStoreForTest();
      upsertFeedItems([
        {
          feedUrl: 'https://stored.example.com/feed',
          guid: 's-1',
          title: 'A stored item',
          link: 'https://stored.example.com/1',
          summary: 'body',
        },
      ]);
      _resetNewsEnginesForTest();
      const names = getNewsEngines().map((e) => e.engine.name);
      expect(names).toContain('rss-feed');
    });

    it('does not add rss-feed engine when both env unset and store empty', () => {
      const names = getNewsEngines().map((e) => e.engine.name);
      expect(names).not.toContain('rss-feed');
    });

    it('memoizes RSS decision — adding feeds after first call does not change result', () => {
      const before = getNewsEngines();
      process.env.WIGOLO_RSS_FEEDS = 'https://late.example.com/feed';
      const after = getNewsEngines();
      expect(after).toBe(before);
    });
  });
});
