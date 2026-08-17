import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, StageError, ContentCompleteness } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import type { AgentPlan } from '../../../src/agent/planner.js';

// WHY: the agent's step log is the only place it tells a user what happened to the pages it
// tried, and `fetched` is the field that log counts. A refused fetch is RETURNED by the router,
// not thrown, so it missed the catch block that sets `fetched: false` and took the success path
// instead — arriving as a source marked fetched with empty content.
//
// The consequence was not "nothing surfaced it". It was worse: the agent affirmatively reported
// "Fetched 5/5 pages" for five pages it never got, and the all-failed warning in pipeline.ts —
// written for exactly this case — could not fire, because it is gated on `pages_fetched === 0`.

const extractMock = vi.fn();
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({ name: 'v1' as const, extract: extractMock })),
  _resetExtractProviderForTest: vi.fn(),
}));

vi.mock('../../../src/cache/store.js', () => ({
  cacheContent: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url),
}));

const { executeAgentPlan } = await import('../../../src/agent/executor.js');

const BLOCKED: StageError = {
  error: 'blocked_by_challenge',
  error_reason: 'Bot protection challenge was not cleared',
  stage: 'fetch',
  http_status: 403,
};

function stubEngine(): SearchEngine {
  return { name: 'stub', search: vi.fn().mockResolvedValue([]) } as unknown as SearchEngine;
}

function routerReturning(fn: (url: string) => unknown): SmartRouter {
  return { fetch: vi.fn(async (url: string) => fn(url)) } as unknown as SmartRouter;
}

function okRaw(url: string, completeness?: ContentCompleteness) {
  return {
    url,
    finalUrl: url,
    html: '<html><body><p>Real page content for testing.</p></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: completeness ? ('browser' as const) : ('http' as const),
    headers: {},
    ...(completeness ? { contentCompleteness: completeness } : {}),
  };
}

function planFor(urls: string[]): AgentPlan {
  return { searches: [], urls, reasoning: 'test' } as unknown as AgentPlan;
}

const BUDGET = { deadlineMs: Date.now() + 60000, maxPages: 10 };

beforeEach(() => {
  vi.clearAllMocks();
  extractMock.mockResolvedValue({
    title: 'Extracted Title',
    markdown: '# Content\n\nPage content for testing.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  });
});

describe('agent executor — a refused page is not reported as fetched', () => {
  it('marks a refused source fetched:false with the stage CODE as the reason', async () => {
    const router = routerReturning(() => BLOCKED);
    const { sources } = await executeAgentPlan(
      planFor(['https://blocked.example.com/a']),
      [stubEngine()],
      router,
      BUDGET,
    );

    // `fetched` is what the step log, `pages_fetched`, and the all-failed warning all count.
    // If it were true here, every one of them would report a success that did not happen.
    expect(sources[0].fetched).toBe(false);
    // The bare code, so a caller can branch on it rather than parse prose.
    expect(sources[0].fetch_error).toBe('blocked_by_challenge');
    expect(sources[0].markdown_content).toBe('');
  });

  it('the user-visible step log reports 0/5 when all five were refused', async () => {
    // The exact regression: this step said "Fetched 5/5 pages" for five blocked pages.
    const urls = Array.from({ length: 5 }, (_, i) => `https://blocked.example.com/${i}`);
    const router = routerReturning(() => BLOCKED);
    const { steps } = await executeAgentPlan(planFor(urls), [stubEngine()], router, BUDGET);

    const fetchStep = steps.find((s) => s.action === 'fetch');
    expect(fetchStep?.detail).toContain('Fetched 0/5 pages');
    // And it names the cause, so a wall reads differently from an outage.
    expect(fetchStep?.detail).toContain('blocked_by_challenge');
  });

  it('counts only the pages actually retrieved in a mixed run', async () => {
    const router = routerReturning((url) => (url.includes('/blocked') ? BLOCKED : okRaw(url)));
    const { steps, sources } = await executeAgentPlan(
      planFor([
        'https://a.example.com/blocked',
        'https://b.example.com/ok',
        'https://c.example.com/ok2',
      ]),
      [stubEngine()],
      router,
      BUDGET,
    );

    expect(steps.find((s) => s.action === 'fetch')?.detail).toContain('Fetched 2/3 pages');
    expect(sources.filter((s) => s.fetched).length).toBe(2);
  });

  it('keeps a refusal distinguishable from a thrown transport failure', async () => {
    const router = routerReturning((url) => {
      if (url.includes('/blocked')) return BLOCKED;
      throw new Error('fetch timeout');
    });
    const { sources } = await executeAgentPlan(
      planFor(['https://a.example.com/blocked', 'https://b.example.com/slow']),
      [stubEngine()],
      router,
      BUDGET,
    );

    const byUrl = new Map(sources.map((s) => [s.url, s]));
    expect(byUrl.get('https://a.example.com/blocked')?.fetch_error).toBe('blocked_by_challenge');
    expect(byUrl.get('https://b.example.com/slow')?.fetch_error).toBe('fetch timeout');
  });
});

describe('agent executor — shell captures are excluded like research already excludes them', () => {
  it('excludes an explicitly shell-labeled capture from the source content', async () => {
    // An undetected bot wall is not a stage error — it is an ordinary 200 whose content never
    // rendered. Research refuses to cite these; before this the agent fed the wall's own text
    // into synthesis as page content.
    const router = routerReturning((url) =>
      okRaw(url, { level: 'shell', reason: 'app_shell', settled_by: 'budget' }),
    );
    const { sources, steps } = await executeAgentPlan(
      planFor(['https://wall.example.com/a']),
      [stubEngine()],
      router,
      BUDGET,
    );

    expect(sources[0].fetched).toBe(false);
    expect(sources[0].fetch_error).toBe('shell-content');
    expect(sources[0].markdown_content).toBe('');
    expect(steps.find((s) => s.action === 'fetch')?.detail).toContain('Fetched 0/1 pages');
  });

  it('does NOT exclude an UNLABELED capture — a missing verdict is not a shell verdict', async () => {
    // The over-tightening risk. The HTTP and TLS tiers never produce a render verdict at all,
    // so treating "no label" as "shell" would silently exclude most of what wigolo fetches.
    const router = routerReturning((url) => okRaw(url));
    const { sources } = await executeAgentPlan(
      planFor(['https://plain.example.com/a']),
      [stubEngine()],
      router,
      BUDGET,
    );

    expect(sources[0].fetched).toBe(true);
    expect(sources[0].markdown_content).toContain('Page content');
  });

  it('does NOT exclude a partial capture — partial is a real page that lost part of itself', async () => {
    const router = routerReturning((url) =>
      okRaw(url, { level: 'partial', reason: 'thin_content', settled_by: 'stability' }),
    );
    const { sources } = await executeAgentPlan(
      planFor(['https://thin.example.com/a']),
      [stubEngine()],
      router,
      BUDGET,
    );

    expect(sources[0].fetched).toBe(true);
  });

  it('does NOT exclude a full capture', async () => {
    const router = routerReturning((url) =>
      okRaw(url, { level: 'full', reason: 'content_verified', settled_by: 'probe' }),
    );
    const { sources } = await executeAgentPlan(
      planFor(['https://good.example.com/a']),
      [stubEngine()],
      router,
      BUDGET,
    );

    expect(sources[0].fetched).toBe(true);
  });
});
