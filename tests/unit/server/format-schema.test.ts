import { describe, it, expect } from 'vitest';
import {
  SEARCH_TOOL_SCHEMA, FETCH_TOOL_SCHEMA, FIND_SIMILAR_TOOL_SCHEMA,
  CRAWL_TOOL_SCHEMA, RESEARCH_TOOL_SCHEMA, AGENT_TOOL_SCHEMA,
} from '../../../src/server/tool-schemas.js';

describe('SEARCH_TOOL_SCHEMA format enum', () => {
  it('no longer lists full/context/highlights', () => {
    const fmt = (SEARCH_TOOL_SCHEMA.properties.format as any).enum as string[];
    expect(fmt).not.toContain('full');
    expect(fmt).not.toContain('context');
    expect(fmt).not.toContain('highlights');
  });
  it('still lists answer + stream_answer', () => {
    const fmt = (SEARCH_TOOL_SCHEMA.properties.format as any).enum as string[];
    expect(fmt).toContain('answer');
    expect(fmt).toContain('stream_answer');
  });
});

describe('all tool schemas declare the new params', () => {
  for (const [name, schema] of [
    ['search', SEARCH_TOOL_SCHEMA],
    ['fetch', FETCH_TOOL_SCHEMA],
    ['find_similar', FIND_SIMILAR_TOOL_SCHEMA],
    ['crawl', CRAWL_TOOL_SCHEMA],
    ['research', RESEARCH_TOOL_SCHEMA],
    ['agent', AGENT_TOOL_SCHEMA],
  ] as const) {
    it(`${name} schema has max_tokens_out, include_full_markdown, citation_format`, () => {
      expect(schema.properties.max_tokens_out).toBeDefined();
      expect(schema.properties.include_full_markdown).toBeDefined();
      expect(schema.properties.citation_format).toBeDefined();
    });
  }
});
