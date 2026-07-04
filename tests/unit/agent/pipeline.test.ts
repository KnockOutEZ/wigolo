import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgentPipeline } from '../../../src/agent/pipeline.js';
import type { SearchEngine, RawSearchResult, AgentInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

function createStubEngine(results: RawSearchResult[] = []): SearchEngine {
  return {
    name: 'stub',
    search: vi.fn().mockResolvedValue(results),
  };
}

function createStubRouter(): SmartRouter {
  return {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html: '<html><body><h1>Title</h1><p>Content about pricing and features.</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;
}

const defaultResults: RawSearchResult[] = [
  { title: 'CRM Pricing', url: 'https://example.com/crm-pricing', snippet: 'CRM pricing comparison', relevance_score: 0.95, engine: 'stub' },
  { title: 'Best CRM 2025', url: 'https://example.com/best-crm', snippet: 'Top CRM tools', relevance_score: 0.88, engine: 'stub' },
];

describe('runAgentPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs full pipeline: plan -> execute -> synthesize', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find pricing for top CRM tools' };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.result).toBeDefined();
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.pages_fetched).toBeGreaterThan(0);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.sampling_supported).toBe('boolean');
    expect(result.error).toBeUndefined();
  });

  it('includes plan step in steps array', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find data' };

    const result = await runAgentPipeline(input, [engine], router);

    const planStep = result.steps.find((s) => s.action === 'plan');
    expect(planStep).toBeDefined();
    expect(planStep!.time_ms).toBeGreaterThanOrEqual(0);
  });

  it('includes synthesize step in steps array', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find data' };

    const result = await runAgentPipeline(input, [engine], router);

    const synthStep = result.steps.find((s) => s.action === 'synthesize');
    expect(synthStep).toBeDefined();
  });

  it('respects max_pages', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find data', max_pages: 2 };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.pages_fetched).toBeLessThanOrEqual(2);
  });

  it('respects max_time_ms', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find data', max_time_ms: 60000 };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.total_time_ms).toBeLessThanOrEqual(65000);
  });

  it('uses explicit URLs from input', async () => {
    const engine = createStubEngine([]);
    const router = createStubRouter();
    const input: AgentInput = {
      prompt: 'Check these pages',
      urls: ['https://example.com/page1', 'https://example.com/page2'],
    };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.sources.length).toBeGreaterThanOrEqual(2);
  });

  it('emits a warning when schema is requested but no sources can be fetched', async () => {
    // Bench complaint: agent.schema silently ignored without sampling. The
    // pipeline now surfaces an explicit warning so callers know structured
    // output was downgraded to free-text.
    const engine = createStubEngine(defaultResults);
    const brokenRouter = {
      fetch: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as SmartRouter;
    const input: AgentInput = {
      prompt: 'Extract product info',
      schema: {
        type: 'object',
        properties: { price: { type: 'string' } },
      },
    };

    const result = await runAgentPipeline(input, [engine], brokenRouter);

    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/schema/i);
  });

  it('does not emit a schema warning when extraction succeeds', async () => {
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        html: '<html><body><span class="price">$49.99</span></body></html>',
        contentType: 'text/html',
        statusCode: 200,
        method: 'http' as const,
        headers: {},
      }),
    } as unknown as SmartRouter;
    const engine = createStubEngine(defaultResults);
    const input: AgentInput = {
      prompt: 'Extract price',
      schema: {
        type: 'object',
        properties: { price: { type: 'string' } },
      },
    };

    const result = await runAgentPipeline(input, [engine], router);

    // Successful structured extraction returns the result object — no warning.
    if (typeof result.result !== 'string') {
      expect(result.warning).toBeUndefined();
    }
  });

  it('agent schema consumes a pricing TABLE, not just class-named DOM (r2 regression)', async () => {
    // WHY: the agent tool used to wrap markdown as <html><body>…</body></html>
    // and run a class-name-only schema extractor, so a page whose facts live
    // in a <table> (no <span class=price>) returned nothing structured. The
    // agent now carries raw HTML on each source and shares the same
    // structure-aware schema engine as the extract tool.
    const tableHtml =
      '<html><body><table><thead><tr><th>Plan</th><th>Price</th></tr></thead>' +
      '<tbody><tr><td>Pro</td><td>$29</td></tr></tbody></table></body></html>';
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        html: tableHtml,
        contentType: 'text/html',
        statusCode: 200,
        method: 'http' as const,
        headers: {},
      }),
    } as unknown as SmartRouter;
    const engine = createStubEngine(defaultResults);
    const input: AgentInput = {
      prompt: 'Extract the plan pricing',
      schema: {
        type: 'object',
        properties: { plan: { type: 'string' }, price: { type: 'string' } },
      },
    };

    const result = await runAgentPipeline(input, [engine], router);

    // A structured object (not a prose string) with the table-sourced fields.
    expect(typeof result.result).toBe('object');
    const obj = result.result as Record<string, unknown>;
    expect(obj.plan).toBe('Pro');
    expect(obj.price).toBe('$29');
    expect(result.warning).toBeUndefined();
  });

  it('agent populates a nested tiers[] schema from a div-grid pricing page (Part A)', async () => {
    // WHY: `wigolo agent` with {tiers:[{name,price}]} matched 0 fields and fell
    // back to prose even against a page whose tiers sit in a clean grid. The
    // shared schema engine now resolves nested array-of-objects fields to one
    // item per grid row, so the agent returns a structured tiers[] array.
    const gridHtml =
      '<html><body><main><h2>Pricing</h2><div class="pricing">' +
      '<div class="tier"><h3>Starter</h3><span class="price">$29</span><ul><li>10 seats</li></ul></div>' +
      '<div class="tier"><h3>Pro</h3><span class="price">$99</span><ul><li>50 seats</li></ul></div>' +
      '<div class="tier"><h3>Enterprise</h3><span class="price">Contact sales</span><ul><li>Unlimited seats</li></ul></div>' +
      '</div></main></body></html>';
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        html: gridHtml,
        contentType: 'text/html',
        statusCode: 200,
        method: 'http' as const,
        headers: {},
      }),
    } as unknown as SmartRouter;
    const engine = createStubEngine(defaultResults);
    const input: AgentInput = {
      prompt: 'Extract the pricing tiers',
      schema: {
        type: 'object',
        properties: {
          tiers: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, price: { type: 'string' } },
            },
          },
        },
      },
    };

    const result = await runAgentPipeline(input, [engine], router);

    expect(typeof result.result).toBe('object');
    const obj = result.result as Record<string, unknown>;
    const tiers = obj.tiers as Array<Record<string, string>>;
    expect(Array.isArray(tiers)).toBe(true);
    expect(tiers).toHaveLength(3);
    expect(tiers[0].name).toBe('Starter');
    expect(tiers[0].price).toBe('$29');
    expect(tiers[2].name).toBe('Enterprise');
    expect(tiers[2].price).toBe('Contact sales');
    expect(result.warning).toBeUndefined();
  });

  it('falls back to PROSE with a warning when only a wrong-shape add-on grid matches (r4)', async () => {
    // Bench: a {tiers:[{name,price,key_features}]} ask against a page whose only
    // grid is a name+price add-on dump (36 rows, no features) emitted 36 typed
    // rows with empty key_features — judged 3.0 vs honest prose 6.5. The agent
    // must reject the low-confidence grid and synthesize prose instead.
    const cards = Array.from({ length: 36 }, (_, i) =>
      `<div class="addon"><h3>Add-on ${i + 1}</h3><span class="price">$${i + 1}</span></div>`,
    ).join('');
    const addonHtml =
      `<html><body><main><section class="marketplace"><h2>Add-ons</h2>` +
      `<div class="addons">${cards}</div></section>` +
      `<p>These add-ons extend the base plan with extra capacity.</p></main></body></html>`;
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        html: addonHtml,
        contentType: 'text/html',
        statusCode: 200,
        method: 'http' as const,
        headers: {},
      }),
    } as unknown as SmartRouter;
    const engine = createStubEngine(defaultResults);
    const input: AgentInput = {
      prompt: 'Extract the pricing tiers',
      schema: {
        type: 'object',
        properties: {
          tiers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                price: { type: 'string' },
                key_features: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    };

    const result = await runAgentPipeline(input, [engine], router);

    // Honest prose, not 36 typed-but-wrong rows.
    expect(typeof result.result).toBe('string');
    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/confiden|shape|prose|synthesi/i);
  });

  it('does NOT prose-fall-back when a shape-complete plan-tier grid matches (negative)', async () => {
    // The negative lock: a genuine plan-tier grid (name+price+features, a
    // handful of rows) is HIGH confidence and MUST still return typed rows —
    // the prose fallback must never fire on a good grid.
    const gridHtml =
      '<html><body><main><h2>Pricing</h2><div class="pricing">' +
      '<div class="tier"><h3>Starter</h3><span class="price">$29</span><ul><li>10 seats</li><li>1 project</li></ul></div>' +
      '<div class="tier"><h3>Pro</h3><span class="price">$99</span><ul><li>50 seats</li><li>10 projects</li></ul></div>' +
      '<div class="tier"><h3>Enterprise</h3><span class="price">$299</span><ul><li>Unlimited seats</li><li>Unlimited projects</li></ul></div>' +
      '</div></main></body></html>';
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        html: gridHtml,
        contentType: 'text/html',
        statusCode: 200,
        method: 'http' as const,
        headers: {},
      }),
    } as unknown as SmartRouter;
    const engine = createStubEngine(defaultResults);
    const input: AgentInput = {
      prompt: 'Extract the pricing tiers',
      schema: {
        type: 'object',
        properties: {
          tiers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                price: { type: 'string' },
                key_features: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    };

    const result = await runAgentPipeline(input, [engine], router);

    expect(typeof result.result).toBe('object');
    const tiers = (result.result as Record<string, unknown>).tiers as Array<Record<string, unknown>>;
    expect(Array.isArray(tiers)).toBe(true);
    expect(tiers).toHaveLength(3);
    expect(tiers[0].name).toBe('Starter');
    // key_features actually filled — this is why it is high-confidence.
    expect(Array.isArray(tiers[0].key_features)).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it('does NOT prose-fall-back for a FEATURELESS native <table> tier grid (real negative)', async () => {
    // The blocker fix: a plain 3-row Plan|Price <table> under a
    // {tiers:[{name,price,key_features[]}]} schema is a GOOD typed answer — an
    // empty key_features column is honest, not wrong. The gate must NOT reject
    // an optional array column that is merely unfilled; typed-correct beats
    // prose. Only wrong shape (low score) or absurd cardinality reject.
    const tableHtml =
      '<html><body><table><thead><tr><th>Plan</th><th>Price</th></tr></thead>' +
      '<tbody>' +
      '<tr><td>Starter</td><td>$9</td></tr>' +
      '<tr><td>Pro</td><td>$29</td></tr>' +
      '<tr><td>Enterprise</td><td>$99</td></tr>' +
      '</tbody></table></body></html>';
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        html: tableHtml,
        contentType: 'text/html',
        statusCode: 200,
        method: 'http' as const,
        headers: {},
      }),
    } as unknown as SmartRouter;
    const engine = createStubEngine(defaultResults);
    const input: AgentInput = {
      prompt: 'Extract the pricing tiers',
      schema: {
        type: 'object',
        properties: {
          tiers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                price: { type: 'string' },
                key_features: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    };

    const result = await runAgentPipeline(input, [engine], router);

    expect(typeof result.result).toBe('object');
    const tiers = (result.result as Record<string, unknown>).tiers as Array<Record<string, unknown>>;
    expect(Array.isArray(tiers)).toBe(true);
    expect(tiers).toHaveLength(3);
    expect(tiers[0].name).toBe('Starter');
    expect(tiers[0].price).toBe('$9');
    expect(result.warning).toBeUndefined();
  });

  it('does NOT prose-fall-back for a FEATURELESS div-grid tier grid (real negative)', async () => {
    // Same as above but the featureless tier grid is a div/flex card grid (no
    // <ul><li> bullets → arrayFilled false). A plausibly-sized name+price tier
    // grid must still return typed rows.
    const gridHtml =
      '<html><body><main><div class="pricing">' +
      '<div class="tier"><h3>Free</h3><span class="price">$0</span></div>' +
      '<div class="tier"><h3>Basic</h3><span class="price">$10</span></div>' +
      '<div class="tier"><h3>Pro</h3><span class="price">$20</span></div>' +
      '<div class="tier"><h3>Max</h3><span class="price">$40</span></div>' +
      '</div></main></body></html>';
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        html: gridHtml,
        contentType: 'text/html',
        statusCode: 200,
        method: 'http' as const,
        headers: {},
      }),
    } as unknown as SmartRouter;
    const engine = createStubEngine(defaultResults);
    const input: AgentInput = {
      prompt: 'Extract the pricing tiers',
      schema: {
        type: 'object',
        properties: {
          tiers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                price: { type: 'string' },
                key_features: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    };

    const result = await runAgentPipeline(input, [engine], router);

    expect(typeof result.result).toBe('object');
    const tiers = (result.result as Record<string, unknown>).tiers as Array<Record<string, unknown>>;
    expect(Array.isArray(tiers)).toBe(true);
    expect(tiers).toHaveLength(4);
    expect(result.warning).toBeUndefined();
  });

  it('never leaks rawHtml into returned sources (schema + no-schema paths)', async () => {
    // rawHtml is internal fuel for schema extraction only. Left in the output
    // it ships hundreds of KB of raw page HTML per source and corrupts the
    // response-envelope token accounting. It must be stripped on BOTH paths.
    const bigHtml =
      '<html><body>' + '<p>filler</p>'.repeat(50) +
      '<table><thead><tr><th>Plan</th><th>Price</th></tr></thead>' +
      '<tbody><tr><td>Pro</td><td>$29</td></tr></tbody></table></body></html>';
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        html: bigHtml,
        contentType: 'text/html',
        statusCode: 200,
        method: 'http' as const,
        headers: {},
      }),
    } as unknown as SmartRouter;
    const engine = createStubEngine(defaultResults);

    // schema path
    const schemaResult = await runAgentPipeline(
      { prompt: 'extract', schema: { type: 'object', properties: { plan: { type: 'string' } } } },
      [engine],
      router,
    );
    expect(schemaResult.sources.length).toBeGreaterThan(0);
    for (const s of schemaResult.sources) {
      expect((s as { rawHtml?: string }).rawHtml).toBeUndefined();
    }

    // no-schema path
    const plainResult = await runAgentPipeline({ prompt: 'summarize' }, [engine], router);
    expect(plainResult.sources.length).toBeGreaterThan(0);
    for (const s of plainResult.sources) {
      expect((s as { rawHtml?: string }).rawHtml).toBeUndefined();
    }
  });

  it('applies schema extraction when schema is provided', async () => {
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        html: '<html><body><span class="price">$49.99</span><h1 class="name">Product X</h1></body></html>',
        contentType: 'text/html',
        statusCode: 200,
        method: 'http' as const,
        headers: {},
      }),
    } as unknown as SmartRouter;
    const engine = createStubEngine(defaultResults);
    const input: AgentInput = {
      prompt: 'Extract product info',
      schema: {
        type: 'object',
        properties: {
          price: { type: 'string' },
          name: { type: 'string' },
        },
      },
    };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.result).toBeDefined();
    const extractStep = result.steps.find((s) => s.action === 'extract');
    expect(extractStep).toBeDefined();
  });

  it('gathers sources via search for a prompt with no seeded URL (0-pages fix)', async () => {
    // A non-empty prompt that extracts no keyword queries used to leave the
    // executor with nothing to fetch → 0 sources. The planner now falls back to
    // a raw-prompt search so the executor fetches pages even with no seeded URL.
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'the a an is to of' };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.pages_fetched).toBeGreaterThan(0);
    expect(result.sources.length).toBeGreaterThan(0);
    const searchStep = result.steps.find((s) => s.action === 'search');
    expect(searchStep).toBeDefined();
  });

  it('handles empty prompt', async () => {
    const engine = createStubEngine([]);
    const router = createStubRouter();
    const input: AgentInput = { prompt: '' };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result).toBeDefined();
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('handles all search engines failing', async () => {
    const brokenEngine: SearchEngine = {
      name: 'broken',
      search: vi.fn().mockRejectedValue(new Error('all broken')),
    };
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find data' };

    const result = await runAgentPipeline(input, [brokenEngine], router);

    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('handles all fetches failing', async () => {
    const engine = createStubEngine(defaultResults);
    const brokenRouter = {
      fetch: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as SmartRouter;
    const input: AgentInput = { prompt: 'Find data' };

    const result = await runAgentPipeline(input, [engine], brokenRouter);

    expect(result).toBeDefined();
    expect(result.sources.some((s) => s.fetch_error)).toBe(true);
  });

  // --- agent silent-fail visibility ---
  //
  // WHY: when the agent attempted to fetch N pages and all failed (network,
  // 4xx, timeout), the synthesis stage used to emit "No data could be
  // gathered for this request." That's not "no data" —
  // it's "fetch failed for every candidate." Callers can't tell whether
  // they should retry, broaden the query, or surface a real error.
  // The fix: surface attempted page count + name the failure shape.

  describe('agent partial-fail visibility (C4)', () => {
    it('synthesis text mentions pages_attempted when every fetch fails', async () => {
      const engine = createStubEngine(defaultResults);
      const brokenRouter = {
        fetch: vi.fn().mockRejectedValue(new Error('network down')),
      } as unknown as SmartRouter;
      const input: AgentInput = { prompt: 'Find pricing' };

      const result = await runAgentPipeline(input, [engine], brokenRouter);

      // The empty-data envelope must carry the attempt count so callers
      // know the agent tried something — they got nothing back because the
      // fetches failed, NOT because no URLs surfaced.
      expect(result.pages_fetched).toBe(0);
      expect(result.sources.length).toBeGreaterThan(0);
      const resultText = typeof result.result === 'string' ? result.result : '';
      expect(resultText).not.toBe('No data could be gathered for this request.');
      expect(resultText.toLowerCase()).toMatch(/0\s*\/\s*\d+|0 of \d|attempt|fetch|failed/);
    });

    it('warning field surfaces the partial-fail shape', async () => {
      const engine = createStubEngine(defaultResults);
      const brokenRouter = {
        fetch: vi.fn().mockRejectedValue(new Error('network down')),
      } as unknown as SmartRouter;
      const input: AgentInput = { prompt: 'Find data' };

      const result = await runAgentPipeline(input, [engine], brokenRouter);

      // Surfacing this as a warning lets clients branch on partial-fail
      // without having to grep the synthesized result text.
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/fetch|page|attempt/i);
    });

    it('does not emit partial-fail warning when at least one page fetched', async () => {
      const engine = createStubEngine(defaultResults);
      const router = createStubRouter();
      const input: AgentInput = { prompt: 'normal happy path' };

      const result = await runAgentPipeline(input, [engine], router);

      // Happy path: warning may still appear for schema mismatch or other
      // reasons, but if it appears, it must not be the partial-fail message.
      expect(result.pages_fetched).toBeGreaterThan(0);
      if (result.warning) {
        expect(result.warning).not.toMatch(/0 of/i);
      }
    });
  });

  it('pages_fetched matches actual successful fetches', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Count test' };

    const result = await runAgentPipeline(input, [engine], router);

    const actualFetched = result.sources.filter((s) => s.fetched).length;
    expect(result.pages_fetched).toBe(actualFetched);
  });

  it('sampling_supported is false without server', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Test' };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.sampling_supported).toBe(false);
  });

  it('synthesize step never claims "via sampling" without server', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Test sampling label' };

    const result = await runAgentPipeline(input, [engine], router);
    const synthStep = result.steps.find((s) => s.action === 'synthesize');
    expect(synthStep).toBeDefined();
    expect(synthStep!.detail).not.toContain('via sampling');
    expect(synthStep!.detail).toContain('evidence fallback');
  });

  it('synthesize step does not claim "via sampling" when sampling unsupported', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Test sampling fallback' };
    const fakeServer = {
      getClientCapabilities: () => ({}),
    } as unknown as Parameters<typeof runAgentPipeline>[3];

    const result = await runAgentPipeline(input, [engine], router, fakeServer);
    const synthStep = result.steps.find((s) => s.action === 'synthesize');
    expect(synthStep).toBeDefined();
    expect(synthStep!.detail).not.toContain('via sampling');
    expect(synthStep!.detail).toContain('evidence fallback');
    expect(result.sampling_supported).toBe(false);
  });

  it('steps have valid action types', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Step validation test' };

    const result = await runAgentPipeline(input, [engine], router);

    const validActions = new Set(['plan', 'search', 'fetch', 'extract', 'synthesize']);
    for (const step of result.steps) {
      expect(validActions.has(step.action)).toBe(true);
    }
  });

  it('returns string result when no schema provided', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find info' };

    const result = await runAgentPipeline(input, [engine], router);

    expect(typeof result.result).toBe('string');
  });

  it('total_time_ms reflects execution duration', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Timing test' };

    const before = Date.now();
    const result = await runAgentPipeline(input, [engine], router);
    const after = Date.now();

    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
    expect(result.total_time_ms).toBeLessThanOrEqual(after - before + 100);
  });

  it('handles concurrent access safely', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();

    const results = await Promise.all([
      runAgentPipeline({ prompt: 'Task A' }, [engine], router),
      runAgentPipeline({ prompt: 'Task B' }, [engine], router),
      runAgentPipeline({ prompt: 'Task C' }, [engine], router),
    ]);

    for (const result of results) {
      expect(result.error).toBeUndefined();
      expect(result.steps.length).toBeGreaterThan(0);
    }
  });
});
