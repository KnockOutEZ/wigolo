/**
 * Tests for resolveCustomBackend + pickOllamaModel — the seam that makes the
 * `ollama` alias a first-class keyless backend.
 *
 * WHY: Ollama previously only worked via a raw WIGOLO_LLM_PROVIDER=http://...
 * URL. Users expect a friendly `ollama` alias that auto-targets localhost:11434
 * and auto-picks an installed synthesis model. These tests lock that the alias
 * resolves from BOTH env and persisted config.json, the base URL is overridable,
 * and model auto-pick honors priority / first-installed / recommended-fallback —
 * so a regression in any of those silently degrades local synthesis quality.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

const {
  resolveCustomBackend,
  pickOllamaModel,
  DEFAULT_OLLAMA_BASE_URL,
  RECOMMENDED_OLLAMA_MODEL,
} = await import('../../../src/integrations/cloud/llm/custom-backend.js');
const { resetPersistedConfig } = await import('../../../src/persisted-config.js');

describe('resolveCustomBackend', () => {
  it('maps the ollama alias to localhost:11434 with isOllama=true', () => {
    const result = resolveCustomBackend({ WIGOLO_LLM_PROVIDER: 'ollama' });
    expect(result).toEqual({ url: DEFAULT_OLLAMA_BASE_URL, isOllama: true });
  });

  it('respects WIGOLO_LLM_BASE_URL override for the ollama alias', () => {
    const result = resolveCustomBackend({
      WIGOLO_LLM_PROVIDER: 'ollama',
      WIGOLO_LLM_BASE_URL: 'http://192.168.1.5:11434',
    });
    expect(result).toEqual({ url: 'http://192.168.1.5:11434', isOllama: true });
  });

  it('maps an http(s) URL to a custom backend with isOllama=false', () => {
    expect(resolveCustomBackend({ WIGOLO_LLM_PROVIDER: 'http://localhost:8000' })).toEqual({
      url: 'http://localhost:8000',
      isOllama: false,
    });
    expect(resolveCustomBackend({ WIGOLO_LLM_PROVIDER: 'https://proxy.example/v1' })).toEqual({
      url: 'https://proxy.example/v1',
      isOllama: false,
    });
  });

  it('returns null for a cloud provider id (handled by selectProvider)', () => {
    expect(resolveCustomBackend({ WIGOLO_LLM_PROVIDER: 'anthropic' })).toBeNull();
    expect(resolveCustomBackend({ WIGOLO_LLM_PROVIDER: 'openai' })).toBeNull();
  });

  it('returns null for junk / unset', () => {
    expect(resolveCustomBackend({ WIGOLO_LLM_PROVIDER: 'not-a-thing' })).toBeNull();
    expect(resolveCustomBackend({})).toBeNull();
  });

  it('does NOT fall through to config.json when env names a cloud provider', () => {
    // env wins: an explicit cloud-provider override must not be overridden by a
    // stale config.json ollama choice.
    const tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-cb-env-wins-'));
    try {
      const cfgPath = join(tmpDir, 'config.json');
      writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { llmProvider: 'ollama' } }));
      process.env.WIGOLO_CONFIG_PATH = cfgPath;
      resetPersistedConfig();
      expect(resolveCustomBackend({ WIGOLO_LLM_PROVIDER: 'anthropic' })).toBeNull();
    } finally {
      delete process.env.WIGOLO_CONFIG_PATH;
      resetPersistedConfig();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('persisted config.json llmProvider:"ollama"', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-cb-cfg-'));
    });
    afterEach(() => {
      delete process.env.WIGOLO_CONFIG_PATH;
      resetPersistedConfig();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeConfig(settings: Record<string, unknown>): void {
      const cfgPath = join(tmpDir, 'config.json');
      writeFileSync(cfgPath, JSON.stringify({ version: 1, settings }));
      process.env.WIGOLO_CONFIG_PATH = cfgPath;
      resetPersistedConfig();
    }

    it('recognizes ollama from config.json when env is unset', () => {
      writeConfig({ llmProvider: 'ollama' });
      expect(resolveCustomBackend({})).toEqual({ url: DEFAULT_OLLAMA_BASE_URL, isOllama: true });
    });

    it('honors WIGOLO_LLM_BASE_URL env with config.json ollama', () => {
      writeConfig({ llmProvider: 'ollama' });
      expect(resolveCustomBackend({ WIGOLO_LLM_BASE_URL: 'http://remote:11434' })).toEqual({
        url: 'http://remote:11434',
        isOllama: true,
      });
    });

    it('honors persisted llmBaseUrl from config.json (zero-env runtime)', () => {
      writeConfig({ llmProvider: 'ollama', llmBaseUrl: 'http://configured:11434' });
      expect(resolveCustomBackend({})).toEqual({ url: 'http://configured:11434', isOllama: true });
    });

    it('env WIGOLO_LLM_BASE_URL wins over persisted llmBaseUrl', () => {
      writeConfig({ llmProvider: 'ollama', llmBaseUrl: 'http://configured:11434' });
      expect(resolveCustomBackend({ WIGOLO_LLM_BASE_URL: 'http://env:11434' })).toEqual({
        url: 'http://env:11434',
        isOllama: true,
      });
    });

    it('returns null when config.json names a cloud provider', () => {
      writeConfig({ llmProvider: 'anthropic' });
      expect(resolveCustomBackend({})).toBeNull();
    });
  });
});

describe('pickOllamaModel', () => {
  function tagsResponse(names: string[]): typeof fetch {
    return vi.fn(async () =>
      new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 }),
    ) as unknown as typeof fetch;
  }

  it('picks the highest-priority installed model', async () => {
    // mistral installed but llama3.1 also installed → llama3.1 wins (higher priority)
    const model = await pickOllamaModel(
      DEFAULT_OLLAMA_BASE_URL,
      tagsResponse(['mistral:latest', 'llama3.1:8b']),
    );
    expect(model).toBe('llama3.1:8b');
  });

  it('picks the first installed model when none match the priority list', async () => {
    const model = await pickOllamaModel(
      DEFAULT_OLLAMA_BASE_URL,
      tagsResponse(['custom-model:v1', 'another:latest']),
    );
    expect(model).toBe('custom-model:v1');
  });

  it('falls back to the recommended name when /api/tags returns no models', async () => {
    const model = await pickOllamaModel(DEFAULT_OLLAMA_BASE_URL, tagsResponse([]));
    expect(model).toBe(RECOMMENDED_OLLAMA_MODEL);
  });

  it('falls back to the recommended name when /api/tags is unreachable', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const model = await pickOllamaModel(DEFAULT_OLLAMA_BASE_URL, failing);
    expect(model).toBe(RECOMMENDED_OLLAMA_MODEL);
  });

  it('falls back to the recommended name on a non-ok response', async () => {
    const notOk = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const model = await pickOllamaModel(DEFAULT_OLLAMA_BASE_URL, notOk);
    expect(model).toBe(RECOMMENDED_OLLAMA_MODEL);
  });
});
