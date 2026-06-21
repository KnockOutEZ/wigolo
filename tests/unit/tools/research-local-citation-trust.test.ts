import { describe, it, expect, vi } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

/**
 * 4d slice-4 follow-up — value-pin the OTHER research citation constructor: the
 * pipeline's Phase-5b local-LLM synthesis fallback (pipeline.ts), which is off the
 * synthesizeReport path the slice-4 pin exercised. It is reached when the host LLM
 * did not sample AND a local LLM is configured. We force that branch
 * deterministically: isLlmConfiguredWithKeyStore → true and synthesizeLocal returns
 * a fixed citation-index set, so finalCitations come from the local-synthesis
 * constructor — then assert they carry trusted:false (web/page-derived, C4).
 */

const extractMock = vi.fn().mockResolvedValue({
  title: 'Extracted Title',
  markdown: '# Extracted Content\n\nArticle content about the topic.',
  metadata: {}, links: [], images: [], extractor: 'defuddle' as const,
});
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({ name: 'v1' as const, extract: extractMock })),
  _resetExtractProviderForTest: vi.fn(),
}));
vi.mock('../../../src/cache/store.js', () => ({
  cacheContent: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url),
}));
// Force the Phase-5b local-LLM synthesis path.
vi.mock('../../../src/research/synthesis-local.js', () => ({
  synthesizeLocal: vi.fn(async () => ({ text: 'local synthesized report [1][2]', citations: [0, 1] })),
}));
vi.mock('../../../src/integrations/cloud/llm/run.js', async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  isLlmConfiguredWithKeyStore: vi.fn(async () => true),
}));

const { handleResearch } = await import('../../../src/tools/research.js');

const stubEngine: SearchEngine = {
  name: 'stub',
  search: vi.fn().mockResolvedValue([
    { title: 'React Hooks Guide', url: 'https://react.dev/hooks', snippet: 'Learn about hooks.', relevance_score: 0.95, engine: 'stub' },
    { title: 'Vue Composition API', url: 'https://vuejs.org/guide', snippet: 'Vue 3 composition API.', relevance_score: 0.88, engine: 'stub' },
    { title: 'Svelte Stores', url: 'https://svelte.dev/docs', snippet: 'Svelte reactive stores.', relevance_score: 0.82, engine: 'stub' },
    { title: 'Angular Signals', url: 'https://angular.io/signals', snippet: 'Angular signal primitives.', relevance_score: 0.75, engine: 'stub' },
    { title: 'Solid Signals', url: 'https://solidjs.com/docs', snippet: 'SolidJS fine-grained reactivity.', relevance_score: 0.70, engine: 'stub' },
  ] as RawSearchResult[]),
};
const stubRouter = {
  fetch: vi.fn().mockResolvedValue({
    url: 'https://example.com', finalUrl: 'https://example.com',
    html: '<html><body><h1>Test</h1><p>Article content about the topic.</p></body></html>',
    contentType: 'text/html', statusCode: 200, method: 'http' as const, headers: {},
  }),
} as unknown as SmartRouter;

describe('research — local-synthesis (Phase 5b) citations carry trusted:false (4d slice-4 follow-up)', () => {
  // No vi.clearAllMocks() — the project config resets mock implementations between
  // tests, which would wipe the module-level engine mockResolvedValue → 0 sources.
  it('citations from the local-LLM synthesis path are trusted:false', async () => {
    const r = await handleResearch(
      { question: 'Compare frontend framework state management approaches', depth: 'standard' } as ResearchInput,
      [stubEngine],
      stubRouter,
    );
    expect(r.ok).toBe(true);
    const out = r.ok ? r.data : null;
    // synthesizeLocal returned indices [0,1], so EXACTLY the local-synthesis
    // constructor produced these two citations (synthesizeReport would emit one
    // per source); length 2 confirms we are on the Phase-5b path, not the fallback.
    expect(out!.citations.length).toBe(2);
    for (const c of out!.citations) {
      expect(c.trusted, `local-synthesis citation ${c.url} must carry trusted:false`).toBe(false);
    }
  });
});
