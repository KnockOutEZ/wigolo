import { describe, it, expect } from 'vitest';
import { extractNamedEntities } from '../../../src/research/entity-extractor.js';

describe('extractNamedEntities', () => {
  it('extracts ALL_CAPS acronyms and CamelCase proper nouns from a tri-protocol question', () => {
    const entities = extractNamedEntities(
      'tradeoffs between MCP, OpenAPI tool schemas, and A2A for agent interop in 2026',
    );
    expect(entities).toEqual(expect.arrayContaining(['MCP', 'OpenAPI', 'A2A']));
    expect(entities).toHaveLength(3);
  });

  it('extracts quoted strings as entities', () => {
    const entities = extractNamedEntities('compare "Server Actions" and "React Server Components" stability');
    expect(entities).toEqual(expect.arrayContaining(['Server Actions', 'React Server Components']));
  });

  it('drops common-noun question words even when sentence-start-capitalized', () => {
    const entities = extractNamedEntities('What are the best vector databases in 2026?');
    expect(entities).toEqual([]);
  });

  it('deduplicates entities case-insensitively keeping first casing', () => {
    const entities = extractNamedEntities('MCP servers and mcp clients; another MCP run');
    expect(entities).toEqual(['MCP']);
  });

  it('returns empty array for purely lowercase or numeric input', () => {
    expect(extractNamedEntities('deep learning trends 2026')).toEqual([]);
    expect(extractNamedEntities('')).toEqual([]);
  });

  it('keeps mixed-case proper nouns with digits (A2A, PG18, S3)', () => {
    const entities = extractNamedEntities('benchmark A2A on PG18 against S3-backed storage');
    expect(entities).toEqual(expect.arrayContaining(['A2A', 'PG18', 'S3']));
  });
});
