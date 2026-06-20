import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from '../../../src/server/tool-schemas.js';

describe('TOOL_SCHEMAS export', () => {
  it('exports a schema for every supported tool', () => {
    const expected = [
      'fetch', 'search', 'crawl', 'cache', 'extract', 'find_similar', 'research', 'agent',
      'diff', 'watch', 'studio_observe', 'studio_act', 'studio_marks', 'studio_capture',
    ] as const;
    for (const name of expected) {
      expect(TOOL_SCHEMAS[name]).toBeDefined();
      expect(TOOL_SCHEMAS[name].type).toBe('object');
      expect(TOOL_SCHEMAS[name].properties).toBeDefined();
    }
    // Not vacuous: the list IS the full set — a tool added without a schema (or a schema
    // without an entry here) fails this, instead of silently passing the stale subset.
    expect(Object.keys(TOOL_SCHEMAS).length).toBe(expected.length);
  });
});
