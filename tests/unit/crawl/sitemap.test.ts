import { describe, it, expect } from 'vitest';
import { parseSitemap, parseSitemapIndex, extractSitemapUrlFromRobots } from '../../../src/crawl/sitemap.js';

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
