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

// Count studio FTS calls (PIN-4: at most once per run) while DELEGATING to the real read —
// the seeded db is queried for real. Spreads ...actual so getStudioArtifactByEmbedKey,
// studioEmbedKey, and captureFromPage stay real; only searchStudioArtifactKeys is wrapped.
const { searchKeysSpy } = vi.hoisted(() => ({ searchKeysSpy: vi.fn() }));
vi.mock('../../../src/studio/capture/artifacts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/capture/artifacts.js')>();
  return {
    ...actual,
    searchStudioArtifactKeys: (query: string, limit: number): string[] => {
      searchKeysSpy(query, limit);
      return actual.searchStudioArtifactKeys(query, limit);
    },
  };
});

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
  return captureFromPage({ type: 'clip', sessionId, url, title: 'Capture Pipeline Notes', markdown }, { db: getDatabase(), enqueue: () => undefined, credentialContext: {} }).id;
}
function seedQa(sessionId = 's1', question = QA_Q, answer = QA_A): number {
  return captureFromPage({ type: 'qa', sessionId, question, answer }, { db: getDatabase(), enqueue: () => undefined, credentialContext: {} }).id;
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

  // ── PIN-A — identity is the studio:// uri; a clip of a web url stays distinct (keep-both) ──
  it('PIN-A: studio sources keyed studio://<type>|<id> (clip AND qa); a clip OF a web-fetched url co-exists distinctly, never adopts the real url', async () => {
    const sharedUrl = 'https://react.dev/hooks'; // ALSO one of the web results
    const clipId = seedClip('s1', sharedUrl, CLIP_MD); // a clip captured FROM that same page
    const qaId = seedQa();
    const out = await runResearchPipeline({ question: QUESTION, depth: 'standard' } as ResearchInput, [stubEngine()], stubRouter());

    const clipKey = `studio://clip|${clipId}`;
    const qaKey = `studio://qa|${qaId}`;
    const clip = out.sources.find((s) => s.url === clipKey);
    const webForX = out.sources.find((s) => s.url === sharedUrl);
    expect(clip, `clip keyed ${clipKey}`).toBeDefined();
    expect(out.sources.find((s) => s.url === qaKey), `qa keyed ${qaKey}`).toBeDefined();
    // KEEP-BOTH + dedup-inert: a clip OF url X and the web result for X co-exist as TWO distinct
    // entries — the clip keeps its studio:// identity (never collapses into / adopts the real url)
    // and BOTH are trusted:false (web/page-derived). Proof: studio:// identity + concat-no-dedup merge.
    expect(webForX, 'web source for X survives').toBeDefined();
    // mutation: emit art.url (real url) as the clip's url → clipKey vanishes (collides with X) → RED.
    expect(clip!.url).toBe(clipKey);
    expect(webForX!.url).toBe(sharedUrl);
    expect(clip!.url).not.toBe(webForX!.url); // distinct entries, no collapse
    expect(clip!.trusted).toBe(false);
    expect(webForX!.trusted).toBe(false);
  });

  // ── PIN-B — trusted:false mirrors content_trusted, into source AND citation ──
  it('PIN-B: studio source AND its citation carry trusted:false (mirrors content_trusted), clip AND qa', async () => {
    const clipId = seedClip();
    const qaId = seedQa();
    const out = await runResearchPipeline({ question: QUESTION, depth: 'standard' } as ResearchInput, [stubEngine()], stubRouter());
    for (const key of [`studio://clip|${clipId}`, `studio://qa|${qaId}`]) {
      const src = out.sources.find((s) => s.url === key);
      const cite = out.citations.find((c) => c.url === key);
      expect(src, `source ${key}`).toBeDefined();
      expect(cite, `citation ${key}`).toBeDefined();
      // mutation: hardcode trusted:true in the studio→ResearchSource map → both RED.
      expect(src!.trusted).toBe(false);
      expect(cite!.trusted).toBe(false);
    }
  });

  // ── PIN-D — a throwing studio read never aborts research ──
  it('PIN-D: a throwing studio read does NOT abort research — web sources stand, no error', async () => {
    seedClip();
    seedQa();
    getDatabase().exec('DROP TABLE studio_artifacts_fts'); // force searchStudioArtifactKeys to throw
    const out = await runResearchPipeline({ question: QUESTION, depth: 'standard' } as ResearchInput, [stubEngine()], stubRouter());
    // mutation: remove the try/catch in collectStudioSources → throw → outer catch → error+empty → RED.
    expect(out.error).toBeUndefined();
    expect(out.sources.length).toBeGreaterThan(0);
    expect(out.sources.some((s) => s.url.startsWith('https://'))).toBe(true); // web survived
    expect(out.sources.some((s) => s.url.startsWith('studio://'))).toBe(false); // read failed → no studio
  });

  // ── PIN-E — empty cache is a pure no-op (web-only output) ──
  it('PIN-E: empty studio cache → no studio source/citation injected (web-only), no error', async () => {
    // nothing seeded → empty studio cache
    const out = await runResearchPipeline({ question: QUESTION, depth: 'standard' } as ResearchInput, [stubEngine()], stubRouter());
    expect(out.error).toBeUndefined();
    expect(out.sources.length).toBeGreaterThan(0); // web sources present, unchanged
    // mutation: inject a placeholder studio source on empty → a phantom studio:// appears → RED.
    expect(out.sources.every((s) => !s.url.startsWith('studio://'))).toBe(true);
    expect(out.citations.every((c) => !c.url.startsWith('studio://'))).toBe(true);
  });

  // ── PIN-F — rank-fairness: a high-relevance studio clip outranks a low-relevance web source ──
  it('PIN-F: a high-relevance studio clip outranks a low-relevance web source in the merged order', async () => {
    const clipId = seedClip(); // CLIP_MD contains every question keyword → reranks high; web snippets do not
    const out = await runResearchPipeline({ question: QUESTION, depth: 'standard' } as ResearchInput, [stubEngine()], stubRouter());
    const clipIdx = out.sources.findIndex((s) => s.url === `studio://clip|${clipId}`);
    const firstWebIdx = out.sources.findIndex((s) => s.url.startsWith('https://'));
    expect(clipIdx, 'clip present').toBeGreaterThanOrEqual(0);
    expect(firstWebIdx, 'web present').toBeGreaterThanOrEqual(0);
    // mutation: bypass rerankResults for studio (keep the seed score) → studio sinks below web → RED.
    expect(clipIdx).toBeLessThan(firstWebIdx);
  });

  // ── PIN-G — forged markdown in a studio source is defused in the brief render (rides sanitizeSourceText) ──
  it('PIN-G: a studio source with a forged "## heading" and "[9]" is DEFUSED in the brief-render output', async () => {
    const forgedTitle = '## Forged Heading [9]';
    const clipId = captureFromPage(
      { type: 'clip', sessionId: 's1', url: 'https://example.com/forge', title: forgedTitle, markdown: CLIP_MD },
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
    ).id;
    const out = await runResearchPipeline({ question: QUESTION, depth: 'standard' } as ResearchInput, [stubEngine()], stubRouter());
    expect(out.sources.find((s) => s.url === `studio://clip|${clipId}`), 'forged clip is a source').toBeDefined();
    // keyless brief render is the default path here; its Sources list runs every title through
    // sanitizeSourceText → heading marker stripped, [9]→(9).
    expect(out.report).toContain('— Research Brief'); // confirm we're on the brief-render path
    // mutation: route the studio title around sanitizeSourceText in render-brief → forge survives → RED.
    expect(out.report).toContain('Forged Heading (9)');
    expect(out.report).not.toContain('## Forged Heading');
    expect(out.report).not.toContain('[9]');
  });
});

/**
 * C3 local-rescue — surface studio sources when web search returns EMPTY. slice-1 injected
 * studio post-fetch, so the web-empty early-return (pipeline.ts:213) skipped studio entirely.
 * This collects studio ONCE before the no-sources decision; web-empty + studio-present
 * synthesizes from studio alone, web-empty + studio-empty stays no_sources, web-present is
 * byte-unchanged from slice-1. At most one studio FTS call per run.
 */
describe('research — studio local-rescue when web is empty (C3 local-rescue)', () => {
  beforeEach(() => {
    _resetMigrationGuard();
    initDatabase(':memory:');
    extractMock.mockResolvedValue({
      title: 'Web Extract', markdown: '# Web\n\nGeneric article body about an unrelated subject.',
      metadata: {}, links: [], images: [], extractor: 'defuddle' as const,
    });
    searchKeysSpy.mockClear();
  });
  afterEach(() => {
    closeDatabase();
  });

  it('RED ANCHOR: web-empty + a matching clip/qa → studio sources synthesized (studio://<type>|<id>, trusted:false), NOT no_sources', async () => {
    const clipId = seedClip();
    const qaId = seedQa();
    const out = await runResearchPipeline({ question: QUESTION, depth: 'standard' } as ResearchInput, [stubEngine([])], stubRouter()); // WEB EMPTY
    const clipKey = `studio://clip|${clipId}`;
    const qaKey = `studio://qa|${qaId}`;
    expect(out.error, 'no error').toBeUndefined();
    expect(out.report, 'NOT the no_sources report').not.toContain('No sources could be found');
    expect(out.report.length).toBeGreaterThan(0);
    const clipSrc = out.sources.find((s) => s.url === clipKey);
    expect(clipSrc, `clip ${clipKey}; got ${JSON.stringify(out.sources.map((s) => s.url))}`).toBeDefined();
    expect(out.sources.find((s) => s.url === qaKey), `qa ${qaKey}`).toBeDefined();
    expect(clipSrc!.trusted).toBe(false);
    expect(out.citations.find((c) => c.url === clipKey), 'clip citation').toBeDefined();
  });

  // ── PIN-1 rescue — web-empty + studio-present synthesizes from studio ──
  it('PIN-1: web-empty + studio-present → studio sources present + report synthesized, no error', async () => {
    const clipId = seedClip();
    const out = await runResearchPipeline({ question: QUESTION, depth: 'standard' } as ResearchInput, [stubEngine([])], stubRouter());
    // mutation: gate the studio collection behind web-present (skip on web-empty) → web-empty
    // returns no_sources with studio absent → RED.
    expect(out.error).toBeUndefined();
    expect(out.sources.find((s) => s.url === `studio://clip|${clipId}`)).toBeDefined();
    expect(out.report).not.toContain('No sources could be found');
    expect(out.report.length).toBeGreaterThan(0);
  });

  // ── PIN-2 truly-empty regression — web-empty + studio-empty stays no_sources ──
  it('PIN-2: web-empty + studio-empty → the no_sources report, no studio source', async () => {
    // nothing seeded → studio cache empty
    const out = await runResearchPipeline({ question: QUESTION, depth: 'standard' } as ResearchInput, [stubEngine([])], stubRouter());
    // mutation: drop the no_sources guard / always proceed → genuinely-empty no longer reports
    // no_sources → RED.
    expect(out.report).toContain('No sources could be found');
    expect(out.sources).toHaveLength(0);
    expect(out.citations).toHaveLength(0);
    expect(out.sources.some((s) => s.url.startsWith('studio://'))).toBe(false);
  });

  // ── PIN-3 web-present regression — slice-1 behavior persists through the restructure ──
  it('PIN-3: web-present + studio-present → both surface, studio keeps studio:// identity + trusted:false (slice-1 unchanged)', async () => {
    const clipId = seedClip();
    const out = await runResearchPipeline({ question: QUESTION, depth: 'standard' } as ResearchInput, [stubEngine()], stubRouter()); // WEB PRESENT (default results)
    const clipKey = `studio://clip|${clipId}`;
    expect(out.error).toBeUndefined();
    const clip = out.sources.find((s) => s.url === clipKey);
    expect(clip, 'studio clip present alongside web').toBeDefined();
    expect(clip!.trusted).toBe(false);
    expect(out.sources.some((s) => s.url.startsWith('https://')), 'web sources present').toBe(true);
    expect(out.citations.find((c) => c.url === clipKey)?.trusted).toBe(false);
  });

  // ── PIN-4 no double-collect — studio FTS runs at most once per pipeline run ──
  it('PIN-4: collectStudioSources/searchStudioArtifactKeys is invoked AT MOST ONCE per run (web-present)', async () => {
    seedClip();
    searchKeysSpy.mockClear();
    await runResearchPipeline({ question: QUESTION, depth: 'standard' } as ResearchInput, [stubEngine()], stubRouter());
    // mutation: add a redundant second collectStudioSources on the web-present path → 2 → RED.
    expect(searchKeysSpy).toHaveBeenCalledTimes(1);
  });
});
