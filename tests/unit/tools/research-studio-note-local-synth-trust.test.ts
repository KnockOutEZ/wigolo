import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import type { MergedSearchResult } from '../../../src/search/dedup.js';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { captureFromPage, captureHumanNote } from '../../../src/studio/capture/artifacts.js';

/**
 * C3 slice-2 — note trust through the OTHER research citation constructor: the Phase-5b
 * local-LLM synthesis fallback (pipeline.ts:304-315), which is OFF the synthesizeReport
 * path the sibling test covers. Reached when the host LLM did not sample AND a local LLM
 * is configured. We force that branch (isLlm → true; synthesizeLocal returns a fixed
 * citation-index set), so finalCitations come from the local-synthesis constructor — then
 * assert the NOTE citation carries trusted:true (its source content_trusted=1) while the
 * clip stays false.
 *
 * Real db + real cache/store so the note enters via the REAL path (captureHumanNote → FTS
 * → searchStudioArtifactKeys → getStudioArtifactByEmbedKey); read seam is artifacts.ts only
 * (check-gate stays 23). The local-synth citation mirror is a 2-part promote: localSources
 * must CARRY trusted (pipeline.ts:296-298) for the citation build (pipeline.ts:313) to mirror
 * it — this test REDs if EITHER half regresses.
 */

const extractMock = vi.fn();
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({ name: 'v1' as const, extract: extractMock })),
  _resetExtractProviderForTest: vi.fn(),
}));

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({ isAvailable: () => false, embedAsync: vi.fn() }),
  resetEmbeddingService: vi.fn(),
}));

// Force the Phase-5b local-LLM synthesis path: a local LLM IS configured, and
// synthesizeLocal returns a wide citation-index set so EVERY local source (note + clip +
// web) gets a citation from the local-synth constructor. The filter at pipeline.ts:304-306
// drops out-of-range indices, so the effective set is one citation per local source.
vi.mock('../../../src/research/synthesis-local.js', () => ({
  synthesizeLocal: vi.fn(async () => ({
    text: 'local synthesized report',
    citations: Array.from({ length: 24 }, (_unused, i) => i),
  })),
}));
vi.mock('../../../src/integrations/cloud/llm/run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/integrations/cloud/llm/run.js')>()),
  isLlmConfiguredWithKeyStore: vi.fn(async () => true),
}));

const rerankMock = vi.fn(async (query: string, results: MergedSearchResult[]): Promise<MergedSearchResult[]> => {
  const qWords = [...new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2))];
  const score = (r: MergedSearchResult): number => {
    const text = `${r.title}\n${r.snippet}`.toLowerCase();
    if (qWords.length === 0) return 0;
    let hit = 0;
    for (const w of qWords) if (text.includes(w)) hit++;
    return hit / qWords.length;
  };
  return [...results].map((r) => ({ ...r, relevance_score: score(r) })).sort((a, b) => b.relevance_score - a.relevance_score);
});
vi.mock('../../../src/search/rerank.js', () => ({ rerankResults: rerankMock }));

const { handleResearch } = await import('../../../src/tools/research.js');

const QUESTION = 'wigolo studio capture pipeline dedup moat';
const NOTE_TEXT = 'wigolo studio capture pipeline dedup moat — human note: the durable local knowledge layer compounds across sessions.';
const CLIP_MD = 'wigolo studio capture pipeline dedup moat — clipped page region on the local knowledge layer.';

const WEB_RESULTS: RawSearchResult[] = [
  { title: 'React Hooks Guide', url: 'https://react.dev/hooks', snippet: 'Learn about component effects.', relevance_score: 0.95, engine: 'stub' },
];

function stubEngine(results: RawSearchResult[] = WEB_RESULTS): SearchEngine {
  return { name: 'stub', search: vi.fn().mockResolvedValue(results) };
}
function stubRouter(): SmartRouter {
  return {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com', finalUrl: 'https://example.com',
      html: '<html><body><h1>Web</h1><p>Generic web body.</p></body></html>',
      contentType: 'text/html', statusCode: 200, method: 'http' as const, headers: {},
    }),
  } as unknown as SmartRouter;
}

function seedNote(sessionId = 's1', text = NOTE_TEXT): number {
  return captureHumanNote({ sessionId, text }, { db: getDatabase(), enqueue: () => undefined }).id;
}
function seedClip(sessionId = 's1', url = 'https://example.com/clip-page', markdown = CLIP_MD): number {
  return captureFromPage({ type: 'clip', sessionId, url, title: 'Capture Pipeline Notes', markdown }, { db: getDatabase(), enqueue: () => undefined }).id;
}

async function research() {
  return handleResearch({ question: QUESTION, depth: 'standard', max_tokens_out: 5000 } as ResearchInput, [stubEngine()], stubRouter());
}

describe('research — note trust through the local-LLM synthesis citation path (C3 slice-2)', () => {
  beforeEach(() => {
    _resetMigrationGuard();
    initDatabase(':memory:');
    extractMock.mockResolvedValue({
      title: 'Web Extract', markdown: '# Web\n\nGeneric article body about an unrelated subject.',
      metadata: {}, links: [], images: [], extractor: 'defuddle' as const,
    });
  });
  afterEach(() => {
    closeDatabase();
  });

  it('NOTE-TRUST (local-synth): the note citation from the local-synthesis constructor carries trusted:true', async () => {
    const noteId = seedNote();
    seedClip();
    const r = await research();
    expect(r.ok).toBe(true);
    const out = r.ok ? r.data : null;
    // confirm we are on the Phase-5b local-synth path (its fixed text became the report).
    expect(out!.report, 'on the local-synthesis path').toContain('local synthesized report');

    const noteKey = `studio://note|${noteId}`;
    const noteCite = out!.citations.find((c) => c.url === noteKey);
    // PRIMARY RED (pre-impl): note excluded by STUDIO_RESEARCH_TYPES → no note citation at all.
    expect(noteCite, `note citation ${noteKey}; got ${JSON.stringify(out!.citations.map((c) => c.url))}`).toBeDefined();
    // mutation A: pipeline.ts:313 mirror → false ⇒ RED.
    // mutation B: pipeline.ts:296-298 localSources map drops `trusted` ⇒ :313 mirror reads
    //   undefined → false ⇒ RED (the carry is load-bearing).
    expect(noteCite!.trusted, 'note local-synth citation trusted (313 mirror + 296-298 carry)').toBe(true);
  });

  it('CLIP-STAY-FALSE (local-synth): the clip citation from the same constructor stays trusted:false', async () => {
    seedNote();
    const clipId = seedClip();
    const r = await research();
    const out = r.ok ? r.data : null;
    const clipKey = `studio://clip|${clipId}`;
    const clipCite = out!.citations.find((c) => c.url === clipKey);
    expect(clipCite, `clip citation ${clipKey}`).toBeDefined();
    // mutation: pipeline.ts:313 → hardcode true ⇒ clip citation flips to true ⇒ RED.
    expect(clipCite!.trusted, 'clip local-synth citation stays false (content_trusted=0)').toBe(false);
  });
});
