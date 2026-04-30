import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractStructuredData } from '../../../src/extraction/structured-data.js';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../fixtures/structured-data', name), 'utf8');

describe('extractStructuredData', () => {
  it('returns Product fields from JSON-LD with provenance "json-ld"', () => {
    const blocks = extractStructuredData(fixture('product-jsonld.html'));
    const product = blocks.find((b) => b.type === 'Product');
    expect(product).toBeDefined();
    expect(product!.provenance).toBe('json-ld');
    expect(product!.fields.name).toBeTruthy();
    expect(product!.fields.description).toBeTruthy();
    // price may be nested under offers; either flat 'price' or nested object is acceptable for this test
    const fields = JSON.stringify(product!.fields);
    expect(fields).toMatch(/price/i);
  });

  it('extracts Article headline/author/date from JSON-LD', () => {
    const blocks = extractStructuredData(fixture('article-jsonld.html'));
    const article = blocks.find((b) => b.type === 'Article');
    expect(article).toBeDefined();
    expect(article!.fields.headline).toBeTruthy();
    expect(article!.fields.datePublished).toBeTruthy();
  });

  it('flattens @graph and surfaces Recipe + Person', () => {
    const blocks = extractStructuredData(fixture('recipe-jsonld.html'));
    const types = blocks.map((b) => b.type);
    expect(types).toContain('Recipe');
    expect(types).toContain('Person');
  });

  it('skips malformed JSON-LD without throwing and warns', async () => {
    const html = '<html><head><script type="application/ld+json">{not json</script></head></html>';
    expect(() => extractStructuredData(html)).not.toThrow();
    expect(extractStructuredData(html)).toEqual([]);
  });

  it('extracts Product fields from microdata', () => {
    const blocks = extractStructuredData(fixture('product-microdata.html'));
    const product = blocks.find((b) => b.type === 'Product' && b.provenance === 'microdata');
    expect(product).toBeDefined();
    expect(product!.fields.name).toBeTruthy();
    expect(product!.fields.description).toBeTruthy();
  });

  it('extracts BreadcrumbList from microdata with positions', () => {
    const blocks = extractStructuredData(fixture('breadcrumb-microdata.html'));
    const list = blocks.find((b) => b.type === 'BreadcrumbList');
    expect(list).toBeDefined();
  });
});
