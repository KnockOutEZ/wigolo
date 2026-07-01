import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { synthesizeLocal } from '../../../src/research/synthesis-local.js';

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

const ORIGINAL_PROVIDER = process.env['WIGOLO_LLM_PROVIDER'];
const ORIGINAL_MODEL = process.env['WIGOLO_LLM_MODEL'];

function restoreEnv() {
  if (ORIGINAL_PROVIDER === undefined) delete process.env['WIGOLO_LLM_PROVIDER'];
  else process.env['WIGOLO_LLM_PROVIDER'] = ORIGINAL_PROVIDER;
  if (ORIGINAL_MODEL === undefined) delete process.env['WIGOLO_LLM_MODEL'];
  else process.env['WIGOLO_LLM_MODEL'] = ORIGINAL_MODEL;
}

describe('synthesizeLocal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env['WIGOLO_LLM_PROVIDER'];
    delete process.env['WIGOLO_LLM_MODEL'];
  });

  afterEach(() => {
    restoreEnv();
  });

  it('throws when local LLM not configured', async () => {
    await expect(
      synthesizeLocal('q', [{ url: 'u', title: 't', markdown: 'm' }]),
    ).rejects.toThrow(/LLM not configured/);
  });

  it('POSTs to {provider}/v1/chat/completions with prompt + sources', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234';
    process.env['WIGOLO_LLM_MODEL'] = 'my-model';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'AI is hot [1].' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await synthesizeLocal('What is AI?', [
      { url: 'https://a.com', title: 'A', markdown: 'AI rocks' },
    ]);

    expect(result.text).toBe('AI is hot [1].');
    expect(result.citations).toEqual([0]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe('my-model');
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0].content).toContain('What is AI?');
    expect(body.messages[0].content).toContain('AI rocks');
    expect(body.response_format).toBeUndefined();
  });

  it('extracts multiple citation markers (1-based -> 0-based)', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Claim one [1]. Claim two [2][3].' } }],
        }),
        { status: 200 },
      ),
    );
    const result = await synthesizeLocal('q', [
      { url: 'u1', title: 't1', markdown: 'm1' },
      { url: 'u2', title: 't2', markdown: 'm2' },
      { url: 'u3', title: 't3', markdown: 'm3' },
    ]);
    expect(result.citations.sort()).toEqual([0, 1, 2]);
  });

  it('keeps out-of-range citations verbatim (caller validates)', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Wild claim [99].' } }] }),
        { status: 200 },
      ),
    );
    const result = await synthesizeLocal('q', [
      { url: 'u', title: 't', markdown: 'm' },
    ]);
    expect(result.citations).toEqual([98]);
  });

  it('throws on non-200 response', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(
      synthesizeLocal('q', [{ url: 'u', title: 't', markdown: 'm' }]),
    ).rejects.toThrow(/500/);
  });

  it('throws when fetch errors out', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('econnrefused'));
    await expect(
      synthesizeLocal('q', [{ url: 'u', title: 't', markdown: 'm' }]),
    ).rejects.toThrow(/econnrefused/);
  });

  it('still calls endpoint when sources empty (caller responsibility)', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'no sources' } }] }),
        { status: 200 },
      ),
    );
    const result = await synthesizeLocal('q', []);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('no sources');
    expect(result.citations).toEqual([]);
  });

  it('respects maxSources slice', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200 },
      ),
    );
    const sources = Array.from({ length: 10 }, (_, i) => ({
      url: `https://s${i}.com`,
      title: `T${i}`,
      markdown: `Body of source ${i}`,
    }));
    await synthesizeLocal('q', sources, { maxSources: 2 });
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    const content = body.messages[0].content as string;
    expect(content).toContain('[1]');
    expect(content).toContain('[2]');
    expect(content).not.toContain('[3]');
    expect(content).toContain('Body of source 0');
    expect(content).toContain('Body of source 1');
    expect(content).not.toContain('Body of source 2');
  });

  it('accepts a full endpoint URL ending in /v1/chat/completions', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234/v1/chat/completions';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200 },
      ),
    );
    await synthesizeLocal('q', []);
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('truncates source markdown to maxCharsPerSource', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200 },
      ),
    );
    const big = 'x'.repeat(10000);
    await synthesizeLocal('q', [{ url: 'u', title: 't', markdown: big }], {
      maxCharsPerSource: 100,
    });
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    const content = body.messages[0].content as string;
    expect((content.match(/x/g) || []).length).toBeLessThanOrEqual(100);
  });
});

/**
 * synthesizeLocal's configured-gate must be keystore-aware.
 *
 * Zero-env scenario: no provider/key env vars, provider chosen in config.json,
 * key in the OS keychain. The env-only isLlmConfigured() gate would wrongly
 * throw "LLM not configured"; the keystore-aware gate must let synthesis run.
 */
describe('synthesizeLocal LLM gate is keystore-aware', () => {
  const originalEnv = process.env;
  let tmpDir: string;

  const KEY_ENV_VARS = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'GROQ_API_KEY',
    'WIGOLO_LLM_PROVIDER',
    'WIGOLO_LLM_API_KEY',
    'WIGOLO_LLM_MODEL',
  ];

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const v of KEY_ENV_VARS) delete process.env[v];
    _store.clear();
    clearKeyStoreMemo();
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-synth-gate-'));
    process.env.WIGOLO_DATA_DIR = tmpDir;
    process.env.WIGOLO_CONFIG_PATH = join(tmpDir, 'config.json');
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

  it('runs synthesis when provider is in config.json and key is in the keychain (no env vars)', async () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ llmProvider: 'anthropic' }));
    await storeKey('anthropic', 'sk-keychain-key', { dataDir: tmpDir });

    // Anthropic provider resolved from config.json+keychain -> anthropic-shaped response.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'Keychain answer [1].' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await synthesizeLocal('q', [{ url: 'u', title: 't', markdown: 'm' }]);

    // Gate let synthesis run (would have thrown "LLM not configured" otherwise).
    expect(fetchSpy).toHaveBeenCalled();
    expect(result.text).toBe('Keychain answer [1].');
  });

  it('throws when neither env, config.json provider, nor keychain key are present', async () => {
    await expect(
      synthesizeLocal('q', [{ url: 'u', title: 't', markdown: 'm' }]),
    ).rejects.toThrow(/LLM not configured/);
  });
});
