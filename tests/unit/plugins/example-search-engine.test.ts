import { describe, it, expect } from 'vitest';
import { validateSearchEngine } from '../../../src/plugins/validate.js';
import { searchEngine } from '../../../examples/plugin-search-engine/index.mjs';

describe('plugin search engine example', () => {
  it('exports a valid SearchEngine shape', () => {
    expect(validateSearchEngine(searchEngine)).toBe(true);
  });

  it('returns a predictable example result', async () => {
    const results = await searchEngine.search('widgets');
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain('widgets');
    expect(results[0].engine).toBe('example-search-engine');
  });
});
