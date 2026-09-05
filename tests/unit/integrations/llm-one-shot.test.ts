/**
 * The `wigolo/llm` one-shot seam (SD9-C2, mini-spec §2 / A-420-6).
 *
 * The product law under test is a NEGATIVE one: a caller that asks this seam for
 * a completion must never get a cloud call back wearing a local label. So the
 * decisive arms here run with a cloud provider FULLY configured — env key present,
 * `runLlmText` one branch away from using it — and assert that the cloud adapters
 * are never entered. An arm that scrubbed the provider first would pass with the
 * fallthrough still in the code, because there would be nothing to fall through to.
 *
 * The adapters are mocked rather than the network, for the same reason: a mocked
 * `fetch` alone cannot tell a local POST from a cloud SDK call that never touches
 * global fetch, so `cloudCalls` is the outside signal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';

const cloudCalls: Array<{ provider: string; model: string }> = [];

vi.mock('../../../src/integrations/cloud/llm/text-adapters.js', () => {
  const make = (provider: string) => async (opts: { model: string }) => {
    cloudCalls.push({ provider, model: opts.model });
    return { text: `cloud reply from ${provider}`, provider, model: opts.model, latencyMs: 1 };
  };
  return {
    TEXT_ADAPTERS: {
      anthropic: make('anthropic'),
      openai: make('openai'),
      gemini: make('gemini'),
      groq: make('groq'),
    },
  };
});

const { runLocalLlmText } = await import('../../../src/integrations/cloud/llm/index.js');
const { resetLocalModelTierCache } = await import(
  '../../../src/integrations/cloud/llm/local-tier.js'
);

const ENDPOINT = 'http://127.0.0.1:59999';

/** A local rung that resolves without touching the network. */
const reachableTier = {
  localLlm: ENDPOINT,
  localLlmModel: 'test-local-7b',
  probe: async () => ({ reachable: true }),
  pickModel: async () => 'test-local-7b',
};

/** A local rung that is configured but answers nothing. */
const unreachableTier = {
  localLlm: ENDPOINT,
  probe: async () => ({ reachable: false }),
  pickModel: async () => 'never',
};

function okCompletion(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: text } }] }),
  } as unknown as Response;
}

describe('runLocalLlmText — the one-shot local seam', () => {
  const originalEnv = process.env;
  let dataDir: string;

  beforeEach(() => {
    cloudCalls.length = 0;
    resetLocalModelTierCache();
    process.env = { ...originalEnv };
    // A cloud provider IS configured for every arm: that is the trap the seam
    // must not take. Any silent fallthrough shows up as a non-empty cloudCalls.
    process.env.WIGOLO_LLM_PROVIDER = 'gemini';
    process.env.GOOGLE_API_KEY = 'test-cloud-key';
    // ...and no OpenAI-compatible URL is ambiently configured, so the custom
    // branch can only be reached through this seam's explicit override.
    delete process.env.WIGOLO_LLM_BASE_URL;
    delete process.env.WIGOLO_LOCAL_LLM_BASE_URL;
    delete process.env.WIGOLO_LLM_MODEL;
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-sd9c2-'));
    process.env.WIGOLO_DATA_DIR = dataDir;
    resetConfig();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = originalEnv;
    rmSync(dataDir, { recursive: true, force: true });
    resetConfig();
    resetLocalModelTierCache();
  });

  it('answers backend "local" from the resolved local server, and never a cloud adapter', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      seen.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> });
      return okCompletion('tightened paragraph');
    });

    const result = await runLocalLlmText({ prompt: 'rewrite this', tier: reachableTier });

    expect(result).toEqual({
      backend: 'local',
      text: 'tightened paragraph',
      model: 'test-local-7b',
      endpoint: ENDPOINT,
      latencyMs: expect.any(Number),
      costUsd: 0,
    });
    expect(cloudCalls).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${ENDPOINT}/v1/chat/completions`);
    expect(seen[0].body.model).toBe('test-local-7b');
  });

  it('folds `system` into the prompt without adding a second message role', async () => {
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body) as Record<string, unknown>);
      return okCompletion('ok');
    });

    await runLocalLlmText({ system: 'Be terse.', prompt: 'rewrite this', tier: reachableTier });

    expect(seen[0].messages).toEqual([{ role: 'user', content: 'Be terse.\n\nrewrite this' }]);
  });

  it('refuses with "no-local-model" when no local server answers — with a cloud key present', async () => {
    const fetchSpy = vi.fn(async () => okCompletion('should never be reached'));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runLocalLlmText({ prompt: 'rewrite this', tier: unreachableTier });

    expect(result).toEqual({ backend: 'unavailable', reason: 'no-local-model' });
    expect(cloudCalls).toEqual([]);
    // No prompt left the process: the refusal is decided before any call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses with "no-local-model" when the ladder rung is off entirely', async () => {
    const result = await runLocalLlmText({
      prompt: 'rewrite this',
      tier: { localLlm: 'off', probe: async () => ({ reachable: true }) },
    });

    expect(result).toEqual({ backend: 'unavailable', reason: 'no-local-model' });
    expect(cloudCalls).toEqual([]);
  });

  it('reports "call-failed" when the local server errors, instead of retrying on the cloud', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }) as unknown as Response);

    const result = await runLocalLlmText({
      prompt: 'rewrite this',
      timeoutMs: 2_000,
      tier: reachableTier,
    });

    expect(result.backend).toBe('unavailable');
    expect(result).toMatchObject({ reason: 'call-failed' });
    expect((result as { detail?: string }).detail).toContain('500');
    expect(cloudCalls).toEqual([]);
  });
});
