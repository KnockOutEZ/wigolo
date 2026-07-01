import { describe, it, expect } from 'vitest';
import type { SearchInput, SearchOutput } from '../../../src/types.js';
import { buildSearchContentBlocks } from '../../../src/server/search-response.js';

// format=stream_answer leaked the synthesis
// warning out as a raw `[wigolo notice] ...` text block alongside the JSON
// payload. Callers expecting a structured envelope (e.g. to pattern-match
// `notice` vs `stream`) could not parse it. The MCP shape stays a text
// content block, but the JSON inside is now `{stream, notice, ...rest}`.

function makeSearchOutput(overrides: Partial<SearchOutput> = {}): SearchOutput {
  return {
    query: 'test',
    results: [],
    engines_used: ['mock'],
    cached: false,
    answer: 'synthesized answer',
    warning: 'Client does not support MCP sampling; returning heuristic key-point summary',
    streaming: true,
    ...overrides,
  } as SearchOutput;
}

describe('buildSearchContentBlocks', () => {
  it('default format: prefixes warning as [wigolo notice] block then emits JSON payload', () => {
    const input: SearchInput = { query: 'test' };
    const data = makeSearchOutput({ streaming: undefined, answer: undefined });

    const blocks = buildSearchContentBlocks(input, data);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toMatch(/^\[wigolo notice\] /);
    const payload = JSON.parse(blocks[1].text);
    expect(payload.query).toBe('test');
    expect(payload.warning).toBeDefined();
    expect(payload.stream).toBeUndefined();
    expect(payload.notice).toBeUndefined();
  });

  it('default format with no warning: emits a single JSON block', () => {
    const input: SearchInput = { query: 'test' };
    const data = makeSearchOutput({ warning: undefined, answer: undefined, streaming: undefined });

    const blocks = buildSearchContentBlocks(input, data);

    expect(blocks).toHaveLength(1);
    expect(() => JSON.parse(blocks[0].text)).not.toThrow();
  });

  it('format=stream_answer: emits a single JSON block with {stream, notice, ...rest} envelope', () => {
    const input: SearchInput = { query: 'test', format: 'stream_answer' };
    const data = makeSearchOutput();

    const blocks = buildSearchContentBlocks(input, data);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).not.toMatch(/^\[wigolo notice\]/);

    const payload = JSON.parse(blocks[0].text);
    expect(payload.stream).toBe('synthesized answer');
    expect(payload.notice).toBe(data.warning);
    // The rest of the SearchOutput remains accessible (results, citations, etc.).
    expect(payload.query).toBe('test');
    expect(payload.results).toEqual([]);
    // `warning` is replaced by the structured `notice` field — don't carry both.
    expect(payload.warning).toBeUndefined();
  });

  it('format=stream_answer without warning: notice field is omitted but envelope still has stream', () => {
    const input: SearchInput = { query: 'test', format: 'stream_answer' };
    const data = makeSearchOutput({ warning: undefined });

    const blocks = buildSearchContentBlocks(input, data);
    const payload = JSON.parse(blocks[0].text);

    expect(payload.stream).toBe('synthesized answer');
    expect('notice' in payload).toBe(false);
  });

  it('format=stream_answer with no answer: stream field is an empty string, not undefined', () => {
    const input: SearchInput = { query: 'test', format: 'stream_answer' };
    const data = makeSearchOutput({ answer: undefined });

    const blocks = buildSearchContentBlocks(input, data);
    const payload = JSON.parse(blocks[0].text);

    expect(payload.stream).toBe('');
  });
});
