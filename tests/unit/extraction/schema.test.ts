import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractWithSchema } from '../../../src/extraction/schema.js';

const productHtml = readFileSync(
  join(import.meta.dirname, '../../fixtures/extraction/product-page.html'),
  'utf-8',
);

describe('extractWithSchema', () => {
  // --- Core field matching ---

  it('extracts fields matching schema from product page', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'string' },
        description: { type: 'string' },
      },
    };

    const result = extractWithSchema(productHtml, schema);
    expect(result.name).toBe('Widget Pro');
    expect(result.price).toContain('29.99');
    expect(result.description).toContain('widget');
  });

  it('returns partial results when some fields not found', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        nonexistent_field: { type: 'string' },
      },
    };

    const result = extractWithSchema(productHtml, schema);
    expect(result.name).toBe('Widget Pro');
    expect(result.nonexistent_field).toBeUndefined();
  });

  it('returns empty object for completely unmatched schema', () => {
    const html = '<html><body><p>Hello world</p></body></html>';
    const schema = {
      type: 'object',
      properties: {
        zzz_no_match: { type: 'string' },
        yyy_no_match: { type: 'string' },
      },
    };

    const result = extractWithSchema(html, schema);
    expect(result).toEqual({});
  });

  // --- CSS class matching ---

  it('matches fields by CSS class name containing field name', () => {
    const html = '<div class="product-rating">4.5</div>';
    const schema = {
      type: 'object',
      properties: { rating: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.rating).toBe('4.5');
  });

  it('matches hyphenated class name from underscore field name', () => {
    const html = '<span class="review-count">42 reviews</span>';
    const schema = {
      type: 'object',
      properties: { review_count: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.review_count).toBe('42 reviews');
  });

  // --- ARIA label matching ---

  it('matches fields by aria-label', () => {
    const html = '<span aria-label="price">$19.99</span>';
    const schema = {
      type: 'object',
      properties: { price: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.price).toBe('$19.99');
  });

  it('matches field by aria-label case-insensitively', () => {
    const html = '<div aria-label="Product Name">Super Widget</div>';
    const schema = {
      type: 'object',
      properties: { product_name: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.product_name).toBe('Super Widget');
  });

  // --- ID matching ---

  it('matches fields by element id', () => {
    const html = '<span id="total-price">$49.99</span>';
    const schema = {
      type: 'object',
      properties: { total_price: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.total_price).toBe('$49.99');
  });

  // --- data-* attribute matching ---

  it('matches fields by data attribute value', () => {
    const html = '<div data-sku="WDG-PRO-001">Widget Pro</div>';
    const schema = {
      type: 'object',
      properties: { sku: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.sku).toBe('WDG-PRO-001');
  });

  // --- Microdata (itemprop) matching ---

  it('matches fields by itemprop attribute', () => {
    const html = '<span itemprop="brand">Acme Corp</span>';
    const schema = {
      type: 'object',
      properties: { brand: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.brand).toBe('Acme Corp');
  });

  it('reads itemprop content attribute over text content', () => {
    const html = '<meta itemprop="datePublished" content="2026-04-10">';
    const schema = {
      type: 'object',
      properties: { datePublished: { type: 'string' } },
    };

    const result = extractWithSchema(html, schema);
    expect(result.datePublished).toBe('2026-04-10');
  });

  it('handles nested microdata with itemprop on child elements', () => {
    const html = `
      <div itemscope itemtype="https://schema.org/Product">
        <span itemprop="name">Gadget</span>
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <span itemprop="price" content="15.00">$15.00</span>
        </div>
      </div>
    `;
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'string' },
      },
    };

    const result = extractWithSchema(html, schema);
    expect(result.name).toBe('Gadget');
    expect(result.price).toBe('15.00');
  });

  // --- Array extraction ---

  it('extracts array values from repeated elements', () => {
    const html = `
      <ul class="features">
        <li class="feature">Fast</li>
        <li class="feature">Reliable</li>
        <li class="feature">Cheap</li>
      </ul>
    `;
    const schema = {
      type: 'object',
      properties: {
        features: { type: 'array', items: { type: 'string' } },
      },
    };

    const result = extractWithSchema(html, schema);
    expect(result.features).toEqual(['Fast', 'Reliable', 'Cheap']);
  });

  it('extracts array from container with list items', () => {
    const html = `
      <div class="tags">
        <li>typescript</li>
        <li>javascript</li>
      </div>
    `;
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
      },
    };

    const result = extractWithSchema(html, schema);
    expect(result.tags).toEqual(['typescript', 'javascript']);
  });

  // --- Edge cases ---

  it('returns empty object for empty HTML', () => {
    const result = extractWithSchema('', { type: 'object', properties: {} });
    expect(result).toEqual({});
  });

  it('returns empty object for schema with no properties', () => {
    const result = extractWithSchema('<html><body>content</body></html>', { type: 'object' });
    expect(result).toEqual({});
  });

  it('returns empty object for undefined schema properties', () => {
    const result = extractWithSchema('<html><body>content</body></html>', {
      type: 'object',
      properties: undefined,
    } as any);
    expect(result).toEqual({});
  });

  it('handles HTML with no matching elements for any strategy', () => {
    const html = '<html><body><p>Just a paragraph</p></body></html>';
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'string' },
      },
    };

    const result = extractWithSchema(html, schema);
    expect(result).toEqual({});
  });

  it('prioritizes JSON-LD data over heuristic matching when both available', () => {
    const result = extractWithSchema(productHtml, {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'string' },
      },
    });
    expect(result.name).toBeDefined();
    expect(result.price).toBeDefined();
  });
});
