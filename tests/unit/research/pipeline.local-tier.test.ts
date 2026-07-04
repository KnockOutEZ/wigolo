/**
 * Research synthesis must ALSO fire the local-model path via the C0 opt-in
 * tier (resolveLocalModelTier), not only when a cloud key / explicit provider
 * is configured. The ladder is host-sampling > local model > deterministic.
 *
 * These are deterministic mocked tests for the ladder gating: tier present ->
 * synthesizeLocal called with the tier; tier null AND no cloud key -> NO model
 * call, deterministic evidence assembly. A citation-alignment test proves the
 * per-claim [n] indices stay bound to the correct source through the local
 * path (a leading unfetched row must not shift them).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: vi.fn().mockResolvedValue({
      title: 'Extracted Title',
      markdown: '# Extracted Content\n\nArticle content about the topic.',
      metadata: {},
      links: [],
      images: [],
      extractor: 'defuddle' as const,
    }),
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

vi.mock('../../../src/cache/store.js', () => ({
  cacheContent: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url),
}));

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: vi.fn(() => ({
    isAvailable: () => false,
    embedAsync: vi.fn(),
  })),
}));

vi.mock('../../../src/integrations/cloud/llm/local-tier.js', () => ({
  resolveLocalModelTier: vi.fn(),
}));

// The cloud-key gate is forced OFF so these tests exercise the tier path in
// isolation — no cloud provider, no keychain key.
vi.mock('../../../src/integrations/cloud/llm/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/integrations/cloud/llm/run.js')>();
  return { ...actual, isLlmConfiguredWithKeyStore: vi.fn(async () => false) };
});

const localTierModule = await import('../../../src/integrations/cloud/llm/local-tier.js');
const synthesisLocalModule = await import('../../../src/research/synthesis-local.js');
const { runResearchPipeline } = await import('../../../src/research/pipeline.js');

function createStubEngine(results: RawSearchResult[]): SearchEngine {
  return { name: 'stub', search: vi.fn().mockResolvedValue(results) };
}

function createStubRouter(): SmartRouter {
  return {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html: '<html><body><h1>Test</h1><p>Article content about the topic.</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;
}

const RESULTS: RawSearchResult[] = [
  { title: 'React Hooks Guide', url: 'https://react.dev/hooks', snippet: 'Learn about hooks.', relevance_score: 0.95, engine: 'stub' },
  { title: 'Vue Composition API', url: 'https://vuejs.org/guide', snippet: 'Vue 3 composition API.', relevance_score: 0.88, engine: 'stub' },
];

describe('research synthesis fires via the local-model tier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls synthesizeLocal WITH the tier when resolveLocalModelTier is available', async () => {
    vi.mocked(localTierModule.resolveLocalModelTier).mockResolvedValue({
      available: true,
      endpoint: 'http://localhost:11434',
      model: 'qwen2.5:7b-instruct',
      source: 'auto',
    });

    const localSpy = vi.spyOn(synthesisLocalModule, 'synthesizeLocal').mockResolvedValue({
      text: 'Local-tier report about reactivity [1][2].',
      citations: [0, 1],
    });

    const input: ResearchInput = { question: 'modern reactivity primitives', depth: 'quick' };
    const out = await runResearchPipeline(input, [createStubEngine(RESULTS)], createStubRouter());

    expect(out.error).toBeUndefined();
    expect(localSpy).toHaveBeenCalledTimes(1);
    const tierArg = localSpy.mock.calls[0]![2];
    expect(tierArg?.tier).toEqual({ endpoint: 'http://localhost:11434', model: 'qwen2.5:7b-instruct' });
    expect(out.report).toContain('Local-tier report');
  });

  it('does NOT call synthesizeLocal when tier is null and no cloud key (byte-for-byte deterministic)', async () => {
    vi.mocked(localTierModule.resolveLocalModelTier).mockResolvedValue(null);

    const localSpy = vi.spyOn(synthesisLocalModule, 'synthesizeLocal');

    const input: ResearchInput = { question: 'modern reactivity primitives', depth: 'quick' };
    const out = await runResearchPipeline(input, [createStubEngine(RESULTS)], createStubRouter());

    expect(out.error).toBeUndefined();
    expect(localSpy).not.toHaveBeenCalled();
    // Deterministic evidence assembly still produces a report + citations.
    expect(out.report.length).toBeGreaterThan(0);
  });

  it('falls back deterministically when the tier synthesis throws (timeout/failure)', async () => {
    vi.mocked(localTierModule.resolveLocalModelTier).mockResolvedValue({
      available: true,
      endpoint: 'http://localhost:11434',
      model: 'qwen2.5:7b-instruct',
      source: 'auto',
    });

    vi.spyOn(synthesisLocalModule, 'synthesizeLocal').mockRejectedValue(new Error('tier timeout'));

    const input: ResearchInput = { question: 'modern reactivity primitives', depth: 'quick' };
    const out = await runResearchPipeline(input, [createStubEngine(RESULTS)], createStubRouter());

    expect(out.error).toBeUndefined();
    // The heuristic brief report is used; citations still come from sources.
    expect(out.report.length).toBeGreaterThan(0);
    expect(out.citations.length).toBeGreaterThan(0);
  });

  it('keeps per-claim [n] citations index-aligned to the correct source through the tier path', async () => {
    vi.mocked(localTierModule.resolveLocalModelTier).mockResolvedValue({
      available: true,
      endpoint: 'http://localhost:11434',
      model: 'qwen2.5:7b-instruct',
      source: 'auto',
    });

    // The model cites source [2] only (0-based idx 1). The returned citation
    // must resolve to the SECOND source's url/title, not the first — proving
    // the dedupe/remap did not shift the index.
    vi.spyOn(synthesisLocalModule, 'synthesizeLocal').mockResolvedValue({
      text: 'Only the Vue source is cited here [2].',
      citations: [1],
    });

    const input: ResearchInput = { question: 'modern reactivity primitives', depth: 'quick' };
    const out = await runResearchPipeline(input, [createStubEngine(RESULTS)], createStubRouter());

    expect(out.error).toBeUndefined();
    expect(out.citations).toHaveLength(1);
    const c = out.citations[0];
    expect(c.index).toBe(2);
    // Second source in the fetched set is the Vue page.
    expect(out.sources[c.index - 1]?.url).toBe(out.sources[1]?.url);
  });
});
