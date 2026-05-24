import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as runLlmModule from '../../../src/integrations/cloud/llm/run.js';
import { runAgentPipeline } from '../../../src/agent/pipeline.js';
import type { SearchEngine, RawSearchResult, AgentInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

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

describe('agent synthesis provider priority', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('prefers WIGOLO_LLM_PROVIDER (Gemini) over MCP sampling when both available', async () => {
    process.env.WIGOLO_LLM_PROVIDER = 'gemini';
    process.env.GOOGLE_API_KEY = 'test-key';

    const runLlmSpy = vi.spyOn(runLlmModule, 'runLlmText').mockResolvedValue({
      text: 'Gemini synthesis: pgEdge offers $19/$25/$35 tiers [1].',
      provider: 'gemini',
      model: 'gemini-flash',
      latencyMs: 100,
    });

    const samplingServer = makeSamplingServer('sampling-host-answer [1]');

    const input: AgentInput = { prompt: 'find pgEdge pricing' };
    const result = await runAgentPipeline(
      input,
      [createStubEngine(SOURCES)],
      createStubRouter(),
      samplingServer as unknown as Parameters<typeof runAgentPipeline>[3],
    );

    expect(result.error).toBeUndefined();
    expect(typeof result.result === 'string' ? result.result : '').toContain('Gemini synthesis');
    expect(runLlmSpy).toHaveBeenCalled();

    const synthStep = result.steps.find((s) => s.action === 'synthesize');
    expect(synthStep?.detail).toContain('via configured LLM');
  });

  it('falls back to MCP sampling when WIGOLO_LLM_PROVIDER call throws', async () => {
    process.env.WIGOLO_LLM_PROVIDER = 'gemini';
    process.env.GOOGLE_API_KEY = 'test-key';

    vi.spyOn(runLlmModule, 'runLlmText').mockRejectedValue(new Error('gemini upstream 503'));

    const samplingServer = makeSamplingServer('sampling rescue [1]');
    const input: AgentInput = { prompt: 'find pgEdge pricing' };
    const result = await runAgentPipeline(
      input,
      [createStubEngine(SOURCES)],
      createStubRouter(),
      samplingServer as unknown as Parameters<typeof runAgentPipeline>[3],
    );

    expect(result.error).toBeUndefined();
    expect(typeof result.result === 'string' ? result.result : '').toContain('sampling rescue');
  });
});
