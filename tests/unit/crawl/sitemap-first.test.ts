import { describe, it, expect, vi } from 'vitest';
import { probeSitemap, type RawFetchFn } from '../../../src/crawl/sitemap-first.js';
import type { RawFetchResult } from '../../../src/types.js';

function rawOk(html: string): RawFetchResult {
  return {
    url: '',
    finalUrl: '',
    html,
    contentType: 'text/xml',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
}

function raw404(): RawFetchResult {
  return {
    url: '',
    finalUrl: '',
    html: '',
    contentType: 'text/plain',
    statusCode: 404,
    method: 'http',
    headers: {},
  };
}

function makeSitemapXml(count: number, prefix = 'https://example.com/p'): string {
  const urls = Array.from({ length: count }, (_, i) => `<url><loc>${prefix}${i}</loc></url>`).join('\n');
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

describe('probeSitemap', () => {
  it('uses robots.txt Sitemap directive when present', async () => {
    const sitemap = makeSitemapXml(8);
    const robotsTxt = `User-agent: *\nSitemap: https://example.com/custom-sitemap.xml\n`;

    const rawFetch: RawFetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return rawOk(robotsTxt);
      if (url.endsWith('/custom-sitemap.xml')) return rawOk(sitemap);
      return raw404();
    });

    const result = await probeSitemap('https://example.com', rawFetch);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(8);
    expect(result![0]).toBe('https://example.com/p0');
  });

  it('falls back to /sitemap.xml when robots.txt has no Sitemap directive', async () => {
    const sitemap = makeSitemapXml(6);

    const rawFetch: RawFetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return rawOk('User-agent: *\nDisallow:\n');
      if (url.endsWith('/sitemap.xml')) return rawOk(sitemap);
      return raw404();
    });

    const result = await probeSitemap('https://example.com', rawFetch);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(6);
  });

  it('walks sitemap index and aggregates children', async () => {
    const indexXml = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/sitemap-a.xml</loc></sitemap>
      <sitemap><loc>https://example.com/sitemap-b.xml</loc></sitemap>
    </sitemapindex>`;

    const rawFetch: RawFetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return raw404();
      if (url.endsWith('/sitemap.xml')) return rawOk(indexXml);
      if (url.endsWith('/sitemap-a.xml')) return rawOk(makeSitemapXml(3, 'https://example.com/a'));
      if (url.endsWith('/sitemap-b.xml')) return rawOk(makeSitemapXml(4, 'https://example.com/b'));
      return raw404();
    });

    const result = await probeSitemap('https://example.com', rawFetch);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(7);
  });

  it('caps recursion at MAX_INDEX_CHILDREN children', async () => {
    const children = Array.from({ length: 10 }, (_, i) => `<sitemap><loc>https://example.com/sm-${i}.xml</loc></sitemap>`).join('');
    const indexXml = `<?xml version="1.0"?><sitemapindex>${children}</sitemapindex>`;

    let childCalls = 0;
    const rawFetch: RawFetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return raw404();
      if (url.endsWith('/sitemap.xml')) return rawOk(indexXml);
      if (url.includes('/sm-')) {
        childCalls++;
        return rawOk(makeSitemapXml(2));
      }
      return raw404();
    });

    await probeSitemap('https://example.com', rawFetch);
    expect(childCalls).toBeLessThanOrEqual(5);
  });

  it('returns null when all probe paths 404', async () => {
    const rawFetch: RawFetchFn = vi.fn(async () => raw404());
    const result = await probeSitemap('https://example.com', rawFetch);
    expect(result).toBeNull();
  });

  it('returns null when sitemap has fewer than SITEMAP_MIN_URLS', async () => {
    const tiny = makeSitemapXml(2);
    const rawFetch: RawFetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return raw404();
      if (url.endsWith('/sitemap.xml')) return rawOk(tiny);
      return raw404();
    });

    const result = await probeSitemap('https://example.com', rawFetch);
    expect(result).toBeNull();
  });

  it('skips .gz probe path (deferred decompression)', async () => {
    const calls: string[] = [];
    const rawFetch: RawFetchFn = vi.fn(async (url: string) => {
      calls.push(url);
      return raw404();
    });

    await probeSitemap('https://example.com', rawFetch);
    expect(calls.some(u => u.endsWith('.gz'))).toBe(false);
  });

  it('survives robots.txt fetch throwing', async () => {
    const sitemap = makeSitemapXml(6);
    const rawFetch: RawFetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) throw new Error('network down');
      if (url.endsWith('/sitemap.xml')) return rawOk(sitemap);
      return raw404();
    });

    const result = await probeSitemap('https://example.com', rawFetch);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(6);
  });
});
