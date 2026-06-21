import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import type { MergedSearchResult } from '../../../src/search/dedup.js';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { captureFromPage, captureHumanNote } from '../../../src/studio/capture/artifacts.js';

/**
 * C3 slice-2 — a human NOTE is the FIRST trusted research source. Notes are the only
 * capture path that sets content_trusted=1 (a human typed the bytes), so a surfaced note
 * is the first time research output carries trusted:true (everything else is web/page-
 * derived → false).
 *
 * Real db + real cache/store so the note enters via the REAL path — captureHumanNote →
 * real insert + FTS trigger → searchStudioArtifactKeys → getStudioArtifactByEmbedKey. NO
 * stubbed studio read (the read seam is artifacts.ts only — keeps the check-gate at 23).
 * Tool layer (handleResearch) so the EvidenceItem path (attachEvidence → research.ts:98)
 * is exercised alongside sources + citations. isLlm OFF → keyless brief + the
 * synthesizeReport citation constructor (synthesize.ts:45); the local-LLM synthesis
 * citation constructor is pinned separately (its config forces isLlm ON).
 *
 * rerank is the slice-1 deterministic keyword-overlap scorer so studio + web share a
 * content-based scale and the note reliably makes the merged cap.
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

// No local LLM → keyless brief path (deterministic) + no Gemini 429 flake. This config
// routes citations through synthesizeReport (synthesize.ts:45), NOT the local-synth fallback.
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

const { handleResearch } = await import('../../../src/tools/research.js');

const QUESTION = 'wigolo studio capture pipeline dedup moat';
const NOTE_TEXT = 'wigolo studio capture pipeline dedup moat — human note: the durable local knowledge layer compounds across sessions.';
const CLIP_MD = 'wigolo studio capture pipeline dedup moat — clipped page region on the local knowledge layer.';
const QA_Q = 'How does dedup work in the studio capture pipeline?';
const QA_A = 'wigolo studio capture pipeline dedup moat via two symmetric partial unique indexes.';

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

function seedNote(sessionId = 's1', text = NOTE_TEXT): number {
  return captureHumanNote({ sessionId, text }, { db: getDatabase(), enqueue: () => undefined }).id;
}
function seedClip(sessionId = 's1', url = 'https://example.com/clip-page', markdown = CLIP_MD): number {
  return captureFromPage({ type: 'clip', sessionId, url, title: 'Capture Pipeline Notes', markdown }, { db: getDatabase(), enqueue: () => undefined }).id;
}
function seedQa(sessionId = 's1', question = QA_Q, answer = QA_A): number {
  return captureFromPage({ type: 'qa', sessionId, question, answer }, { db: getDatabase(), enqueue: () => undefined }).id;
}

async function research() {
  // generous max_tokens_out so the evidence budget never cuts the note/clip passages
  return handleResearch({ question: QUESTION, depth: 'standard', max_tokens_out: 5000 } as ResearchInput, [stubEngine()], stubRouter());
}

describe('research — a human note is the first trusted source (C3 slice-2)', () => {
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

  // ── NOTE-TRUST (source + synthesizeReport citation) ──
  it('RED ANCHOR / NOTE-TRUST: a seeded note surfaces as a source AND a citation, BOTH trusted:true', async () => {
    const noteId = seedNote();
    const r = await research();
    expect(r.ok).toBe(true);
    const out = r.ok ? r.data : null;
    const noteKey = `studio://note|${noteId}`;

    const noteSrc = out!.sources.find((s) => s.url === noteKey);
    // PRIMARY RED (pre-impl): note excluded by STUDIO_RESEARCH_TYPES → never surfaced → undefined.
    expect(noteSrc, `note source ${noteKey}; got ${JSON.stringify(out!.sources.map((s) => s.url))}`).toBeDefined();
    // mutation: collectStudioSources origin mirror (pipeline.ts:490) → hardcode false ⇒ RED.
    expect(noteSrc!.trusted, 'note SOURCE trusted (mirrors content_trusted=1)').toBe(true);

    const noteCite = out!.citations.find((c) => c.url === noteKey);
    expect(noteCite, `note citation ${noteKey}`).toBeDefined();
    // mutation: synthesize.ts:45 mirror → false ⇒ note CITATION REDs (this synthesizeReport config).
    expect(noteCite!.trusted, 'note CITATION trusted (synthesize.ts:45 mirror)').toBe(true);
  });

  // ── NOTE-TRUST (EvidenceItem via attachEvidence → research.ts:98) ──
  it('NOTE-TRUST: the note produces an EvidenceItem carrying trusted:true', async () => {
    const noteId = seedNote();
    const r = await research();
    const out = r.ok ? r.data : null;
    const noteKey = `studio://note|${noteId}`;
    const noteEv = out!.evidence?.find((e) => e.url === noteKey);
    expect(noteEv, `note evidence ${noteKey}; got ${JSON.stringify(out!.evidence?.map((e) => e.url))}`).toBeDefined();
    // mutation: research.ts:98 drops `trusted: s.trusted` ⇒ evidence.ts:103 `opts.trusted ?? false`
    // ⇒ note EVIDENCE REDs.
    expect(noteEv!.trusted, 'note EVIDENCE trusted (research.ts:98 threads s.trusted)').toBe(true);
  });

  // ── CLIP/QA-STAY-FALSE (slice-1 regression survives the promotes) ──
  it('CLIP/QA-STAY-FALSE: clip + qa stay trusted:false on source, citation, and evidence after the note promotes', async () => {
    const clipId = seedClip();
    const qaId = seedQa();
    seedNote(); // a trusted source present alongside, to prove the mirror is per-source not blanket-true
    const r = await research();
    const out = r.ok ? r.data : null;
    for (const key of [`studio://clip|${clipId}`, `studio://qa|${qaId}`]) {
      const src = out!.sources.find((s) => s.url === key);
      const cite = out!.citations.find((c) => c.url === key);
      expect(src, `source ${key}`).toBeDefined();
      expect(cite, `citation ${key}`).toBeDefined();
      // mutation: replace any promoted mirror with hardcode true ⇒ clip/qa flip to true ⇒ RED.
      expect(src!.trusted, `${key} source stays false (content_trusted=0)`).toBe(false);
      expect(cite!.trusted, `${key} citation stays false`).toBe(false);
      const ev = out!.evidence?.find((e) => e.url === key);
      if (ev) expect(ev.trusted, `${key} evidence stays false`).toBe(false);
    }
  });

  // ── IDENTITY / KEEP-BOTH (note + clip-of-topic + web-of-topic → 3 distinct) ──
  it('IDENTITY/KEEP-BOTH: a note + a clip OF a web url + the web result are 3 distinct url-keyed sources, no collapse', async () => {
    const sharedUrl = 'https://react.dev/hooks'; // also a WEB_RESULT
    const noteId = seedNote();
    const clipId = seedClip('s1', sharedUrl, CLIP_MD); // a clip captured FROM that same page
    const r = await research();
    const out = r.ok ? r.data : null;
    const noteKey = `studio://note|${noteId}`;
    const clipKey = `studio://clip|${clipId}`;
    const note = out!.sources.find((s) => s.url === noteKey);
    const clip = out!.sources.find((s) => s.url === clipKey);
    const web = out!.sources.find((s) => s.url === sharedUrl);
    expect(note, `note keyed ${noteKey}`).toBeDefined();
    expect(clip, `clip keyed ${clipKey}`).toBeDefined();
    expect(web, 'web source survives').toBeDefined();
    // 3 pairwise-distinct identities — the note keeps its studio:// uri, never adopts a real
    // url or collides with the clip. mutation: collectStudioSources emits a constant/shared url
    // for studio sources ⇒ note + clip collapse ⇒ a key vanishes ⇒ RED.
    const urls = new Set([note!.url, clip!.url, web!.url]);
    expect(urls.size, 'three distinct source urls').toBe(3);
    expect(note!.url).toBe(noteKey);
    expect(note!.url).not.toBe(clip!.url);
    expect(note!.url).not.toBe(web!.url);
  });

  // ── REUSE — empty studio cache is a pure no-op (web-only, no error) ──
  it('REUSE: empty studio cache → no studio source injected (web-only), no error', async () => {
    const r = await research(); // nothing seeded
    const out = r.ok ? r.data : null;
    expect(out!.error).toBeUndefined();
    expect(out!.sources.length).toBeGreaterThan(0); // web present, unchanged
    expect(out!.sources.every((s) => !s.url.startsWith('studio://'))).toBe(true);
    expect(out!.citations.every((c) => !c.url.startsWith('studio://'))).toBe(true);
  });

  // ── MARKDOWN-GUARD — the markdown≠null backstop sitting beside the log-split type guard ──
  it('MARKDOWN-GUARD: an in-set artifact (clip) with empty markdown is NOT surfaced as a research source', async () => {
    // Title carries the question keywords so FTS returns this artifact; its markdown is empty,
    // so the `art.markdown === null || length === 0` backstop must drop it (an empty artifact
    // has no content to cite). A mark — the other null-markdown case — is double-guarded
    // (type-set AND markdown), so an in-set clip is what isolates the markdown guard.
    const emptyClipId = captureFromPage(
      { type: 'clip', sessionId: 's1', url: 'https://example.com/empty', title: QUESTION, markdown: '' },
      { db: getDatabase(), enqueue: () => undefined },
    ).id;
    const r = await research();
    const out = r.ok ? r.data : null;
    const emptyKey = `studio://clip|${emptyClipId}`;
    // mutation: relax the markdown guard to admit null/empty ⇒ the empty clip surfaces as a
    // source ⇒ RED (value-flip; the surfacing also proves FTS returned the key, so the guard,
    // not an FTS miss, is what excludes it).
    expect(out!.sources.some((s) => s.url === emptyKey), `empty-markdown clip ${emptyKey} must NOT surface`).toBe(false);
    expect(out!.citations.some((c) => c.url === emptyKey), 'empty-markdown clip has no citation').toBe(false);
  });
});
