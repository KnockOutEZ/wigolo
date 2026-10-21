import { describe, it, expect } from 'vitest';
import type { SearchInput, SearchOutput } from '../../../src/types.js';
import { buildSearchContentBlocks } from '../../../src/server/search-response.js';

// Search used to leak the synthesis warning out as a raw `[wigolo notice] ...`
// text block alongside the JSON payload. Callers expecting a structured
// payload could not parse it. Both formats now emit a single JSON text block
// with the warning folded in as `notice`; stream_answer is shaped
// `{stream, notice, ...rest}`.

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
  it('default format: folds the warning into the JSON payload as `notice` (single block)', () => {
    // WHY: a leading "[wigolo notice] ..." text block broke callers that
    // JSON.parse the first content block (#651).
    const input: SearchInput = { query: 'test' };
    const data = makeSearchOutput({ streaming: undefined, answer: undefined });

    const blocks = buildSearchContentBlocks(input, data);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).not.toMatch(/^\[wigolo notice\]/);
    const payload = JSON.parse(blocks[0].text);
    expect(payload.query).toBe('test');
    expect(payload.notice).toBe(data.warning);
    expect(payload.warning).toBeUndefined();
    expect(payload.stream).toBeUndefined();
  });

  it('default format: keeps an existing notice alongside the warning', () => {
    const input: SearchInput = { query: 'test' };
    const data = makeSearchOutput({ answer: undefined, streaming: undefined, notice: 'cache miss' });

    const payload = JSON.parse(buildSearchContentBlocks(input, data)[0].text);

    expect(payload.notice).toBe(`cache miss ${data.warning}`);
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
