import { describe, it, expect } from 'vitest';
import type { FetchInput, FetchOutput } from '../../src/types.js';

describe('types', () => {
  it('FetchInput accepts minimal input', () => {
    const input: FetchInput = { url: 'https://example.com' };
    expect(input.url).toBe('https://example.com');
    expect(input.render_js).toBeUndefined();
  });

  it('FetchOutput has required fields', () => {
    const output: FetchOutput = {
      url: 'https://example.com',
      title: 'Example',
      markdown: '# Example',
      metadata: {},
      links: [],
      images: [],
      cached: false,
    };
    expect(output.title).toBe('Example');
  });
});
