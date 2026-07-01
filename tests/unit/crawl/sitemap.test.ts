import { describe, it, expect } from 'vitest';
import {
  parseSitemap,
  parseSitemapIndex,
  extractSitemapUrlFromRobots,
  parseSitemapEntries,
  sortSitemapEntries,
} from '../../../src/crawl/sitemap.js';

describe('parseSitemap', () => {
  it('extracts URLs from a standard sitemap.xml', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/docs</loc></url>
  <url><loc>https://example.com/api</loc></url>
</urlset>`;

    const urls = parseSitemap(xml);
    expect(urls).toEqual([
      'https://example.com/',
      'https://example.com/docs',
      'https://example.com/api',
    ]);
  });

  it('returns empty array for invalid XML', () => {
    expect(parseSitemap('not xml')).toEqual([]);
  });

  it('returns empty array for empty urlset', () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    expect(parseSitemap(xml)).toEqual([]);
  });

  it('handles missing loc elements gracefully', () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><lastmod>2024-01-01</lastmod></url>
  <url><loc>https://example.com/valid</loc></url>
</urlset>`;
    expect(parseSitemap(xml)).toEqual(['https://example.com/valid']);
  });
});

describe('parseSitemapIndex', () => {
  it('extracts sitemap URLs from a sitemapindex', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
</sitemapindex>`;

    const urls = parseSitemapIndex(xml);
    expect(urls).toEqual([
      'https://example.com/sitemap-pages.xml',
      'https://example.com/sitemap-posts.xml',
    ]);
  });

  it('returns empty array for non-index sitemap', () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/</loc></url>
    </urlset>`;
    expect(parseSitemapIndex(xml)).toEqual([]);
  });
});

describe('parseSitemapEntries', () => {
  it('returns url with optional lastmod and priority per entry', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/a</loc>
    <lastmod>2026-01-15</lastmod>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://example.com/b</loc>
    <lastmod>2026-05-20</lastmod>
  </url>
  <url>
    <loc>https://example.com/c</loc>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>https://example.com/d</loc>
  </url>
</urlset>`;

    expect(parseSitemapEntries(xml)).toEqual([
      { url: 'https://example.com/a', lastmod: '2026-01-15', priority: 0.8 },
      { url: 'https://example.com/b', lastmod: '2026-05-20' },
      { url: 'https://example.com/c', priority: 0.5 },
      { url: 'https://example.com/d' },
    ]);
  });
});

describe('sortSitemapEntries', () => {
  it('orders by lastmod descending so most recently modified pages come first', () => {
    // Sitemap crawl with budget cap returned the
    // first four alphabetical pages (clients/antitrust/charter/communication)
    // and dropped four "over budget". The most-recent pages were buried
    // alphabetically. After sorting, the recent ones survive the cap.
    const entries = [
      { url: 'https://example.com/antitrust', lastmod: '2024-01-10' },
      { url: 'https://example.com/charter', lastmod: '2024-02-15' },
      { url: 'https://example.com/clients', lastmod: '2024-03-01' },
      { url: 'https://example.com/news-2026-q2', lastmod: '2026-05-20' },
      { url: 'https://example.com/news-2026-q1', lastmod: '2026-03-15' },
    ];

    const sorted = sortSitemapEntries(entries);
    expect(sorted.map(e => e.url)).toEqual([
      'https://example.com/news-2026-q2',
      'https://example.com/news-2026-q1',
      'https://example.com/clients',
      'https://example.com/charter',
      'https://example.com/antitrust',
    ]);
  });

  it('falls back to priority descending when lastmod missing', () => {
    const entries = [
      { url: 'https://example.com/low', priority: 0.2 },
      { url: 'https://example.com/high', priority: 0.9 },
      { url: 'https://example.com/mid', priority: 0.5 },
    ];

    const sorted = sortSitemapEntries(entries);
    expect(sorted.map(e => e.url)).toEqual([
      'https://example.com/high',
      'https://example.com/mid',
      'https://example.com/low',
    ]);
  });

  it('puts entries with lastmod ahead of entries without lastmod', () => {
    const entries = [
      { url: 'https://example.com/old-doc-no-meta' },
      { url: 'https://example.com/recent', lastmod: '2026-05-20' },
      { url: 'https://example.com/another-bare' },
    ];

    const sorted = sortSitemapEntries(entries);
    expect(sorted[0].url).toBe('https://example.com/recent');
  });

  it('preserves input order for entries with no lastmod or priority (stable sort)', () => {
    const entries = [
      { url: 'https://example.com/a' },
      { url: 'https://example.com/b' },
      { url: 'https://example.com/c' },
    ];

    expect(sortSitemapEntries(entries).map(e => e.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
  });
});

describe('extractSitemapUrlFromRobots', () => {
  it('extracts Sitemap directives from robots.txt', () => {
    const robots = `User-agent: *
Disallow: /private/
Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-news.xml`;

    const urls = extractSitemapUrlFromRobots(robots);
    expect(urls).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/sitemap-news.xml',
    ]);
  });

  it('returns empty array when no Sitemap directive', () => {
    const robots = `User-agent: *\nDisallow: /`;
    expect(extractSitemapUrlFromRobots(robots)).toEqual([]);
  });

  it('handles case-insensitive Sitemap directive', () => {
    const robots = `sitemap: https://example.com/sitemap.xml`;
    expect(extractSitemapUrlFromRobots(robots)).toEqual(['https://example.com/sitemap.xml']);
  });
});
