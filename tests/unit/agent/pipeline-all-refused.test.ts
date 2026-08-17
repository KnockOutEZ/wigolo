import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgentPipeline } from '../../../src/agent/pipeline.js';
import type { SearchEngine, RawSearchResult, AgentInput, StageError } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

// WHY: `pipeline.ts` carries a warning written for exactly the all-fetches-failed case:
//
//   sources.length > 0 && pagesFetched === 0 ? `fetch failed for all …` : undefined
//
// It was DEAD for the most common way a run comes back empty. `pagesFetched` counts sources
// with `fetched: true`, and a refused fetch is RETURNED by the router rather than thrown — so
// it skipped the catch block that sets `fetched: false` and was counted as a success. On a
// fully blocked run `pagesFetched === sources.length`, the guard was never true, and the
// warning built for this case never fired.
//
// Marking refusals `fetched: false` is what revives it. These tests assert the revival
// directly, because "it should fire now" is a prediction until something runs it.

const BLOCKED: StageError = {
  error: 'blocked_by_challenge',
  error_reason: 'Bot protection challenge was not cleared',
  stage: 'fetch',
  http_status: 403,
};

const results: RawSearchResult[] = [
  { title: 'CRM Pricing', url: 'https://example.com/crm-pricing', snippet: 'CRM pricing comparison', relevance_score: 0.95, engine: 'stub' },
  { title: 'Best CRM 2025', url: 'https://example.com/best-crm', snippet: 'Top CRM tools', relevance_score: 0.88, engine: 'stub' },
];

function stubEngine(): SearchEngine {
  return { name: 'stub', search: vi.fn().mockResolvedValue(results) } as unknown as SearchEngine;
}

function blockingRouter(): SmartRouter {
  return { fetch: vi.fn(async () => BLOCKED) } as unknown as SmartRouter;
}

function workingRouter(): SmartRouter {
  return {
    fetch: vi.fn(async (url: string) => ({
      url,
      finalUrl: url,
      html: '<html><body><h1>Title</h1><p>Content about pricing and features.</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    })),
  } as unknown as SmartRouter;
}

beforeEach(() => vi.clearAllMocks());

describe('agent pipeline — the all-failed warning fires when every page is refused', () => {
  const input: AgentInput = { prompt: 'Find pricing for top CRM tools' };

  it('reports pages_fetched 0 rather than counting refusals as fetched', async () => {
    const result = await runAgentPipeline(input, [stubEngine()], blockingRouter());

    expect(result.sources.length).toBeGreaterThan(0);
    // The premise the warning is gated on. If this regresses, the warning silently dies again.
    expect(result.pages_fetched).toBe(0);
  });

  it('emits the warning — it could not fire at all before refusals were counted honestly', async () => {
    const result = await runAgentPipeline(input, [stubEngine()], blockingRouter());

    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('fetch failed for all');
  });

  it('states the refusal cause in the fetch step rather than a bare shortfall', async () => {
    const result = await runAgentPipeline(input, [stubEngine()], blockingRouter());

    const fetchStep = result.steps.find((s) => s.action === 'fetch');
    expect(fetchStep?.detail).toContain('Fetched 0/');
    expect(fetchStep?.detail).toContain('blocked_by_challenge');
  });

  it('does NOT warn on a healthy run — the guard must stay specific to total failure', async () => {
    // Reviving a dead guard is only a win if it stays off in the ordinary case.
    const result = await runAgentPipeline(input, [stubEngine()], workingRouter());

    expect(result.pages_fetched).toBeGreaterThan(0);
    expect(result.warning).toBeUndefined();
  });
});
