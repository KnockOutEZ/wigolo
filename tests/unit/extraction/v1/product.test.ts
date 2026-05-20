import { describe, it, expect } from 'vitest';
import { extractProduct } from '../../../../src/extraction/v1/product.js';

function htmlWithJsonLd(obj: unknown): string {
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body></body></html>`;
}

const FULL_PRODUCT = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Acme Widget Pro',
  description: 'The flagship Acme widget for serious widgeting professionals.',
  brand: { '@type': 'Brand', name: 'Acme' },
  sku: 'AWP-001',
  image: 'https://example.com/img/widget.jpg',
  offers: {
    '@type': 'Offer',
    price: '129.99',
    priceCurrency: 'USD',
  },
  aggregateRating: {
    '@type': 'AggregateRating',
    ratingValue: '4.5',
    reviewCount: '321',
  },
};

describe('extractProduct — JSON-LD path', () => {
  it('builds markdown from a full Product JSON-LD block', async () => {
    const html = htmlWithJsonLd(FULL_PRODUCT);
    const result = await extractProduct(html, 'https://example.com/p');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Acme Widget Pro');
    expect(result!.extractor).toBe('site-specific');
    expect(result!.markdown).toContain('# Acme Widget Pro');
    expect(result!.markdown).toContain('flagship Acme widget');
    expect(result!.markdown).toContain('**Brand:** Acme');
    expect(result!.markdown).toContain('**Price:** USD 129.99');
    expect(result!.markdown).toContain('**Rating:** 4.5 (321 reviews)');
    expect(result!.markdown).toContain('**SKU:** AWP-001');
    expect(result!.metadata.og_image).toBe('https://example.com/img/widget.jpg');
  });

  it('handles brand as a plain string', async () => {
    const html = htmlWithJsonLd({ ...FULL_PRODUCT, brand: 'BrandName' });
    const result = await extractProduct(html, 'https://example.com/p');
    expect(result).not.toBeNull();
    expect(result!.markdown).toContain('**Brand:** BrandName');
  });

  it('handles image as array (first image wins)', async () => {
    const html = htmlWithJsonLd({
      ...FULL_PRODUCT,
      image: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    });
    const result = await extractProduct(html, 'https://example.com/p');
    expect(result).not.toBeNull();
    expect(result!.metadata.og_image).toBe('https://example.com/a.jpg');
  });

  it('handles offers as an array', async () => {
    const html = htmlWithJsonLd({
      ...FULL_PRODUCT,
      offers: [
        { '@type': 'Offer', price: '99.00', priceCurrency: 'EUR' },
        { '@type': 'Offer', price: '120.00', priceCurrency: 'EUR' },
      ],
    });
    const result = await extractProduct(html, 'https://example.com/p');
    expect(result).not.toBeNull();
    expect(result!.markdown).toContain('**Price:** EUR 99.00');
  });

  it('omits optional fields cleanly when absent', async () => {
    const html = htmlWithJsonLd({
      '@type': 'Product',
      name: 'Bare Widget',
      description: 'A widget with absolutely no extra metadata to speak of in this product listing, but enough description text to clear the minimum content length threshold easily.',
    });
    const result = await extractProduct(html, 'https://example.com/p');
    expect(result).not.toBeNull();
    expect(result!.markdown).not.toContain('**Price:**');
    expect(result!.markdown).not.toContain('**Brand:**');
    expect(result!.markdown).not.toContain('**SKU:**');
    expect(result!.markdown).not.toContain('**Rating:**');
  });
});

describe('extractProduct — OpenGraph fallback', () => {
  it('falls back to og:type=product when no JSON-LD product', async () => {
    const html = `<!doctype html><html><head>
      <meta property="og:type" content="product">
      <meta property="og:title" content="OG Widget">
      <meta property="og:description" content="The official OpenGraph widget for fallback testing in our pipeline.">
      <meta property="product:price:amount" content="49.50">
      <meta property="product:price:currency" content="USD">
      <meta property="og:image" content="https://example.com/og.jpg">
    </head><body></body></html>`;
    const result = await extractProduct(html, 'https://example.com/p');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('OG Widget');
    expect(result!.markdown).toContain('# OG Widget');
    expect(result!.markdown).toContain('OpenGraph widget');
    expect(result!.markdown).toContain('**Price:** USD 49.50');
    expect(result!.metadata.og_image).toBe('https://example.com/og.jpg');
  });

  it('also accepts og:product (legacy)', async () => {
    const html = `<!doctype html><html><head>
      <meta property="og:type" content="og:product">
      <meta property="og:title" content="Legacy OG Widget">
      <meta property="og:description" content="Legacy openGraph widget content with enough body to clear the minimum content threshold easily.">
    </head><body></body></html>`;
    const result = await extractProduct(html, 'https://example.com/p');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Legacy OG Widget');
  });

  it('prefers JSON-LD over OG when both are present', async () => {
    const html = `<!doctype html><html><head>
      <meta property="og:type" content="product">
      <meta property="og:title" content="OG Title">
      <script type="application/ld+json">${JSON.stringify(FULL_PRODUCT)}</script>
    </head><body></body></html>`;
    const result = await extractProduct(html, 'https://example.com/p');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Acme Widget Pro');
  });
});

describe('extractProduct — negative cases', () => {
  it('returns null when JSON-LD type is not Product and no OG', async () => {
    const html = htmlWithJsonLd({ '@type': 'Recipe', name: 'Cake' });
    expect(await extractProduct(html, 'https://example.com/p')).toBeNull();
  });

  it('returns null on totally empty HTML', async () => {
    expect(await extractProduct('', 'https://example.com/p')).toBeNull();
  });

  it('does not throw on malformed JSON-LD', async () => {
    const html = `<html><head>
      <script type="application/ld+json">{not valid</script>
    </head><body></body></html>`;
    expect(await extractProduct(html, 'https://example.com/p')).toBeNull();
  });

  it('returns null when markdown is below threshold', async () => {
    const html = htmlWithJsonLd({ '@type': 'Product', name: 'X' });
    expect(await extractProduct(html, 'https://example.com/p')).toBeNull();
  });
});
