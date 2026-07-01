// Integration coverage for the adapter quality push at the
// handleSearch tool boundary.
//
// WHY: per memory `feedback_slice_brief_integration_surface`, every slice
// that changes behavior reachable from an MCP tool ships an integration
// test at the tool surface — not just an isolated module unit test. This
// file asserts that:
//   1. The lobsters User-Agent fix actually flows through the orchestrator
//      to a real fetch call (the "Lobsters returned 400" path).
//   2. The github-code WIGOLO_GITHUB_TOKEN wire-up sends Bearer auth from
//      the tool handler down to the adapter when the env var is set.
//   3. Quality-tier metadata is queryable through the orchestrator without
//      breaking the search response shape (S11c will consume it).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  _resetSearchProviderForTest,
} from '../../src/providers/search-provider.js';
import { _resetBreakersForTest } from '../../src/search/core/engine-base.js';
import {
  _resetOrchestratorVerticalsForTest,
} from '../../src/search/core/orchestrator.js';
import { handleSearch } from '../../src/tools/search.js';
import { resetConfig } from '../../src/config.js';
import {
  getNewsEngines,
  _resetNewsEnginesForTest,
} from '../../src/search/core/verticals/news.js';
import {
  getCodeEngines,
  _resetCodeEnginesForTest,
} from '../../src/search/core/verticals/code.js';
import type { SmartRouter } from '../../src/fetch/router.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface MockRoute {
  match: (url: string) => boolean;
  body?: unknown;
  text?: string;
  ok?: boolean;
  status?: number;
}

function installFetch(routes: MockRoute[]): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    const route = routes.find((r) => r.match(url));
    if (!route) {
      // No route → simulate a clean DNS-style failure so the orchestrator
      // records an outcome without exploding past the engine boundary.
      throw new Error(`no mock route for ${url}`);
    }
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      json: async () => route.body ?? {},
      text: async () => route.text ?? JSON.stringify(route.body ?? {}),
    } as Response;
  });
  return { calls, restore: () => spy.mockRestore() };
}

function fullReset(): void {
  _resetSearchProviderForTest();
  _resetOrchestratorVerticalsForTest();
  _resetBreakersForTest();
  _resetNewsEnginesForTest();
  _resetCodeEnginesForTest();
  resetConfig();
}

const fakeRouter = {} as SmartRouter;

describe('search adapter quality (S11b) — integration at handleSearch boundary', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv, WIGOLO_SEARCH: 'core', WIGOLO_RERANKER: 'none' };
    fullReset();
  });

  afterEach(() => {
    process.env = origEnv;
    fullReset();
    vi.restoreAllMocks();
  });

  it('audit: lobsters call from a category=news search sends a User-Agent header', async () => {
    // Real route the news vertical's lobsters adapter hits.
    const { calls, restore } = installFetch([
      { match: (u) => u.startsWith('https://lobste.rs/search.json'), body: [] },
      // News pool also dispatches hn-algolia and bing-news. Stub both as
      // empty 200s so the orchestrator doesn't degrade.
      { match: (u) => u.startsWith('https://hn.algolia.com/'), body: { hits: [] } },
      { match: (u) => u.startsWith('https://www.bing.com/search'), text: '<html></html>' },
    ]);
    try {
      const r = await handleSearch(
        { query: 'rust async lifetimes', category: 'news', include_content: false },
        [],
        fakeRouter,
      );
      expect(r.ok).toBe(true);
    } finally {
      restore();
    }

    const lobstersCall = calls.find((c) => c.url.startsWith('https://lobste.rs/search.json'));
    expect(lobstersCall, 'lobsters adapter should be invoked').toBeDefined();
    const ua = (lobstersCall!.init?.headers as Record<string, string> | undefined)?.['User-Agent'];
    expect(ua, 'lobsters request must carry a User-Agent to avoid 400').toBeDefined();
    expect(ua).toMatch(/wigolo/i);
  });

  it('audit: github-code call from a category=code search uses Bearer auth when WIGOLO_GITHUB_TOKEN is set', async () => {
    process.env.WIGOLO_GITHUB_TOKEN = 'ghp_integration_test';
    fullReset();

    const { calls, restore } = installFetch([
      { match: (u) => u.startsWith('https://api.github.com/search/code'), body: { items: [] } },
      // Stub the other code-vertical engines so the orchestrator stays healthy.
      { match: (u) => u.startsWith('https://api.stackexchange.com/'), body: { items: [] } },
      { match: (u) => u.startsWith('https://developer.mozilla.org/api/v1/search'), body: { documents: [] } },
      { match: (u) => u.startsWith('https://lite.duckduckgo.com/'), text: '<html></html>' },
    ]);
    try {
      const r = await handleSearch(
        { query: 'rust tokio select macro', category: 'code', include_content: false },
        [],
        fakeRouter,
      );
      expect(r.ok).toBe(true);
    } finally {
      restore();
    }

    const ghCall = calls.find((c) => c.url.startsWith('https://api.github.com/search/code'));
    expect(ghCall, 'github-code adapter should be invoked').toBeDefined();
    const headers = ghCall!.init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe('Bearer ghp_integration_test');
  });

  it('quality tier metadata is present on every registered engine entry exposed to the orchestrator', () => {
    // Sanity check at the registry boundary (not the request boundary). The
    // orchestrator reads engine entries via the per-vertical getters; if a
    // future contributor lands a new entry without a quality tier, S11c's
    // RRF tuning will silently fall back to 'medium' for that engine and
    // miss the intended weighting.
    const newsEntries = getNewsEngines();
    expect(newsEntries.length).toBeGreaterThan(0);
    for (const e of newsEntries) expect(e.quality).toBeDefined();

    const codeEntries = getCodeEngines();
    expect(codeEntries.length).toBeGreaterThan(0);
    for (const e of codeEntries) expect(e.quality).toBeDefined();
  });
});
