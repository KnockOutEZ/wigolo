import { describe, it, expect } from 'vitest';
import type { SearchInput, SearchOutput } from '../../../src/types.js';
import { buildSearchContentBlocks } from '../../../src/server/search-response.js';
import { closedRegions, regionBody } from '../../helpers/untrusted-fence.js';

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
    // B2: `answer` is page-derived on the keyless producers, so it is fenced before it becomes
    // `stream`. The envelope SHAPE is what this pin is about; containment is pinned at SEAM-19/20.
    expect(closedRegions(payload.stream)).toBe(1);
    expect(regionBody(payload.stream)).toBe('synthesized answer');
    // F5: `notice` IS the fenced warning now, and that is a THIRD sink for the same bytes rather
    // than a cosmetic change. This function reads `data.warning` AFTER fenceSearchData, so fencing
    // the field closed the JSON `warning`, this stream_answer `notice`, and (partially) the bare
    // `[wigolo notice]` block in one edit. The old line asserted the raw value on the premise that
    // the warning is "wigolo-authored"; answer-synthesis.ts interpolates a thrown LLM provider's
    // message into it, so that premise was false and this envelope was carrying the bytes too.
    expect(closedRegions(payload.notice)).toBe(1);
    // `data` is the RAW output this function was handed, so its warning is bare prose — the region
    // body must reproduce it byte for byte. Containment is not redaction.
    expect(regionBody(payload.notice)).toBe(data.warning);
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

    expect(regionBody(payload.stream)).toBe('synthesized answer'); // B2: fenced, body intact
    expect('notice' in payload).toBe(false);
  });

  it('format=stream_answer with no answer: stream field is an empty string, not undefined', () => {
    const input: SearchInput = { query: 'test', format: 'stream_answer' };
    const data = makeSearchOutput({ answer: undefined });

    const blocks = buildSearchContentBlocks(input, data);
    const payload = JSON.parse(blocks[0].text);

    expect(payload.stream).toBe('');
  });

  // The filter-induced-zero cause has to reach the caller's envelope. It
  // originally existed only as engine telemetry (dedup_kept: 0), which is
  // exactly why the misreport went unnoticed -- so assert it survives the
  // content fence into the payload the caller actually parses.
  it('carries the domain_filter cause through to the emitted payload', () => {
    const input: SearchInput = { query: 'test', include_domains: ['example.com'] };
    const data = makeSearchOutput({
      answer: undefined,
      streaming: undefined,
      warning: 'no results after domain scoping',
      domain_filter: {
        include_domains: ['example.com'],
        candidates: 18,
        matched: 0,
        dropped: 18,
      },
    });

    const blocks = buildSearchContentBlocks(input, data);
    const payload = JSON.parse(blocks[blocks.length - 1].text);

    expect(payload.domain_filter).toEqual({
      include_domains: ['example.com'],
      candidates: 18,
      matched: 0,
      dropped: 18,
    });
  });
});
