import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawSearchResult } from '../../../../src/types.js';

const runV1Search = vi.fn();
vi.mock('../../../../src/search/core/orchestrator.js', () => ({ runV1Search }));
vi.mock('../../../../src/search/content-fetch.js', () => ({ fetchContentForResults: vi.fn(async () => {}) }));

const { CoreSearchProvider } = await import('../../../../src/search/core/core-provider.js');

function dispatch(url: string): { results: RawSearchResult[]; enginesUsed: string[]; outcomes: []; degraded: boolean } {
  return {
    results: [{ title: url, url, snippet: 's', relevance_score: 1, engine: 'e1' }],
    enginesUsed: ['e1'], outcomes: [], degraded: false,
  };
}

describe('core-provider brand/lexical-collision dual-dispatch', () => {
  beforeEach(() => { runV1Search.mockReset(); });

  it('auto-dispatches the top rewrite for a single-token dev-term lexical collision (useState)', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'useState', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    // primary + 1 collision-rewrite variant, dispatched concurrently.
    expect(runV1Search).toHaveBeenCalledTimes(2);
    const variantArg = runV1Search.mock.calls[1][0].query as string;
    // The rewrite must anchor the dev term (detectLexicalCollision's top rewrite).
    expect(variantArg.toLowerCase()).toContain('usestate');
    expect(variantArg).not.toBe('useState');
    // and it is auditable in queries_executed.
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.queries_executed).toBeDefined();
    expect(out.data.queries_executed!.some((q) => q !== 'useState' && q.toLowerCase().includes('usestate'))).toBe(true);
  });

  it('auto-dispatches the top rewrite for a short common-noun brand collision (next)', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'next', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(runV1Search).toHaveBeenCalledTimes(2);
    const variantArg = runV1Search.mock.calls[1][0].query as string;
    // "next" → top suggested rewrite is "Next.js framework".
    expect(variantArg).toMatch(/Next\.js/);
  });

  it('does NOT fire a collision variant for a plain multi-word query', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'best coffee maker', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(runV1Search).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire a collision variant for a unique made-up single token', async () => {
    // No digit suffix / hyphen / underscore, so no rare-term compound variant
    // either — this isolates the collision-variant gate.
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'zqwxplover', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(runV1Search).toHaveBeenCalledTimes(1);
  });

  // Over-fire guard: library/tool lexicon terms are warning-only. The
  // "<term> React hook" rewrite is nonsense for them (docker/vite/prisma are
  // not React hooks), so auto-dispatching it would RRF-merge React-hooks docs
  // into a clean tool query — actively harmful. They must NOT dual-dispatch.
  it('does NOT auto-dispatch a "React hook" rewrite for a library/tool term (docker)', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'docker', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(runV1Search).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Single query only — no "docker React hook" variant.
    expect(out.data.queries_executed).toEqual(['docker']);
  });

  it('does NOT auto-dispatch a "React hook" rewrite for a build-tool term (vite)', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'vite', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(runV1Search).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.queries_executed).toEqual(['vite']);
  });

  it('does NOT auto-dispatch a "React hook" rewrite for an ORM term (prisma)', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'prisma', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(runV1Search).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.queries_executed).toEqual(['prisma']);
  });

  it('does NOT double-dispatch when the entity-collision variant already fires', async () => {
    // "Phoenix framework deployment" already dual-dispatches via the entity
    // variant. The new collision variant must not stack a THIRD dispatch.
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'Phoenix framework deployment', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    // primary + entity variant only — exactly two, not three.
    expect(runV1Search).toHaveBeenCalledTimes(2);
  });

  it('does NOT fire a collision variant when error-intent owns the query', async () => {
    // Error-intent queries must stay on the bare-token recall lever; a
    // collision rewrite would anchor the wrong head.
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'ERR_MODULE_NOT_FOUND', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    // The error-token variant equals the whole query here, so no extra dispatch
    // from error-intent; and no collision variant either.
    expect(runV1Search).toHaveBeenCalledTimes(1);
  });
});
