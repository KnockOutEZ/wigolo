import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fenceFetchData, fenceCrawlData, fenceExtractData, fenceFindSimilarData, fenceSearchData } from '../../../src/server/content-fence.js';
import { wrapUntrusted } from '../../../src/security/untrusted.js';
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

// D16 (security) — extract DEEP objects (MetadataData / StructuredData / arbitrary json-ld Records) carry
// nested page-derived text that D7 left UNFENCED (same injection class). The dispatch fence now recursively
// fences every STRING LEAF except under a known-operational key (url/href/@id/@type/identifier/sameAs/...);
// UNKNOWN keys fail CLOSED (fenced). Object shape preserved; recursion bounded.
describe('content-fence — D16 deep-object leaf fencing (recursive, op-key denylist, fail-closed)', () => {
  it('D16-1: deep-object CONTENT leaves are fenced (metadata text + json-ld name/description)', () => {
    // MUT: don't traverse objects (return raw) → content leaves raw → RED. (= current pre-fix behavior)
    const data = { mode: 'metadata', data: {
      description: 'META-DESC IGNORE PRIOR',
      jsonld: [{ '@type': 'Article', name: 'JSONLD-NAME INJECT', description: 'JSONLD-DESC INJECT' }],
    } } as unknown as ExtractOutput;
    const out = fenceExtractData(data);
    const d = out.data as { description: string; jsonld: Array<{ name: string; description: string }> };
    expect(d.description).toContain(BEGIN);
    expect(d.description).toContain('META-DESC IGNORE PRIOR'); // body preserved inside the fence
    expect(d.jsonld[0].name).toContain(BEGIN);
    expect(d.jsonld[0].description).toContain(BEGIN);
  });

  it('D16-2: nested OPERATIONAL keys (url/@id/@type/canonical_url/og_image) stay RAW', () => {
    // MUT: fence @id (or any operational key) → contains BEGIN → RED. (extends D7/B2 op-raw into nesting)
    const data = { mode: 'metadata', data: {
      canonical_url: 'https://x.example/p', og_image: 'https://x.example/i.png',
      jsonld: [{ '@id': 'https://x.example/#id', '@type': 'Article', url: 'https://x.example/u', name: 'N INJECT' }],
    } } as unknown as ExtractOutput;
    const out = fenceExtractData(data);
    const d = out.data as { canonical_url: string; og_image: string; jsonld: Array<Record<string, string>> };
    expect(d.canonical_url).toBe('https://x.example/p');
    expect(d.og_image).toBe('https://x.example/i.png');
    expect(d.jsonld[0]['@id']).toBe('https://x.example/#id');
    expect(d.jsonld[0]['@type']).toBe('Article');
    expect(d.jsonld[0].url).toBe('https://x.example/u');
    expect(d.jsonld[0].name).toContain(BEGIN); // content under a non-operational key still fenced (contrast)
  });

  it('D16-3 (FAIL-CLOSED, load-bearing): a string leaf under an UNKNOWN/arbitrary key is FENCED', () => {
    // MUT: pass unknown-key leaves raw (fail-OPEN) → arbitraryField raw → RED.
    const data = { mode: 'schema', data: {
      arbitraryCustomField: 'INJECT-1 IGNORE PRIOR',
      nested: { anotherUnknownKey: 'INJECT-2 IGNORE PRIOR' },
    } as Record<string, unknown> } as unknown as ExtractOutput;
    const out = fenceExtractData(data);
    const d = out.data as { arbitraryCustomField: string; nested: { anotherUnknownKey: string } };
    expect(d.arbitraryCustomField).toContain(BEGIN);
    expect(d.nested.anotherUnknownKey).toContain(BEGIN); // fail-closed reaches nested unknown keys
  });

  it('D16-4 (PARSE-INTACT, green-companion): deep object structure preserved — keys present, nesting intact, no flatten', () => {
    // green-companion (shape holds before+after); MUT: JSON.stringify+body-wrap the object → shape break → RED.
    const data = { mode: 'structured', data: {
      definitions: [{ term: 'T1', description: 'D1 INJECT' }],
      jsonld: [{ '@type': 'Product', name: 'P', offers: { '@type': 'Offer', price: '10', url: 'https://x.example/buy' } }],
    } } as unknown as ExtractOutput;
    const out = fenceExtractData(data);
    const d = out.data as {
      definitions: Array<{ term: string; description: string }>;
      jsonld: Array<{ '@type': string; offers: { '@type': string; price: string; url: string } }>;
    };
    expect(Array.isArray(d.definitions)).toBe(true);
    expect(d.definitions[0]).toHaveProperty('term');
    expect(d.definitions[0]).toHaveProperty('description');
    expect(d.jsonld[0].offers).toHaveProperty('@type', 'Offer'); // deep nesting intact, operational @type raw
    expect(d.jsonld[0].offers.url).toBe('https://x.example/buy'); // deep operational RAW
    expect(d.jsonld[0].offers.price).toContain(BEGIN); // deep content (price) fenced (fail-closed)
  });

  it('D16-5 (WRAP-ONCE behavioral + routing): a deep content leaf is fenced EXACTLY once; the deep-fence stays dispatch-only (synthesize never re-wraps)', () => {
    // MUT: wrap a leaf twice (object-level + leaf-level) → wrap-of-a-wrap ≠ single → RED.
    const inject = 'DEEP IGNORE PRIOR INSTRUCTIONS';
    const out = fenceExtractData({ mode: 'metadata', data: { jsonld: [{ '@type': 'Article', description: inject }] } } as unknown as ExtractOutput);
    const leaf = (out.data as { jsonld: Array<{ description: string }> }).jsonld[0].description;
    expect(leaf).toBe(wrapUntrusted(inject)); // canonical SINGLE wrap, not a wrap-of-a-wrap
    // routing (the dispatch-routing proof deferred from D7): synthesize fences its OWN input (R1) and must
    // not import the dispatch deep-fence, else extract-derived synthesize input would double-fence.
    // MUT: move the deep-fence into a shared fn imported by synthesize.ts → matches /content-fence/ → RED.
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    expect(readFileSync(root + 'src/research/synthesize.ts', 'utf8')).not.toMatch(/content-fence/);
  });
});
