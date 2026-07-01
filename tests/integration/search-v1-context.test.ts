import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getSearchProvider,
  _resetSearchProviderForTest,
  type SearchContext,
} from '../../src/providers/search-provider.js';
import { _resetBreakersForTest } from '../../src/search/core/engine-base.js';
import { _resetOrchestratorVerticalsForTest } from '../../src/search/core/orchestrator.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import type { SearchInput } from '../../src/types.js';
import type { EmbedProvider } from '../../src/providers/embed-provider.js';
import { resetConfig } from '../../src/config.js';

interface MockEmbedState {
  provider: EmbedProvider | null;
  error: Error | null;
}
const embedState: MockEmbedState = { provider: null, error: null };

vi.mock('../../src/providers/embed-provider.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/providers/embed-provider.js')
  >('../../src/providers/embed-provider.js');
  return {
    ...actual,
    getEmbedProvider: vi.fn(async () => {
      if (embedState.error) throw embedState.error;
      if (!embedState.provider) throw new Error('no provider');
      return embedState.provider;
    }),
  };
});

function mockCtx(): SearchContext {
  return { engines: [], router: {} as SmartRouter };
}

interface RouteSpec {
  match: (url: string) => boolean;
  text?: string;
  body?: unknown;
  ok?: boolean;
  status?: number;
}

function installFetchRoutes(routes: RouteSpec[]): { restore: () => void } {
  const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const route = routes.find((r) => r.match(url));
    if (!route) throw new Error(`no mock route for ${url}`);
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      json: async () => route.body ?? {},
      text: async () => route.text ?? JSON.stringify(route.body ?? {}),
    } as Response;
  });
  return { restore: () => spy.mockRestore() };
}

// Two distinct results, each at rank 1 of a different engine, so their base
// relevance_score (engine position-derived) is identical (1.0). The fused RRF
// contribution is the same. Context rank multiplier alone decides ordering.
const BING_HTML = `<html><body>
  <li class="b_algo">
    <h2><a href="https://example-a.test/page">React Hooks Guide</a></h2>
    <div class="b_caption"><p>Comprehensive guide to React hooks.</p></div>
  </li>
</body></html>`;
const DDG_HTML = `<html><body>
  <a class="result-link" href="https://example-b.test/page">Vue Composition API</a>
  <div class="result-snippet">Reference for the Vue composition API.</div>
</body></html>`;
// Defensive empty route for the general pool's authoritative engine
// (Wikipedia opensearch). The wiby long-tail engine was removed; this
// keeps an extra general-pool route present without contributing results.
const WIKI_EMPTY: unknown[] = [];

function makeBiasedProvider(targetUrl: string): EmbedProvider {
  // Target vector aligns with query [1,0,0]; non-target is anti-aligned [-1,0,0]
  // so the multiplier gap (1.2 vs 0.8) is large enough to overcome RRF rank gap.
  return {
    embed: async (texts: string[]) => {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        if (i === 0) {
          out.push(Float32Array.from([1, 0, 0]));
        } else if (
          (targetUrl.includes('example-a') && t.includes('React Hooks')) ||
          (targetUrl.includes('example-b') && t.includes('Vue Composition'))
        ) {
          out.push(Float32Array.from([1, 0, 0]));
        } else {
          out.push(Float32Array.from([-1, 0, 0]));
        }
      }
      return out;
    },
    dim: 3,
    modelId: 'test',
  };
}

function fullReset(): void {
  _resetSearchProviderForTest();
  _resetOrchestratorVerticalsForTest();
  _resetBreakersForTest();
  resetConfig();
  embedState.provider = null;
  embedState.error = null;
}

describe('search v1 — agent_context integration', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.WIGOLO_SEARCH;
    process.env.WIGOLO_SEARCH = 'v1';
    fullReset();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WIGOLO_SEARCH;
    else process.env.WIGOLO_SEARCH = originalEnv;
    fullReset();
    vi.restoreAllMocks();
  });

  it('agent_context.text moves the contextually-aligned result to the top', async () => {
    installFetchRoutes([
      { match: (u) => u.includes('bing.com/search'), text: BING_HTML },
      { match: (u) => u.includes('lite.duckduckgo.com'), text: DDG_HTML },
      { match: (u) => u.includes('wikipedia.org'), body: WIKI_EMPTY },
    ]);
    // Bias toward example-b (Vue) — would normally lose to example-a (first in HTML).
    embedState.provider = makeBiasedProvider('https://example-b.test/page');

    const provider = await getSearchProvider();
    const input: SearchInput = {
      query: 'frontend frameworks',
      max_results: 5,
      agent_context: { text: 'I am writing a Vue 3 composition API component' },
    };
    const result = await provider.search(input, mockCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results.length).toBeGreaterThan(0);
    expect(result.data.results[0].url).toBe('https://example-b.test/page');
  });

  it('agent_context.recent_urls drops a matching result', async () => {
    installFetchRoutes([
      { match: (u) => u.includes('bing.com/search'), text: BING_HTML },
      { match: (u) => u.includes('lite.duckduckgo.com'), text: DDG_HTML },
      { match: (u) => u.includes('wikipedia.org'), body: WIKI_EMPTY },
    ]);

    const provider = await getSearchProvider();
    const input: SearchInput = {
      query: 'frontend frameworks',
      max_results: 5,
      agent_context: { recent_urls: ['https://example-a.test/page'] },
    };
    const result = await provider.search(input, mockCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const urls = result.data.results.map((r) => r.url);
    expect(urls).not.toContain('https://example-a.test/page');
    expect(urls).toContain('https://example-b.test/page');
  });

  it('combined text + recent_urls applies both effects', async () => {
    installFetchRoutes([
      { match: (u) => u.includes('bing.com/search'), text: BING_HTML },
      { match: (u) => u.includes('lite.duckduckgo.com'), text: DDG_HTML },
      { match: (u) => u.includes('wikipedia.org'), body: WIKI_EMPTY },
    ]);
    // Bias toward example-a (React) — but recent_urls will drop it,
    // leaving example-b as the sole result.
    embedState.provider = makeBiasedProvider('https://example-a.test/page');

    const provider = await getSearchProvider();
    const input: SearchInput = {
      query: 'frontend frameworks',
      max_results: 5,
      agent_context: {
        text: 'React hooks examples',
        recent_urls: ['https://example-a.test/page'],
      },
    };
    const result = await provider.search(input, mockCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const urls = result.data.results.map((r) => r.url);
    expect(urls).not.toContain('https://example-a.test/page');
    expect(urls).toContain('https://example-b.test/page');
  });

  it('omitting agent_context preserves Phase 7 behavior (no embed call)', async () => {
    installFetchRoutes([
      { match: (u) => u.includes('bing.com/search'), text: BING_HTML },
      { match: (u) => u.includes('lite.duckduckgo.com'), text: DDG_HTML },
      { match: (u) => u.includes('wikipedia.org'), body: WIKI_EMPTY },
    ]);
    // Embed provider intentionally unavailable — should never be hit.
    embedState.error = new Error('should not be called');

    const provider = await getSearchProvider();
    const input: SearchInput = { query: 'frontend frameworks', max_results: 5 };
    const result = await provider.search(input, mockCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results.length).toBeGreaterThan(0);
  });

  it('embedding failure with agent_context.text leaves results intact', async () => {
    installFetchRoutes([
      { match: (u) => u.includes('bing.com/search'), text: BING_HTML },
      { match: (u) => u.includes('lite.duckduckgo.com'), text: DDG_HTML },
      { match: (u) => u.includes('wikipedia.org'), body: WIKI_EMPTY },
    ]);
    embedState.error = new Error('embed offline');

    const provider = await getSearchProvider();
    const input: SearchInput = {
      query: 'frontend frameworks',
      max_results: 5,
      agent_context: { text: 'anything' },
    };
    const result = await provider.search(input, mockCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results.length).toBeGreaterThan(0);
  });

  it('agent_context.intent used as fallback when text omitted', async () => {
    installFetchRoutes([
      { match: (u) => u.includes('bing.com/search'), text: BING_HTML },
      { match: (u) => u.includes('lite.duckduckgo.com'), text: DDG_HTML },
      { match: (u) => u.includes('wikipedia.org'), body: WIKI_EMPTY },
    ]);
    embedState.provider = makeBiasedProvider('https://example-b.test/page');

    const provider = await getSearchProvider();
    const input: SearchInput = {
      query: 'frontend frameworks',
      max_results: 5,
      agent_context: { intent: 'Working on a Vue project' },
    };
    const result = await provider.search(input, mockCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results[0].url).toBe('https://example-b.test/page');
  });
});
