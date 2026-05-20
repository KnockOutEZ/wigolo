import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getExtractProvider,
  _resetExtractProviderForTest,
} from '../../src/providers/extract-provider.js';
import { V1Extractor } from '../../src/extraction/v1/extract-provider.js';

const articleFixture = readFileSync(
  join(import.meta.dirname, '../fixtures/extraction/article.html'),
  'utf-8',
);

function recipeFixture(): string {
  const recipe = {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Chocolate Chip Cookies',
    description: 'Classic chewy chocolate chip cookies that everyone loves at home and at parties for sure.',
    totalTime: 'PT30M',
    recipeIngredient: [
      '2 cups flour',
      '1 cup sugar',
      '1 cup chocolate chips',
      '1 stick butter',
      '2 eggs',
    ],
    recipeInstructions: [
      { text: 'Preheat oven to 375 F.' },
      { text: 'Mix dry ingredients.' },
      { text: 'Add wet ingredients and combine.' },
      { text: 'Drop spoonfuls onto baking sheet.' },
      { text: 'Bake for 10-12 minutes.' },
    ],
  };
  return `<html><head><title>Recipe</title>
    <script type="application/ld+json">${JSON.stringify(recipe)}</script>
  </head><body><h1>Recipe page</h1></body></html>`;
}

function productFixture(): string {
  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Acme Widget Pro',
    description: 'A premium widget that solves widget problems quickly. Comes with a guarantee.',
    brand: { '@type': 'Brand', name: 'Acme' },
    offers: { '@type': 'Offer', price: '49.99', priceCurrency: 'USD' },
    sku: 'AW-PRO-001',
  };
  return `<html><head><title>Widget</title>
    <script type="application/ld+json">${JSON.stringify(product)}</script>
  </head><body><h1>Widget</h1></body></html>`;
}

function genericHtml(body: string): string {
  return `<html><head><title>Generic page</title></head><body>${body}</body></html>`;
}

describe('extract pipeline v1 — integration via factory', () => {
  beforeEach(() => {
    _resetExtractProviderForTest();
  });

  afterEach(() => {
    _resetExtractProviderForTest();
  });

  it('factory returns V1Extractor with name=v1', async () => {
    const provider = await getExtractProvider();
    expect(provider).toBeInstanceOf(V1Extractor);
    expect(provider.name).toBe('v1');
  });

  it('extracts a news/article fixture through the routed pipeline', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(
      articleFixture,
      'https://example.com/blog/scrapers',
    );

    expect(result).toBeDefined();
    expect(result.markdown.length).toBeGreaterThan(100);
    expect(['defuddle', 'readability', 'turndown', 'site-specific']).toContain(
      result.extractor,
    );
    // Metadata merged from html meta tags by post-processing.
    expect(result.metadata.description).toContain('TypeScript');
  });

  it('extracts a recipe fixture and emits site-specific markdown', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(recipeFixture(), 'https://example.com/cookies');

    expect(result.title).toBe('Chocolate Chip Cookies');
    expect(result.markdown).toContain('## Ingredients');
    expect(result.markdown).toContain('## Instructions');
    expect(result.extractor).toBe('site-specific');
  });

  it('extracts a product fixture and emits price and brand', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(productFixture(), 'https://example.com/widget');

    expect(result.title).toBe('Acme Widget Pro');
    expect(result.markdown).toContain('**Brand:** Acme');
    expect(result.markdown).toContain('USD 49.99');
    expect(result.extractor).toBe('site-specific');
  });

  it('falls back to defuddle/readability/turndown for a generic page', async () => {
    const provider = await getExtractProvider();
    const html = genericHtml(
      `<article><h1>Some Generic Article</h1>
       <p>${'Here is a long paragraph repeated many times to clear thresholds. '.repeat(20)}</p>
       <p>${'More body content with sufficient length and detail to satisfy extractors. '.repeat(15)}</p>
      </article>`,
    );
    const result = await provider.extract(html, 'https://example.com/random');

    expect(result.markdown.length).toBeGreaterThan(100);
    expect(['defuddle', 'readability', 'turndown', 'site-specific']).toContain(
      result.extractor,
    );
  });

  it('honors maxChars truncation through post-processing', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(
      articleFixture,
      'https://example.com/blog/scrapers',
      { maxChars: 200 },
    );
    expect(result.markdown.length).toBeLessThanOrEqual(200);
  });

  it('extracts links and images via post-processing', async () => {
    const provider = await getExtractProvider();
    const result = await provider.extract(
      articleFixture,
      'https://example.com/blog/scrapers',
    );
    expect(Array.isArray(result.links)).toBe(true);
    expect(Array.isArray(result.images)).toBe(true);
  });
});
