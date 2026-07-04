/**
 * Tool-boundary integration: the `agent` MCP tool must synthesize via the C0
 * opt-in local-model tier when it is reachable and no cloud key / explicit
 * provider is configured (the WIGOLO_LOCAL_LLM-only gap), and must make zero
 * model calls in the keyless default. Exercised through handleAgent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult, AgentInput } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';

vi.mock('../../src/integrations/cloud/llm/local-tier.js', () => ({
  resolveLocalModelTier: vi.fn(),
}));

vi.mock('../../src/integrations/cloud/llm/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integrations/cloud/llm/run.js')>();
  return {
    ...actual,
    isLlmConfiguredWithKeyStore: vi.fn(async () => false),
    runLlmText: vi.fn(),
  };
});

const localTierModule = await import('../../src/integrations/cloud/llm/local-tier.js');
const runLlmModule = await import('../../src/integrations/cloud/llm/run.js');
const { handleAgent } = await import('../../src/tools/agent.js');

const RESULTS: RawSearchResult[] = [
  { title: 'pgEdge Pricing', url: 'https://pgedge.com/pricing', snippet: 'tiers', relevance_score: 0.9, engine: 'integration-stub' },
];

function stubEngine(): SearchEngine {
  return { name: 'integration-stub', search: vi.fn().mockResolvedValue(RESULTS) };
}

function stubRouter(): SmartRouter {
  return {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://pgedge.com/pricing', finalUrl: 'https://pgedge.com/pricing',
      html: '<html><body><h1>pgEdge Pricing</h1><p>Developer $19. Pro $25. Enterprise $35.</p></body></html>',
      contentType: 'text/html', statusCode: 200, method: 'http' as const, headers: {},
    }),
  } as unknown as SmartRouter;
}

describe('agent tool boundary — local-model tier synthesis', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_LLM_PROVIDER;
    vi.clearAllMocks();
  });
  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('routes the local tier and returns its synthesis through handleAgent', async () => {
    vi.mocked(localTierModule.resolveLocalModelTier).mockResolvedValue({
      available: true, endpoint: 'http://localhost:11434', model: 'qwen2.5:7b-instruct', source: 'auto',
    });
    vi.mocked(runLlmModule.runLlmText).mockResolvedValue({
      text: 'pgEdge tiers: Developer $19, Pro $25, Enterprise $35 [1].',
      provider: 'custom', model: 'qwen2.5:7b-instruct', latencyMs: 6,
    });

    const input: AgentInput = { prompt: 'find pgEdge pricing tiers' };
    const res = await handleAgent(input, [stubEngine()], stubRouter());

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const callOpts = vi.mocked(runLlmModule.runLlmText).mock.calls[0]![0];
    // Routed via the additive backend override, not an env bridge.
    expect(callOpts.backend).toEqual({ url: 'http://localhost:11434', model: 'qwen2.5:7b-instruct' });
    expect(typeof res.data.result === 'string' ? res.data.result : '').toContain('Developer $19');
    expect(process.env.WIGOLO_LLM_PROVIDER).toBeUndefined();
  });

  it('keyless default (tier null, no cloud key) makes NO model call at the boundary', async () => {
    vi.mocked(localTierModule.resolveLocalModelTier).mockResolvedValue(null);

    const input: AgentInput = { prompt: 'find pgEdge pricing tiers' };
    const res = await handleAgent(input, [stubEngine()], stubRouter());

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(vi.mocked(runLlmModule.runLlmText)).not.toHaveBeenCalled();
    expect(typeof res.data.result === 'string' ? res.data.result : '').length > 0;
  });
});
