/**
 * The agent synthesis gate must be keystore-aware.
 *
 * In the zero-env scenario (no provider/key env vars, key lives in the OS
 * keychain) the agent pipeline must still recognize the LLM as configured and
 * run LLM synthesis. The env-only isLlmConfigured() gate would wrongly skip it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import type { SearchEngine, RawSearchResult, AgentInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

// In-memory keychain so storeKey/resolveProviderKey work without a real OS keychain.
vi.mock('../../../src/security/keychain.js', () => {
  const store = new Map<string, string>();
  return {
    WIGOLO_SERVICE: 'wigolo',
    keychainAvailable: vi.fn(() => true),
    keychainSet: vi.fn((service: string, _user: string, value: string) => { store.set(service, value); }),
    keychainGet: vi.fn((service: string, _user: string) => store.get(service) ?? null),
    keychainDelete: vi.fn((service: string, _user: string) => { store.delete(service); }),
    _store: store,
  };
});

const keychainMod = await import('../../../src/security/keychain.js');
const { _store } = keychainMod as typeof keychainMod & { _store: Map<string, string> };
const { storeKey, clearKeyStoreMemo } = await import('../../../src/security/key-store.js');
const { resetConfig } = await import('../../../src/config.js');
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

const SOURCES: RawSearchResult[] = [
  { title: 'pgEdge Pricing', url: 'https://pgedge.com/pricing', snippet: 'pricing tiers', relevance_score: 0.9, engine: 'stub' },
];

const KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'WIGOLO_LLM_PROVIDER',
  'WIGOLO_LLM_API_KEY',
];

describe('agent synthesis LLM gate is keystore-aware', () => {
  const originalEnv = process.env;
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const v of KEY_ENV_VARS) delete process.env[v];
    _store.clear();
    clearKeyStoreMemo();
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-agent-gate-'));
    process.env.WIGOLO_DATA_DIR = tmpDir;
    resetConfig();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
    resetConfig();
    clearKeyStoreMemo();
    vi.restoreAllMocks();
  });

  it('runs LLM synthesis when the key lives in the keychain and no env vars are set', async () => {
    await storeKey('anthropic', 'sk-keychain-key', { dataDir: tmpDir });

    const runLlmSpy = vi.spyOn(runLlmModule, 'runLlmText').mockResolvedValue({
      text: 'Keychain-backed synthesis: pgEdge offers $19/$25/$35 tiers [1].',
      provider: 'anthropic',
      model: 'claude',
      latencyMs: 100,
    });

    const input: AgentInput = { prompt: 'find pgEdge pricing' };
    const result = await runAgentPipeline(input, [createStubEngine(SOURCES)], createStubRouter());

    expect(result.error).toBeUndefined();
    expect(runLlmSpy).toHaveBeenCalled();
    expect(typeof result.result === 'string' ? result.result : '').toContain('Keychain-backed synthesis');
  });

  it('still recognizes env-based config (no regression)', async () => {
    process.env.WIGOLO_LLM_PROVIDER = 'gemini';
    process.env.GOOGLE_API_KEY = 'test-key';

    const runLlmSpy = vi.spyOn(runLlmModule, 'runLlmText').mockResolvedValue({
      text: 'Env synthesis [1].',
      provider: 'gemini',
      model: 'gemini-flash',
      latencyMs: 100,
    });

    const input: AgentInput = { prompt: 'find pgEdge pricing' };
    const result = await runAgentPipeline(input, [createStubEngine(SOURCES)], createStubRouter());

    expect(result.error).toBeUndefined();
    expect(runLlmSpy).toHaveBeenCalled();
    expect(typeof result.result === 'string' ? result.result : '').toContain('Env synthesis');
  });
});
