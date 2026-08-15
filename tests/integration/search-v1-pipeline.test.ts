import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getSearchProvider,
  _resetSearchProviderForTest,
  type SearchContext,
} from '../../src/providers/search-provider.js';
import { CoreSearchProvider } from '../../src/search/core/core-provider.js';
import { _resetBreakersForTest } from '../../src/search/core/engine-base.js';
import { _resetOrchestratorVerticalsForTest } from '../../src/search/core/orchestrator.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import type { SearchInput } from '../../src/types.js';
import { resetConfig } from '../../src/config.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function mockCtx(): SearchContext {
  return {
    engines: [],
    router: {} as SmartRouter,
  };
}

const HN_HIT = {
  objectID: '1',
  title: 'HN story',
  url: 'https://hn.example.test/a',
  story_text: null,
  points: 10,
  num_comments: 3,
  created_at_i: 1700000000,
};

const GH_ITEM = {
  name: 'foo.ts',
  path: 'src/foo.ts',
  html_url: 'https://github.example.test/foo',
  repository: { full_name: 'acme/foo', description: 'tooling' },
};

const SO_ITEM = {
  title: 'How to async iterator',
  link: 'https://stackoverflow.example.test/q/1',
  body: '<p>answer body</p>',
  creation_date: 1700000000,
};

const BING_HTML = `<html><body>
  <li class="b_algo">
    <h2><a href="https://bing.example.test/a">Result A</a></h2>
    <div class="b_caption"><p>snippet A</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://bing.example.test/b">Result B</a></h2>
    <div class="b_caption"><p>snippet B</p></div>
  </li>
</body></html>`;

const DDG_HTML = `<html><body>
  <a class="result-link" href="https://ddg.example.test/a">DDG A</a>
  <div class="result-snippet">ddg snippet A</div>
</body></html>`;

// Wikipedia opensearch shape: [query, titles[], snippets[], urls[]]. A real
// general-pool engine standing in for the removed wiby long-tail signal.
const WIKI_JSON: unknown[] = [
  'cute cats',
  ['Cat'],
  ['The cat is a domestic species.'],
  ['https://en.wikipedia.org/wiki/Cat'],
];

interface RouteSpec {
  // substring match against the request URL
  match: (url: string) => boolean;
  body?: unknown;
  text?: string;
  ok?: boolean;
  status?: number;
}

function installFetchRoutes(routes: RouteSpec[]): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    calls.push({ url, init });
    const route = routes.find((r) => r.match(url));
    if (!route) {
      // No match: simulate a network failure so the orchestrator records it
      // without throwing past the engine boundary.
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
  resetConfig();
}

describe('search v1 pipeline — factory + provider integration', () => {
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

  it('factory resolves to CoreSearchProvider when WIGOLO_SEARCH=v1', async () => {
    const provider = await getSearchProvider();
    expect(provider).toBeInstanceOf(CoreSearchProvider);
    expect(provider.name).toBe('core');
  });

  it('runs a general-vertical query and returns populated results via factory', async () => {
    installFetchRoutes([
      { match: (u) => u.includes('bing.com/search'), text: BING_HTML },
      { match: (u) => u.includes('lite.duckduckgo.com'), text: DDG_HTML },
      { match: (u) => u.includes('wikipedia.org'), body: WIKI_JSON },
    ]);

    const provider = await getSearchProvider();
    const input: SearchInput = { query: 'cute cats', max_results: 5 };
    const result = await provider.search(input, mockCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.query).toBe('cute cats');
    expect(result.data.results.length).toBeGreaterThan(0);
    expect(result.data.engines_used.length).toBeGreaterThan(0);
    // engines_used should be a subset of the general pool's mocked engines.
    // wiby was removed; the unmocked pool members (mojeek/marginalia)
    // simply fail their fetch and never enter engines_used.
    for (const name of result.data.engines_used) {
      expect(['bing', 'duckduckgo', 'wikipedia']).toContain(name);
    }
    expect(typeof result.data.total_time_ms).toBe('number');
  });

  it('routes category=code to the code vertical engines (github + stackoverflow)', async () => {
    const { calls } = installFetchRoutes([
      { match: (u) => u.includes('api.github.com/search/code'), body: { items: [GH_ITEM] } },
      { match: (u) => u.includes('api.stackexchange.com'), body: { items: [SO_ITEM] } },
      // Defensive: if any general-vertical engine slips through, fail loudly.
      { match: (u) => u.includes('bing.com'), text: BING_HTML },
      { match: (u) => u.includes('duckduckgo.com'), text: DDG_HTML },
      { match: (u) => u.includes('wikipedia.org'), body: [] },
    ]);

    const provider = await getSearchProvider();
    const input: SearchInput = {
      query: 'something generic',
      category: 'code',
      max_results: 5,
    };
    const result = await provider.search(input, mockCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hitGithub = calls.some((c) => c.url.includes('api.github.com/search/code'));
    const hitSo = calls.some((c) => c.url.includes('api.stackexchange.com'));
    const hitBing = calls.some((c) => c.url.includes('bing.com'));
    expect(hitGithub).toBe(true);
    expect(hitSo).toBe(true);
    expect(hitBing).toBe(false);

    const used = result.data.engines_used.sort();
    expect(used).toContain('github-code');
    expect(used).toContain('stackoverflow');
    expect(used).not.toContain('bing');
  });

  it('returns ok:false invalid_input for an empty query', async () => {
    const provider = await getSearchProvider();
    const result = await provider.search({ query: '   ' }, mockCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('invalid_input');
    expect(result.stage).toBe('search');
  });

  it('threads from_date through to the HN Algolia engine as numericFilters', async () => {
    const { calls } = installFetchRoutes([
      { match: (u) => u.includes('hn.algolia.com'), body: { hits: [HN_HIT] } },
      // A date bound no longer filters out
      // the date-naive news engines. They still run and contribute recall —
      // their results are freshness-filtered client-side. Provide routes so
      // they don't blow up the test; the assertion below confirms Lobsters is
      // now dispatched (was previously skipped under a date bound).
      { match: (u) => u.includes('lobste.rs'), body: [] },
      { match: (u) => u.includes('lite.duckduckgo.com'), text: DDG_HTML },
      { match: (u) => u.includes('mojeek.com'), text: '<html></html>' },
      { match: (u) => u.includes('bing.com'), text: BING_HTML },
    ]);

    const provider = await getSearchProvider();
    const input: SearchInput = {
      query: 'latest AI breakthroughs',
      from_date: '2024-01-01',
      max_results: 5,
    };
    const result = await provider.search(input, mockCtx());
    expect(result.ok).toBe(true);

    // The date-aware engine still receives the server-side date filter.
    const hnCall = calls.find((c) => c.url.includes('hn.algolia.com'));
    expect(hnCall).toBeDefined();
    expect(hnCall!.url).toContain('numericFilters=');

    // The date-naive engine is now dispatched too (recall fix) rather than
    // being silently dropped the moment a date-aware engine exists.
    const lobstersCall = calls.find((c) => c.url.includes('lobste.rs'));
    expect(lobstersCall).toBeDefined();
  });

  it('returns degraded warning when every engine fails', async () => {
    installFetchRoutes([
      { match: () => true, ok: false, status: 500, body: {} },
    ]);

    const provider = await getSearchProvider();
    const result = await provider.search({ query: 'foo bar baz' }, mockCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results).toEqual([]);
    expect(result.data.engines_used).toEqual([]);
    expect(result.data.warning).toBe('all engines failed or no results');
  });

  // The live defect: engines returned 18 results, include_domains dropped all
  // of them, and the caller was told the engine pool had failed — sending them
  // to retry/backoff when the actual fix was to widen the scope.
  it('blames include_domains, not the engines, when scoping empties a healthy result set', async () => {
    installFetchRoutes([
      { match: (u) => u.includes('bing.com'), text: BING_HTML },
      { match: (u) => u.includes('duckduckgo.com'), text: DDG_HTML },
      { match: (u) => u.includes('wikipedia.org'), body: WIKI_JSON },
      { match: () => true, body: {} },
    ]);

    const provider = await getSearchProvider();
    const result = await provider.search(
      { query: 'foo bar baz', include_domains: ['nothing-matches.example'] },
      mockCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results).toEqual([]);
    expect(result.data.warning).not.toBe('all engines failed or no results');
    expect(result.data.warning).toContain('nothing-matches.example');
    expect(result.data.warning).toContain('include_domains');
    // Structured companion so an agent can act without parsing prose.
    expect(result.data.domain_filter?.include_domains).toEqual(['nothing-matches.example']);
    expect(result.data.domain_filter!.candidates).toBeGreaterThan(0);
    expect(result.data.domain_filter!.matched).toBe(0);
  });

  // NEGATIVE must-not-fire: include_domains is set AND the response is empty,
  // but the engines genuinely died. A query-wide "scope set + empty" gate would
  // wrongly blame the scope here; the per-result tally has zero candidates, so
  // the engine-failure wording must survive.
  it('still reports engine failure when every engine fails WITH include_domains set', async () => {
    installFetchRoutes([
      { match: () => true, ok: false, status: 500, body: {} },
    ]);

    const provider = await getSearchProvider();
    const result = await provider.search(
      { query: 'foo bar baz', include_domains: ['bing.example.test'] },
      mockCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results).toEqual([]);
    expect(result.data.warning).toBe('all engines failed or no results');
    expect(result.data.domain_filter).toBeUndefined();
  });

  // The recovery wave pulls in probe-only engines AFTER the first domain tally
  // is taken. If the tally is not re-derived, it describes a candidate set that
  // no longer exists — and the cause it produces is not merely stale but
  // FALSE: it tells the caller nothing was on their domain while on-domain
  // results were in fact returned and dropped by a LATER filter. A vague
  // message is recoverable; a confident wrong one sends them to the wrong fix.
  it('does not blame the domain scope for results the recovery wave put on-domain', async () => {
    // 3 on-domain hits whose title+snippet deliberately lack the query phrase,
    // so the exact-phrase filter — which runs AFTER the whitelist — empties the
    // response. The whitelist is therefore innocent.
    const MOJEEK_ON_DOMAIN = `<html><body><ul class="results-standard">
      <li><a class="title" href="https://target.example.test/1">Alpha</a><p class="s">first</p></li>
      <li><a class="title" href="https://target.example.test/2">Beta</a><p class="s">second</p></li>
      <li><a class="title" href="https://target.example.test/3">Gamma</a><p class="s">third</p></li>
    </ul></body></html>`;

    installFetchRoutes([
      // Healthy but entirely off-domain: the only survivor of the primary wave.
      { match: (u) => u.includes('bing.com'), text: BING_HTML },
      // Collapse the rest of the primary wave to trip the recovery floor.
      { match: (u) => u.includes('duckduckgo.com'), ok: false, status: 500, body: {} },
      { match: (u) => u.includes('wikipedia.org'), ok: false, status: 500, body: {} },
      { match: (u) => u.includes('marginalia'), ok: false, status: 500, body: {} },
      // Probe-only engine, reachable ONLY via the recovery wave.
      { match: (u) => u.includes('mojeek.com'), text: MOJEEK_ON_DOMAIN },
      { match: () => true, ok: false, status: 500, body: {} },
    ]);

    const provider = await getSearchProvider();
    const result = await provider.search(
      {
        query: 'zzqq unique phrase token',
        include_domains: ['target.example.test'],
        exact_match: true,
      },
      mockCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.results).toEqual([]);
    // The scope matched 3 results, so it cannot be the cause. Asserting on the
    // CAUSE, not the wording: no domain_filter may be emitted at all.
    expect(result.data.domain_filter).toBeUndefined();
    expect(result.data.warning ?? '').not.toContain('domain scoping');
  });

  // A filter-emptied response has no sources, so synthesis ALWAYS fails on
  // this path — meaning format='answer' would overwrite the scoping cause with
  // 'synthesis failed' 100% of the time, pointing the caller at the language
  // model instead of their own scope. The cause must survive the format.
  it('keeps the domain-scoping cause when synthesis fails in format=answer', async () => {
    installFetchRoutes([
      { match: (u) => u.includes('bing.com'), text: BING_HTML },
      { match: (u) => u.includes('duckduckgo.com'), text: DDG_HTML },
      { match: (u) => u.includes('wikipedia.org'), body: WIKI_JSON },
      { match: () => true, body: {} },
    ]);

    const provider = await getSearchProvider();
    const result = await provider.search(
      {
        query: 'foo bar baz',
        include_domains: ['nothing-matches.example'],
        format: 'answer',
      },
      mockCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.warning).toContain('nothing-matches.example');
    // The synthesis failure is real and still worth reporting — it must be
    // composed with the cause, not substituted for it.
    expect(result.data.warning).toContain('synthesis failed');
    // And the structured companion must not be left orphaned by a warning
    // that no longer mentions the scope.
    expect(result.data.domain_filter?.matched).toBe(0);
  });

  it('honors max_results by truncating fused output', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      `<li class="b_algo"><h2><a href="https://bing.example.test/${i}">R${i}</a></h2><div class="b_caption"><p>s${i}</p></div></li>`,
    ).join('');
    installFetchRoutes([
      { match: (u) => u.includes('bing.com'), text: `<html><body>${many}</body></html>` },
      { match: (u) => u.includes('duckduckgo.com'), text: '<html></html>' },
      { match: (u) => u.includes('wikipedia.org'), body: [] },
    ]);

    const provider = await getSearchProvider();
    const result = await provider.search({ query: 'general query', max_results: 3 }, mockCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results.length).toBeLessThanOrEqual(3);
  });
});
