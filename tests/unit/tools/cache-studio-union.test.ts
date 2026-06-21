import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VectorSearchResult } from '../../../src/providers/vector-store.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

/**
 * 4d slice-3 — surface studio_artifacts through the cache tool (FTS + hybrid).
 *
 * Only the embed/vector providers are mocked (the cache tool's hybrid path);
 * the db, store.js (real searchCacheFiltered / ftsSearchRanked /
 * getCachedContentByNormalizedUrl) and the studio reads stay REAL, so the studio
 * FTS + by-id hydration run against a real db. FTS-mode tests don't touch the
 * providers; hybrid-mode tests drive the mocked vector store.
 */

const vecState: { size: number; results: VectorSearchResult[] } = { size: 0, results: [] };

vi.mock('../../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(async () => ({
    modelId: 'test', dim: 4, embed: vi.fn(async () => [new Float32Array([1, 0, 0, 0])]),
  })),
}));
vi.mock('../../../src/providers/vector-store.js', () => ({
  getVectorStore: vi.fn(async () => ({
    upsert: vi.fn(), delete: vi.fn(),
    size: vi.fn(async () => vecState.size),
    search: vi.fn(async () => vecState.results),
  })),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { captureFromPage, captureHumanNote, curateArtifact } from '../../../src/studio/capture/artifacts.js';
import { cacheContent } from '../../../src/cache/store.js';
import { handleCache } from '../../../src/tools/cache.js';

const CLIP_MD = 'Wigolo studio capture pipeline architecture and dedup notes — the knowledge moat layer.';
const QUERY = 'wigolo studio capture pipeline moat';

function seedUrlCache(url: string, title: string, markdown: string): void {
  const raw: RawFetchResult = {
    url, finalUrl: url, html: `<html><body><h1>${title}</h1><p>${markdown}</p></body></html>`,
    contentType: 'text/html', statusCode: 200, method: 'http', headers: {},
  };
  const extraction: ExtractionResult = { title, markdown, metadata: {}, links: [], images: [], extractor: 'defuddle' };
  cacheContent(raw, extraction);
}

function vec(url: string, score: number): VectorSearchResult {
  return { id: url, score, metadata: { url, contentHash: 'h', modelId: 'test' } };
}

function captureClip(sessionId: string): number {
  return captureFromPage(
    { type: 'clip', sessionId, url: 'https://x.example.com/p', title: 'Capture Notes', markdown: CLIP_MD },
    { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
  ).id;
}

// C5 PIN-5: a url-less qa pair. Written via captureFromPage (the primitive the studio_capture
// dispatch/handler calls — the dispatch→handler→captureFromPage write chain is pinned separately
// at the dispatch seam) so this file stays a pure surfacing test. The answer carries the QUERY
// terms so it matches the studio FTS index; surfacing is type-agnostic so a qa hydrates like a clip.
function captureQa(sessionId: string): number {
  return captureFromPage(
    { type: 'qa', sessionId, question: 'How does the capture pipeline work?', answer: CLIP_MD },
    { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
  ).id;
}

describe('cache tool — captured studio artifact (4d slice-3)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    vi.clearAllMocks();
    vecState.size = 0;
    vecState.results = [];
  });
  afterEach(() => {
    closeDatabase();
  });

  describe('FTS mode', () => {
    it('surfaces a term-matching studio clip, hydrated + source=studio + trusted:false', async () => {
      const studioKey = `studio://clip|${captureClip('sess-c')}`;
      const out = await handleCache({ query: QUERY });
      expect(out.error).toBeUndefined();
      const results = out.results ?? [];
      const hit = results.find((r) => r.url === studioKey);
      expect(
        hit,
        `expected a cache result for ${studioKey}; got ${JSON.stringify(results.map((r) => r.url))}`,
      ).toBeDefined();
      expect(hit!.markdown).toBe(CLIP_MD);
      const source: string = hit!.source;
      expect(source).toBe('studio');
      expect(hit!.trusted).toBe(false);
    });

    it('a curated studio clip stays trusted:false (tracks content_trusted, NOT curation)', async () => {
      const id = captureClip('sess-cur');
      curateArtifact(id, { db: getDatabase() }); // curated_by_human = 1; content_trusted untouched
      const out = await handleCache({ query: QUERY });
      const hit = (out.results ?? []).find((r) => r.url === `studio://clip|${id}`);
      expect(hit?.trusted).toBe(false);
    });

    it('a human-authored studio note surfaces trusted:true', async () => {
      const note = captureHumanNote(
        { sessionId: 'sess-note', text: `wigolo studio capture pipeline moat — a human note safe as instructions.` },
        { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
      );
      const out = await handleCache({ query: QUERY });
      const hit = (out.results ?? []).find((r) => r.url === `studio://note|${note.id}`);
      expect(hit?.source).toBe('studio');
      expect(hit?.trusted).toBe(true);
    });

    it('surfaces a captured qa pair (url-less) via FTS, hydrated + source=studio + trusted:false, keyed studio://qa|<id> (C5 PIN-5)', async () => {
      const qaKey = `studio://qa|${captureQa('sess-qa')}`;
      const out = await handleCache({ query: QUERY });
      expect(out.error).toBeUndefined();
      const results = out.results ?? [];
      const hit = results.find((r) => r.url === qaKey);
      expect(hit, `expected a cache result for ${qaKey}; got ${JSON.stringify(results.map((r) => r.url))}`).toBeDefined();
      expect(hit!.markdown).toBe(CLIP_MD); // the qa answer, hydrated by-id (type-agnostic read)
      expect(hit!.source).toBe('studio');
      expect(hit!.trusted).toBe(false); // a qa answer is page/agent-derived data, never instructions
    });

    it('keeps studio + url_cache identities distinct when they share an integer rowid', async () => {
      seedUrlCache('https://realpage.example.com/moat', 'Moat', 'wigolo studio capture pipeline moat overview.');
      const studioKey = `studio://clip|${captureClip('sess-id')}`;
      const cacheRow = getDatabase().prepare('SELECT id FROM url_cache LIMIT 1').get() as { id: number };
      const studioRow = getDatabase().prepare('SELECT id FROM studio_artifacts LIMIT 1').get() as { id: number };
      expect(cacheRow.id).toBe(studioRow.id); // both share integer rowid

      const out = await handleCache({ query: QUERY, limit: 10 });
      const results = out.results ?? [];
      const studioHit = results.find((r) => r.source === 'studio');
      const cacheHit = results.find((r) => r.source === 'cache');
      expect(studioHit?.url).toBe(studioKey);
      expect(cacheHit?.url).toBe('https://realpage.example.com/moat');
      expect(studioHit?.url).not.toBe(cacheHit?.url);
    });
  });

  describe('hybrid mode', () => {
    it('surfaces a studio clip via the vector side + a co-resident url_cache hit ALSO surfaces', async () => {
      seedUrlCache('https://realpage.example.com/doc', 'Doc', 'A fetched page body about revenue.');
      const studioKey = `studio://clip|${captureClip('sess-h')}`;
      vecState.size = 2;
      vecState.results = [vec(studioKey, 0.9), vec('https://realpage.example.com/doc', 0.85)];

      const out = await handleCache({ query: QUERY, mode: 'hybrid', limit: 10 });
      expect(out.error).toBeUndefined();
      const results = out.results ?? [];
      const studioHit = results.find((r) => r.url === studioKey);
      expect(studioHit, `studio clip should surface via hybrid; got ${JSON.stringify(results.map((r) => r.url))}`).toBeDefined();
      expect(studioHit!.markdown).toBe(CLIP_MD);
      expect(studioHit!.source).toBe('studio');
      expect(studioHit!.trusted).toBe(false);
      // collateral: the co-resident url_cache hit is NOT suppressed.
      expect(results.some((r) => r.url === 'https://realpage.example.com/doc')).toBe(true);
    });

    it('skips an orphan studio key (no row) — absent, and a co-resident url_cache hit survives', async () => {
      seedUrlCache('https://realpage.example.com/keep', 'Keep', 'A fetched page that must survive.');
      const orphanKey = 'studio://clip|99999';
      vecState.size = 2;
      vecState.results = [vec(orphanKey, 0.9), vec('https://realpage.example.com/keep', 0.85)];

      const out = await handleCache({ query: QUERY, mode: 'hybrid', limit: 10 });
      const results = out.results ?? [];
      expect(results.find((r) => r.url === orphanKey)).toBeUndefined();
      expect(results.some((r) => r.url === 'https://realpage.example.com/keep')).toBe(true);
    });

    it('dedups a clip arriving via BOTH hybrid sides (studio-FTS + vector) to ONE result', async () => {
      const studioKey = `studio://clip|${captureClip('sess-dedup')}`;
      // QUERY matches CLIP_MD (studio FTS side) AND the key is in the vector window.
      vecState.size = 1;
      vecState.results = [vec(studioKey, 0.99)];

      const out = await handleCache({ query: QUERY, mode: 'hybrid', limit: 10 });
      const results = out.results ?? [];
      const studioResults = results.filter((r) => r.source === 'studio');
      expect(studioResults).toHaveLength(1); // fused once, not one-per-side
      expect(studioResults[0].url).toBe(studioKey);
    });

    it('surfaces a captured qa pair via the hybrid vector side, keyed studio://qa|<id> + trusted:false (C5 PIN-5)', async () => {
      const qaKey = `studio://qa|${captureQa('sess-qa-h')}`;
      vecState.size = 1;
      vecState.results = [vec(qaKey, 0.95)];
      const out = await handleCache({ query: QUERY, mode: 'hybrid', limit: 10 });
      expect(out.error).toBeUndefined();
      const hit = (out.results ?? []).find((r) => r.url === qaKey);
      expect(hit, `qa should surface via hybrid; got ${JSON.stringify((out.results ?? []).map((r) => r.url))}`).toBeDefined();
      expect(hit!.markdown).toBe(CLIP_MD);
      expect(hit!.source).toBe('studio');
      expect(hit!.trusted).toBe(false);
    });
  });
});
