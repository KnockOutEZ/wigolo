import { describe, it, expect } from 'vitest';
import { detectEntityGaps } from '../../../src/research/entity-extractor.js';

describe('detectEntityGaps', () => {
  it('flags entities that no sub-query mentions', () => {
    const gaps = detectEntityGaps(
      'tradeoffs between MCP, OpenAPI tool schemas, and A2A for agent interop in 2026',
      [
        'model context protocol comparison',
        'OpenAPI tool schema overview',
      ],
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toEqual({ entity: 'A2A', reason: 'no sub-query planned' });
  });

  it('returns empty array when every entity is covered by at least one sub-query', () => {
    const gaps = detectEntityGaps(
      'tradeoffs between MCP and OpenAPI in 2026',
      ['MCP architecture tradeoffs', 'OpenAPI tool schema overview'],
    );
    expect(gaps).toEqual([]);
  });

  it('is case-insensitive when matching entities to sub-queries', () => {
    const gaps = detectEntityGaps(
      'compare MCP and OpenAPI',
      ['mcp ecosystem 2026', 'openapi spec'],
    );
    expect(gaps).toEqual([]);
  });

  it('returns empty when no entities present', () => {
    const gaps = detectEntityGaps('deep learning trends', ['deep learning research', 'ml trends']);
    expect(gaps).toEqual([]);
  });
});
