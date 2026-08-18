import { describe, it, expect } from 'vitest';
import { createKeylessDirectEngines } from '../../../src/search/direct-engines.js';

describe('createKeylessDirectEngines', () => {
  it('returns the same bing + duckduckgo seed the MCP server and shell use', () => {
    const engines = createKeylessDirectEngines();
    expect(engines.map((e) => e.name)).toEqual(['bing', 'duckduckgo']);
  });

  it('returns a fresh pair so callers can mutate their list independently', () => {
    const a = createKeylessDirectEngines();
    const b = createKeylessDirectEngines();
    expect(a[0]).not.toBe(b[0]);
    a.pop();
    expect(b).toHaveLength(2);
  });
});
