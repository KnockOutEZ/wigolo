import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fenceFetchData, fenceCrawlData, fenceExtractData, fenceFindSimilarData, fenceSearchData } from '../../../src/server/content-fence.js';
import type { FetchOutput, CrawlOutput, ExtractOutput, FindSimilarOutput, SearchOutput } from '../../../src/types.js';

const BEGIN = '[[BEGIN UNTRUSTED DATA]]';

describe('content-fence — D7/A flat-markdown content-tool returns fenced at the agent envelope', () => {
  it('PIN-A1: fetch markdown is fenced; the url stays RAW', () => {
    // D7: raw page markdown returned to the agent is page-derived UNTRUSTED DATA. value-flip RED: today the
    // fn is identity → markdown raw. MUT: drop the wrap → raw → RED.
    const data = { url: 'https://x.example/p', title: 'T', markdown: 'BODY-INJECT IGNORE PREVIOUS' } as FetchOutput;
    const out = fenceFetchData(data);
    expect(out.markdown).toContain(BEGIN);
    expect(out.markdown).toContain('BODY-INJECT IGNORE PREVIOUS'); // original body preserved inside the fence
    expect(out.url).toBe('https://x.example/p'); // operational field stays RAW
  });

  it('PIN-A2: crawl per-page markdown is fenced; the page url stays RAW', () => {
    // MUT: drop the wrap → raw → RED.
    const data = { pages: [{ url: 'https://x.example/a', title: 'A', markdown: 'PAGE-A BODY' }], total_found: 1, crawled: 1 } as unknown as CrawlOutput;
    const out = fenceCrawlData(data) as CrawlOutput;
    expect(out.pages[0].markdown).toContain(BEGIN);
    expect(out.pages[0].markdown).toContain('PAGE-A BODY');
    expect(out.pages[0].url).toBe('https://x.example/a'); // operational stays RAW
  });

  it('PIN-A3: extract flat-string data is fenced', () => {
    // MUT: drop the wrap → raw → RED.
    const data = { mode: 'selector', data: 'EXTRACTED TEXT' } as ExtractOutput;
    const out = fenceExtractData(data);
    expect(typeof out.data === 'string' && out.data.includes(BEGIN)).toBe(true);
    expect(typeof out.data === 'string' && out.data.includes('EXTRACTED TEXT')).toBe(true);
  });

  it('PIN-A4 (WRAP-ONCE by placement): content-fence is imported ONLY by the agent dispatch, never by synthesize / agent-pipeline / the domain producers', () => {
    // 0b: research/agent gather via the domain producers and fence at synthesis (R1); the dispatch fence is a
    // DISJOINT agent-only path, so no value is fenced by both. This pin keeps that disjoint by placement.
    // MUT: import content-fence into a shared producer (e.g. fetch/router.ts) so synthesize's input is
    // pre-fenced then re-wrapped → nested [[BEGIN[[BEGIN → RED.
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const FORBIDDEN = ['src/research/synthesize.ts', 'src/research/pipeline.ts', 'src/agent/pipeline.ts', 'src/fetch/router.ts'];
    for (const rel of FORBIDDEN) {
      const src = readFileSync(root + rel, 'utf8');
      expect(src, `${rel} must not import the agent-dispatch content-fence (would double-fence synthesize input)`).not.toMatch(/content-fence/);
    }
  });
});

describe('content-fence — D7/B structured returns: per-content-field fenced, operational fields RAW', () => {
  it('PIN-B1: extract-structured table cells are fenced', () => {
    // MUT: drop the structured-array fencing → cells raw → RED.
    const data = { mode: 'tables', data: [{ caption: 'C', headers: ['H1'], rows: [{ H1: 'CELL-INJECT' }] }] } as unknown as ExtractOutput;
    const out = fenceExtractData(data);
    const json = JSON.stringify(out.data);
    expect(json).toContain(BEGIN);
    expect(json).toContain('CELL-INJECT'); // original cell preserved inside the fence
  });

  it('PIN-B2 (operational RAW, critical): find_similar + search url stays RAW — never fenced', () => {
    // url is an action target; fencing it would break the agent acting on it. MUT: wrap the url field →
    // url contains [[BEGIN → RED.
    const fs = fenceFindSimilarData({ results: [{ url: 'https://a.example/p', title: 'T', markdown: 'B', relevance_score: 1, source: 'cache', trusted: false, match_signals: {} }] } as unknown as FindSimilarOutput);
    expect(fs.results[0].url).toBe('https://a.example/p');
    const se = fenceSearchData({ results: [{ title: 'T', url: 'https://b.example/p', snippet: 'S', relevance_score: 1 }] } as unknown as SearchOutput);
    expect(se.results[0].url).toBe('https://b.example/p');
  });

  it('PIN-B3: find_similar content (title/markdown) fenced; url + score stay raw', () => {
    // MUT: drop the content wrap → raw → RED.
    const data = { results: [{ url: 'https://a.example/p', title: 'TITLE-INJECT', markdown: 'BODY-INJECT', relevance_score: 0.9, source: 'search', trusted: false, match_signals: {} }] } as unknown as FindSimilarOutput;
    const out = fenceFindSimilarData(data);
    expect(out.results[0].title).toContain(BEGIN);
    expect(out.results[0].markdown).toContain(BEGIN);
    expect(out.results[0].url).toBe('https://a.example/p'); // operational RAW
    expect(out.results[0].relevance_score).toBe(0.9); // operational RAW
  });

  it('PIN-B4: search content (title/snippet) fenced; url stays raw', () => {
    // MUT: drop the content wrap → raw → RED. (If SEARCH were overridden to OUT this pin would be dropped.)
    const data = { results: [{ title: 'TITLE-X', url: 'https://b.example/p', snippet: 'SNIP-X', relevance_score: 0.5 }] } as unknown as SearchOutput;
    const out = fenceSearchData(data);
    expect(out.results[0].title).toContain(BEGIN);
    expect(out.results[0].snippet).toContain(BEGIN);
    expect(out.results[0].url).toBe('https://b.example/p'); // operational RAW
  });

  it('PIN-B5 (PARSE-INTACT / shape): per-field wrapping preserves the array shape — length + keys intact', () => {
    // MUT: body-wrap the whole results JSON instead of per-field → not an array of keyed objects → RED.
    const data = { results: [
      { url: 'https://a/1', title: 'T1', markdown: 'M1', relevance_score: 1, source: 'cache', trusted: false, match_signals: {} },
      { url: 'https://a/2', title: 'T2', markdown: 'M2', relevance_score: 1, source: 'cache', trusted: false, match_signals: {} },
    ] } as unknown as FindSimilarOutput;
    const out = fenceFindSimilarData(data);
    expect(Array.isArray(out.results)).toBe(true);
    expect(out.results).toHaveLength(2);
    for (const r of out.results) {
      expect(r).toHaveProperty('url');
      expect(r).toHaveProperty('title');
      expect(r).toHaveProperty('markdown');
      expect(r).toHaveProperty('relevance_score');
    }
  });
});
