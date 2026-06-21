import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import type { MergedSearchResult } from '../../../src/search/dedup.js';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { captureFromPage } from '../../../src/studio/capture/artifacts.js';

/**
 * C3 slice-1 — studio_artifacts (clip + qa) as LOCAL research sources.
 *
 * Real db + real cache/store (so captureFromPage seeds + the shared studio read run for
 * real) — the cache-studio-union pattern. Only the WEB side is mocked: a stub engine +
 * router + the extractor. embedding is off (no ONNX); the local LLM is off so the keyless
 * brief path runs deterministically (and the env's real Google key can't 429-flake us).
 *
 * rerankResults is mocked to a deterministic keyword-overlap scorer (the suite defaults
 * WIGOLO_RERANKER='none' → passthrough, which can't re-score; this gives studio AND web a
 * comparable, content-based score so the merge order is deterministic and PIN-F is real).
 */

const extractMock = vi.fn();
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({ name: 'v1' as const, extract: extractMock })),
  _resetExtractProviderForTest: vi.fn(),
}));

// embedding off — never touch the ONNX subprocess in this unit test.
vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({ isAvailable: () => false, embedAsync: vi.fn() }),
  resetEmbeddingService: vi.fn(),
}));

// No local LLM → keyless brief path (deterministic) + no Gemini 429 flake.
vi.mock('../../../src/integrations/cloud/llm/run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/integrations/cloud/llm/run.js')>()),
  isLlmConfiguredWithKeyStore: async () => false,
}));

// Deterministic rerank: score = fraction of question keywords present in `${title}\n${snippet}`.
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

const { runResearchPipeline } = await import('../../../src/research/pipeline.js');

const QUESTION = 'wigolo studio capture pipeline dedup moat';
const CLIP_MD = 'wigolo studio capture pipeline dedup moat — the durable local knowledge layer.';
const QA_Q = 'How does dedup work in the studio capture pipeline?';
const QA_A = 'wigolo studio capture pipeline dedup moat via two symmetric partial unique indexes.';

// Web results whose snippets do NOT contain the question keywords → low rerank score, so
// a relevant studio source outranks them (PIN-F) yet both still surface (maxSources is large).
const WEB_RESULTS: RawSearchResult[] = [
  { title: 'React Hooks Guide', url: 'https://react.dev/hooks', snippet: 'Learn about component effects.', relevance_score: 0.95, engine: 'stub' },
  { title: 'Vue Composition', url: 'https://vuejs.org/guide', snippet: 'Reactive refs and computed values.', relevance_score: 0.88, engine: 'stub' },
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

function seedClip(sessionId = 's1', url = 'https://example.com/clip-page', markdown = CLIP_MD): number {
  return captureFromPage({ type: 'clip', sessionId, url, title: 'Capture Pipeline Notes', markdown }, { db: getDatabase(), enqueue: () => undefined }).id;
}
function seedQa(sessionId = 's1', question = QA_Q, answer = QA_A): number {
  return captureFromPage({ type: 'qa', sessionId, question, answer }, { db: getDatabase(), enqueue: () => undefined }).id;
}

describe('research — studio_artifacts as local sources (C3 slice-1)', () => {
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

  it('RED ANCHOR: a seeded clip + qa surface in out.sources keyed studio://<type>|<id>, trusted:false, each with a citation', async () => {
    const clipId = seedClip();
    const qaId = seedQa();

    const out = await runResearchPipeline({ question: QUESTION, depth: 'standard' } as ResearchInput, [stubEngine()], stubRouter());

    const clipKey = `studio://clip|${clipId}`;
    const qaKey = `studio://qa|${qaId}`;

    const clipSrc = out.sources.find((s) => s.url === clipKey);
    const qaSrc = out.sources.find((s) => s.url === qaKey);
    expect(clipSrc, `clip source ${clipKey}; got ${JSON.stringify(out.sources.map((s) => s.url))}`).toBeDefined();
    expect(qaSrc, `qa source ${qaKey}`).toBeDefined();
    expect(clipSrc!.trusted).toBe(false);
    expect(qaSrc!.trusted).toBe(false);

    const clipCite = out.citations.find((c) => c.url === clipKey);
    const qaCite = out.citations.find((c) => c.url === qaKey);
    expect(clipCite, 'clip citation').toBeDefined();
    expect(qaCite, 'qa citation').toBeDefined();
    expect(clipCite!.trusted).toBe(false);
    expect(qaCite!.trusted).toBe(false);
  });
});
