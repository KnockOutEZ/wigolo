/**
 * The research local-synthesis gate must be keystore-aware.
 *
 * In the zero-env scenario (no provider/key env vars, key in the OS keychain)
 * the research pipeline must still recognize the LLM as configured and run the
 * local-LLM synthesis fallback. The env-only isLlmConfigured() gate would
 * wrongly skip it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: vi.fn().mockResolvedValue({
      title: 'Extracted Title',
      markdown: '# Extracted Content\n\nArticle content about the topic.',
      metadata: {},
      links: [],
      images: [],
      extractor: 'defuddle' as const,
    }),
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

vi.mock('../../../src/cache/store.js', () => ({
  cacheContent: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url),
}));

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: vi.fn(() => ({
    isAvailable: () => false,
    embedAsync: vi.fn(),
  })),
}));

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
const synthesisLocalModule = await import('../../../src/research/synthesis-local.js');
const { runResearchPipeline } = await import('../../../src/research/pipeline.js');

function createStubEngine(results: RawSearchResult[]): SearchEngine {
  return { name: 'stub', search: vi.fn().mockResolvedValue(results) };
}

function createStubRouter(): SmartRouter {
  return {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html: '<html><body><h1>Test</h1><p>Article content about the topic.</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;
}

const RESULTS: RawSearchResult[] = [
  { title: 'React Hooks Guide', url: 'https://react.dev/hooks', snippet: 'Learn about hooks.', relevance_score: 0.95, engine: 'stub' },
  { title: 'Vue Composition API', url: 'https://vuejs.org/guide', snippet: 'Vue 3 composition API.', relevance_score: 0.88, engine: 'stub' },
];

const KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'WIGOLO_LLM_PROVIDER',
  'WIGOLO_LLM_API_KEY',
];

describe('research local-synthesis LLM gate is keystore-aware', () => {
  const originalEnv = process.env;
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const v of KEY_ENV_VARS) delete process.env[v];
    _store.clear();
    clearKeyStoreMemo();
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-research-gate-'));
    process.env.WIGOLO_DATA_DIR = tmpDir;
    resetConfig();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
    resetConfig();
    clearKeyStoreMemo();
    vi.restoreAllMocks();
  });

  it('invokes local synthesis when the key lives in the keychain and no env vars are set', async () => {
    await storeKey('anthropic', 'sk-keychain-key', { dataDir: tmpDir });

    const localSpy = vi.spyOn(synthesisLocalModule, 'synthesizeLocal').mockResolvedValue({
      text: 'Keychain-backed local report [1].',
      citations: [],
    });

    const input: ResearchInput = { question: 'What are modern reactivity primitives?', depth: 'quick' };
    const out = await runResearchPipeline(input, [createStubEngine(RESULTS)], createStubRouter());

    expect(out.error).toBeUndefined();
    expect(localSpy).toHaveBeenCalled();
  });

  it('still recognizes env-based config (no regression)', async () => {
    process.env.WIGOLO_LLM_PROVIDER = 'gemini';
    process.env.GOOGLE_API_KEY = 'test-key';

    const localSpy = vi.spyOn(synthesisLocalModule, 'synthesizeLocal').mockResolvedValue({
      text: 'Env-config local report [1].',
      citations: [],
    });

    const input: ResearchInput = { question: 'What are modern reactivity primitives?', depth: 'quick' };
    const out = await runResearchPipeline(input, [createStubEngine(RESULTS)], createStubRouter());

    expect(out.error).toBeUndefined();
    expect(localSpy).toHaveBeenCalled();
  });
});
