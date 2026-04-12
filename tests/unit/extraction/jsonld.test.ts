import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJsonLd, matchJsonLdToSchema } from '../../../src/extraction/jsonld.js';

const articleHtml = readFileSync(
  join(import.meta.dirname, '../../fixtures/extraction/jsonld-article.html'),
  'utf-8',
);

const productHtml = readFileSync(
  join(import.meta.dirname, '../../fixtures/extraction/product-page.html'),
  'utf-8',
);

describe('extractJsonLd', () => {
  it('extracts single JSON-LD block from article page', () => {
    const results = extractJsonLd(articleHtml);
    expect(results).toHaveLength(1);
    expect(results[0]['@type']).toBe('Article');
    expect(results[0].headline).toBe('Understanding TypeScript Generics');
  });

  it('extracts nested author from JSON-LD', () => {
    const results = extractJsonLd(articleHtml);
    const author = results[0].author as Record<string, unknown>;
    expect(author.name).toBe('Jane Doe');
  });

  it('returns empty array when no JSON-LD present', () => {
    const html = '<html><head></head><body>no data</body></html>';
    expect(extractJsonLd(html)).toEqual([]);
  });

  it('handles multiple JSON-LD blocks', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type": "Organization", "name": "Acme"}</script>
      <script type="application/ld+json">{"@type": "WebSite", "name": "Site"}</script>
    </head><body></body></html>`;
    const results = extractJsonLd(html);
    expect(results).toHaveLength(2);
    expect(results[0]['@type']).toBe('Organization');
    expect(results[1]['@type']).toBe('WebSite');
  });

  it('skips malformed JSON-LD gracefully', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type": "Good", "name": "Valid"}</script>
      <script type="application/ld+json">{bad json here</script>
    </head><body></body></html>`;
    const results = extractJsonLd(html);
    expect(results).toHaveLength(1);
    expect(results[0]['@type']).toBe('Good');
  });

  it('flattens JSON-LD array (multiple items in one block)', () => {
    const html = `<html><head>
      <script type="application/ld+json">[
        {"@type": "BreadcrumbList", "name": "Crumbs"},
        {"@type": "Product", "name": "Widget"}
      ]</script>
    </head><body></body></html>`;
    const results = extractJsonLd(html);
    expect(results).toHaveLength(2);
    expect(results[0]['@type']).toBe('BreadcrumbList');
    expect(results[1]['@type']).toBe('Product');
  });

  it('handles @graph container', () => {
    const html = `<html><head>
      <script type="application/ld+json">{
        "@context": "https://schema.org",
        "@graph": [
          {"@type": "WebPage", "name": "Page"},
          {"@type": "Organization", "name": "Org"}
        ]
      }</script>
    </head><body></body></html>`;
    const results = extractJsonLd(html);
    expect(results).toHaveLength(2);
    const types = results.map((r) => r['@type']);
    expect(types).toContain('WebPage');
    expect(types).toContain('Organization');
  });

  it('handles empty script tag without crashing', () => {
    const html = `<html><head>
      <script type="application/ld+json"></script>
    </head><body></body></html>`;
    expect(extractJsonLd(html)).toEqual([]);
  });

  it('handles whitespace-only script tag', () => {
    const html = `<html><head>
      <script type="application/ld+json">   </script>
    </head><body></body></html>`;
    expect(extractJsonLd(html)).toEqual([]);
  });

  it('extracts product JSON-LD with nested offers', () => {
    const results = extractJsonLd(productHtml);
    expect(results).toHaveLength(1);
    expect(results[0]['@type']).toBe('Product');
    const offers = results[0].offers as Record<string, unknown>;
    expect(offers.price).toBe('29.99');
    expect(offers.priceCurrency).toBe('USD');
  });
});

describe('matchJsonLdToSchema', () => {
  it('maps JSON-LD fields to schema properties', () => {
    const jsonLdBlocks = [
      { '@type': 'Article', headline: 'Test Title', datePublished: '2026-01-01' },
    ];
    const schema = {
      type: 'object',
      properties: {
        headline: { type: 'string' },
        datePublished: { type: 'string' },
      },
    };
    const result = matchJsonLdToSchema(jsonLdBlocks, schema);
    expect(result.headline).toBe('Test Title');
    expect(result.datePublished).toBe('2026-01-01');
  });

  it('extracts nested JSON-LD values by flattened field name', () => {
    const jsonLdBlocks = [
      {
        '@type': 'Product',
        name: 'Widget',
        offers: { '@type': 'Offer', price: '19.99' },
      },
    ];
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'string' },
      },
    };
    const result = matchJsonLdToSchema(jsonLdBlocks, schema);
    expect(result.name).toBe('Widget');
    expect(result.price).toBe('19.99');
  });

  it('returns empty object when no fields match', () => {
    const jsonLdBlocks = [{ '@type': 'Article', headline: 'Test' }];
    const schema = {
      type: 'object',
      properties: {
        nonexistent: { type: 'string' },
      },
    };
    const result = matchJsonLdToSchema(jsonLdBlocks, schema);
    expect(result).toEqual({});
  });

  it('returns empty object for empty JSON-LD array', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    expect(matchJsonLdToSchema([], schema)).toEqual({});
  });

  it('handles schema with no properties gracefully', () => {
    const jsonLdBlocks = [{ '@type': 'Article' }];
    expect(matchJsonLdToSchema(jsonLdBlocks, { type: 'object' })).toEqual({});
  });
});
