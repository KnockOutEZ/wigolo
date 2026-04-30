import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from '../../../src/server/tool-schemas.js';

describe('TOOL_SCHEMAS export', () => {
  it('exports a schema for every supported tool', () => {
    const expected = ['fetch', 'search', 'crawl', 'cache', 'extract', 'find_similar', 'research', 'agent'] as const;
    for (const name of expected) {
      expect(TOOL_SCHEMAS[name]).toBeDefined();
      expect(TOOL_SCHEMAS[name].type).toBe('object');
      expect(TOOL_SCHEMAS[name].properties).toBeDefined();
    }
  });
});
