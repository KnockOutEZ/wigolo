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
});
