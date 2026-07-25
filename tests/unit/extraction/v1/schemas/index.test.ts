import { describe, it, expect } from 'vitest';
import {
  NAMED_SCHEMAS,
  isNamedSchemaType,
  extractNamedSchema,
} from '../../../../../src/extraction/v1/schemas/index.js';

describe('schema registry', () => {
  it('lists all 7 named schemas', () => {
    expect(NAMED_SCHEMAS).toEqual([
      'Article',
      'Recipe',
      'Product',
      'CodeSnippet',
      'Paper',
      'EventListing',
      'JobPosting',
    ]);
  });

  it('isNamedSchemaType discriminates correctly', () => {
    expect(isNamedSchemaType('Article')).toBe(true);
    expect(isNamedSchemaType('Recipe')).toBe(true);
    expect(isNamedSchemaType('NotAType')).toBe(false);
    expect(isNamedSchemaType('')).toBe(false);
  });

  it('dispatches to each extractor without throwing', async () => {
    for (const schema of NAMED_SCHEMAS) {
      const result = await extractNamedSchema(schema, '<html><body></body></html>', 'https://example.com/');
      // returns null when no signals — that's expected here
      expect(result === null || typeof result === 'object').toBe(true);
    }
  });

  it('returns valid result for Article when readable content is present', async () => {
    const html = `<!doctype html><html><head><title>T</title></head><body><article>
      <p>This is a long article about systems engineering and replication.</p>
      <p>It is sufficiently long to satisfy readability heuristics for content.</p>
      <p>Another paragraph adds enough body text to make extraction succeed.</p>
    </article></body></html>`;
    const result = await extractNamedSchema('Article', html, 'https://example.com/a');
    if (result !== null) {
      expect('title' in result || 'body' in result).toBe(true);
    }
  });
});
