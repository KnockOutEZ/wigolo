import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as structuredDataMod from '../../src/extraction/structured-data.js';
import { extractWithSchemaDetailed } from '../../src/extraction/schema.js';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../fixtures/structured-data', name), 'utf8');

describe('schema extraction short-circuits heuristic fallback when structured data covers fields', () => {
  it('uses extractStructuredData and skips heuristic fallback for full coverage', () => {
    const spy = vi.spyOn(structuredDataMod, 'extractStructuredData');

    const html = fixture('product-jsonld.html');
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'string' },
        description: { type: 'string' },
      },
    };

    const result = extractWithSchemaDetailed(html, schema);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.values.name).toBeTruthy();
    expect(result.values.price).toBeTruthy();
    expect(result.values.description).toBeTruthy();
    // All three fields must be sourced from structured data, not heuristics.
    expect(result.provenance.name).toBe('json-ld');
    expect(result.provenance.price).toBe('json-ld');
    expect(result.provenance.description).toBe('json-ld');
    // No heuristic-sourced fields when coverage is complete.
    const sources = Object.values(result.provenance);
    expect(sources.includes('heuristic')).toBe(false);

    spy.mockRestore();
  });

  it('falls through to heuristic only for fields not covered by structured data', () => {
    // JSON-LD provides name + description; schema also asks for `sku` not present in structured data.
    const html = fixture('product-jsonld.html')
      .replace('</body>', '<div class="sku">SKU-12345</div></body>');
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        sku: { type: 'string' },
      },
    };
    const result = extractWithSchemaDetailed(html, schema);
    expect(result.provenance.name).toBe('json-ld');
    expect(result.provenance.description).toBe('json-ld');
    expect(result.provenance.sku).toBe('heuristic');
  });
});
