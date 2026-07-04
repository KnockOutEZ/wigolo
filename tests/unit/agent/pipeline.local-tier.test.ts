/**
 * Agent synthesis must ALSO fire the local-model path via the C0 opt-in tier
 * (resolveLocalModelTier), slotted as the MIDDLE rung of the ladder:
 * host-sampling > local model > deterministic evidence assembly.
 *
 * Deterministic mocked tests for the ladder gating:
 *   - keystore false + tier present + no sampling -> runLlmText at the tier
 *     endpoint/model (local model used).
 *   - host sampling supported -> sampling wins, tier NOT used.
 *   - tier null + keystore false -> NO model call, deterministic evidence
 *     fallback (byte-for-byte with today).
 *   - tier synthesis throws -> deterministic fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult, AgentInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

vi.mock('../../../src/integrations/cloud/llm/local-tier.js', () => ({
  resolveLocalModelTier: vi.fn(),
}));

vi.mock('../../../src/integrations/cloud/llm/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/integrations/cloud/llm/run.js')>();
  return {
    ...actual,
    isLlmConfiguredWithKeyStore: vi.fn(async () => false),
    runLlmText: vi.fn(),
  };
});

const localTierModule = await import('../../../src/integrations/cloud/llm/local-tier.js');
const runLlmModule = await import('../../../src/integrations/cloud/llm/run.js');
const { runAgentPipeline } = await import('../../../src/agent/pipeline.js');

function createStubEngine(results: RawSearchResult[] = []): SearchEngine {
  return { name: 'stub', search: vi.fn().mockResolvedValue(results) };
}

function createStubRouter(): SmartRouter {
  return {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://pgedge.com/pricing',
      finalUrl: 'https://pgedge.com/pricing',
      html: '<html><body><h1>pgEdge Pricing</h1><p>Developer $19. Pro $25. Enterprise $35.</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;
}

function makeSamplingServer(text = 'sampling-host-answer [1]') {
  return {
    getClientCapabilities: vi.fn().mockReturnValue({ sampling: {} }),
    createMessage: vi.fn().mockResolvedValue({
      model: 'sampling-host-model',
      content: { type: 'text', text },
    }),
  };
}

const SOURCES: RawSearchResult[] = [
  { title: 'pgEdge Pricing', url: 'https://pgedge.com/pricing', snippet: 'pricing tiers', relevance_score: 0.9, engine: 'stub' },
];

describe('agent synthesis fires via the local-model tier', () => {
  const originalEnv = process.env;
  const TIER = { available: true as const, endpoint: 'http://localhost:11434', model: 'qwen2.5:7b-instruct', source: 'auto' as const };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_LLM_PROVIDER;
    vi.clearAllMocks();
  });
  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('routes runLlmText at the tier via the backend param when tier present, no keystore, no sampling', async () => {
    vi.mocked(localTierModule.resolveLocalModelTier).mockResolvedValue(TIER);
    process.env.WIGOLO_LLM_PROVIDER = 'anthropic';

    let providerDuringCall: string | undefined;
    vi.mocked(runLlmModule.runLlmText).mockImplementation(async (opts) => {
      providerDuringCall = process.env.WIGOLO_LLM_PROVIDER;
      return {
        text: 'Local tier synthesis: pgEdge $19/$25/$35 [1].',
        provider: 'custom' as const,
        model: opts.backend?.model ?? opts.modelOverride ?? 'unknown',
        latencyMs: 5,
      };
    });

    const input: AgentInput = { prompt: 'find pgEdge pricing' };
    const result = await runAgentPipeline(input, [createStubEngine(SOURCES)], createStubRouter());

    expect(result.error).toBeUndefined();
    expect(vi.mocked(runLlmModule.runLlmText)).toHaveBeenCalledTimes(1);
    const callOpts = vi.mocked(runLlmModule.runLlmText).mock.calls[0]![0];
    // Routed via the additive backend override — url + model, no env bridge.
    expect(callOpts.backend).toEqual({ url: 'http://localhost:11434', model: 'qwen2.5:7b-instruct' });
    expect(typeof result.result === 'string' ? result.result : '').toContain('Local tier synthesis');
    // Ambient provider is untouched DURING and after the call.
    expect(providerDuringCall).toBe('anthropic');
    expect(process.env.WIGOLO_LLM_PROVIDER).toBe('anthropic');
    const synthStep = result.steps.find((s) => s.action === 'synthesize');
    expect(synthStep?.detail).toContain('via configured LLM');
  });

  // Concurrency regression: an env-bridge corrupts a shared WIGOLO_LLM_PROVIDER
  // when two agent syntheses overlap. The backend param mutates nothing.
  it('two overlapping agent tier syntheses do not corrupt a shared WIGOLO_LLM_PROVIDER', async () => {
    vi.mocked(localTierModule.resolveLocalModelTier).mockResolvedValue(TIER);
    process.env.WIGOLO_LLM_PROVIDER = 'anthropic';

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let inFlight = 0;
    let bothOverlapped = false;
    vi.mocked(runLlmModule.runLlmText).mockImplementation(async () => {
      inFlight++;
      if (inFlight === 2) bothOverlapped = true;
      await gate;
      return { text: 'ok [1].', provider: 'custom' as const, model: 'm', latencyMs: 1 };
    });

    const run = () => runAgentPipeline({ prompt: 'find pgEdge pricing' }, [createStubEngine(SOURCES)], createStubRouter());
    const p1 = run();
    const p2 = run();
    await vi.waitFor(() => expect(bothOverlapped).toBe(true));
    releaseGate();
    await Promise.all([p1, p2]);

    expect(process.env.WIGOLO_LLM_PROVIDER).toBe('anthropic');
  });

  it('prefers host sampling over the tier when sampling is supported', async () => {
    vi.mocked(localTierModule.resolveLocalModelTier).mockResolvedValue(TIER);
    const samplingServer = makeSamplingServer('sampling wins [1]');

    const input: AgentInput = { prompt: 'find pgEdge pricing' };
    const result = await runAgentPipeline(
      input,
      [createStubEngine(SOURCES)],
      createStubRouter(),
      samplingServer as unknown as Parameters<typeof runAgentPipeline>[3],
    );

    expect(result.error).toBeUndefined();
    expect(typeof result.result === 'string' ? result.result : '').toContain('sampling wins');
    expect(vi.mocked(runLlmModule.runLlmText)).not.toHaveBeenCalled();
  });

  it('does NOT call runLlmText when tier is null and no keystore (byte-for-byte deterministic)', async () => {
    vi.mocked(localTierModule.resolveLocalModelTier).mockResolvedValue(null);

    const input: AgentInput = { prompt: 'find pgEdge pricing' };
    const result = await runAgentPipeline(input, [createStubEngine(SOURCES)], createStubRouter());

    expect(result.error).toBeUndefined();
    expect(vi.mocked(runLlmModule.runLlmText)).not.toHaveBeenCalled();
    const synthStep = result.steps.find((s) => s.action === 'synthesize');
    expect(synthStep?.detail).toContain('evidence fallback');
  });

  it('falls back to deterministic evidence when the tier synthesis throws', async () => {
    vi.mocked(localTierModule.resolveLocalModelTier).mockResolvedValue(TIER);
    vi.mocked(runLlmModule.runLlmText).mockRejectedValue(new Error('tier timeout'));

    const input: AgentInput = { prompt: 'find pgEdge pricing' };
    const result = await runAgentPipeline(input, [createStubEngine(SOURCES)], createStubRouter());

    expect(result.error).toBeUndefined();
    const synthStep = result.steps.find((s) => s.action === 'synthesize');
    expect(synthStep?.detail).toContain('evidence fallback');
    // Env restored even after the throw.
    expect(process.env.WIGOLO_LLM_PROVIDER).toBeUndefined();
  });
});
