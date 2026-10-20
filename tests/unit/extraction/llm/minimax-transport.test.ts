import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep persistence and credentials offline; use the real provider selection,
// model resolution, adapters and SDK serialization up to the fetch boundary.
vi.mock('../../../../src/security/key-store.js', () => ({
  resolveProviderKey: vi.fn(async (provider: string) =>
    provider === 'minimax' ? 'minimax-test-key' : null),
}));
const { cache } = vi.hoisted(() => ({ cache: new Map<string, string>() }));
vi.mock('../../../../src/integrations/cloud/llm/cache.js', () => ({
  ensureLLMCacheTable: vi.fn(),
  lookupLLMCache: vi.fn((model: string) => cache.get(model) ?? null),
  insertLLMCache: vi.fn(({ modelId, response }: { modelId: string; response: string }) => {
    cache.set(modelId, response);
  }),
}));

import { runLlmText } from '../../../../src/integrations/cloud/llm/run.js';
import { callMiniMax } from '../../../../src/integrations/cloud/llm/minimax.js';
import { extractWithLLM } from '../../../../src/extraction/llm-fallback.js';
import { resetConfig } from '../../../../src/config.js';

const schema = {
  type: 'object',
  required: ['price'],
  properties: { price: { type: 'string' } },
};
const prompt = 'Extract the price.';
const flash = 'MiniMax-M3.1-Flash';
const requests: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
let replies: Array<Record<string, unknown>>;

beforeEach(() => {
  requests.length = 0;
  cache.clear();
  replies = [{ role: 'assistant', content: '{"price":"$10"}' }];
  vi.stubEnv('WIGOLO_LLM_PROVIDER', 'minimax');
  vi.stubEnv('WIGOLO_LLM_MODEL', undefined);
  vi.stubEnv('WIGOLO_LLM_MODEL_MINIMAX', undefined);
  vi.stubEnv('WIGOLO_MINIMAX_REGION', undefined);
  vi.stubEnv('WIGOLO_MINIMAX_BASE_URL', undefined);
  resetConfig();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.json() as Record<string, any>;
    requests.push({ url: request.url, headers: request.headers, body });
    expect(request.method).toBe('POST');
    const message = replies.shift();
    if (!message) throw new Error('Unexpected extra request');
    return new Response(JSON.stringify({
      id: 'test-completion', object: 'chat.completion', created: 0,
      model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message }],
    }), { headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetConfig();
});

function expectRequest(model: string, base = 'https://api.minimax.io/v1') {
  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(request.url).toBe(`${base}/chat/completions`);
  expect(request.headers.get('authorization')).toBe('Bearer minimax-test-key');
  expect(request.body.model).toBe(model);
  // Omitted controls retain MiniMax's adaptive thinking / default effort.
  for (const field of ['thinking', 'reasoning_effort', 'service_tier', 'reasoning_split']) {
    expect(request.body).not.toHaveProperty(field);
  }
  return request.body;
}

for (const mode of ['text', 'structured'] as const) {
  describe(`MiniMax ${mode} serialized requests`, () => {
    const call = (modelOverride?: string) => mode === 'text'
      ? runLlmText({ prompt, modelOverride })
      : callMiniMax({ prompt, jsonSchema: schema, modelOverride }, 'minimax-test-key');

    it.each([
      [undefined, 'https://api.minimax.io/v1'],
      ['global_en', 'https://api.minimax.io/v1'],
      ['cn_zh', 'https://api.minimax.cn/v1'],
    ])('defaults to Flash for region %s', async (region, base) => {
      vi.stubEnv('WIGOLO_MINIMAX_REGION', region);
      const result = await call();
      expect(result.model).toBe(flash);
      const body = expectRequest(flash, base);
      expect(body).toEqual(mode === 'text' ? {
        model: flash,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      } : {
        model: flash,
        messages: [{ role: 'user', content: `${prompt}\n\nReturn JSON matching this schema:\n${JSON.stringify(schema)}` }],
        response_format: { type: 'json_object' },
      });
    });

    it.each(['MiniMax-M3', 'MiniMax-M2.7', 'custom-model-id'])(
      'preserves explicit %s over environment defaults', async (model) => {
        vi.stubEnv('WIGOLO_LLM_MODEL_MINIMAX', flash);
        vi.stubEnv('WIGOLO_LLM_MODEL', 'universal-model');
        await call(model);
        expectRequest(model);
      },
    );

    it('preserves the configured legacy model before the universal override', async () => {
      vi.stubEnv('WIGOLO_LLM_MODEL_MINIMAX', 'MiniMax-M2.7');
      vi.stubEnv('WIGOLO_LLM_MODEL', 'custom-model-id');
      await call();
      expectRequest('MiniMax-M2.7');
    });

    it('preserves a universal custom model', async () => {
      vi.stubEnv('WIGOLO_LLM_MODEL', 'custom-model-id');
      await call();
      expectRequest('custom-model-id');
    });

    it.each(['https://proxy.example/v1', 'https://api.minimaxi.com/v1'])(
      'preserves explicit base URL %s over the region', async (base) => {
        vi.stubEnv('WIGOLO_MINIMAX_REGION', 'cn_zh');
        vi.stubEnv('WIGOLO_MINIMAX_BASE_URL', base);
        await call('custom-model-id');
        expectRequest('custom-model-id', base);
      },
    );
  });
}

it('preserves a caller token budget through the text SDK request', async () => {
  await runLlmText({ prompt, maxTokens: 4096 });
  expect(expectRequest(flash).max_tokens).toBe(4096);
});

it('retains the full assistant reasoning message on a structured retry', async () => {
  const first = {
    role: 'assistant', content: '{"price":42}',
    reasoning_content: 'Check the price and preserve this reasoning.', refusal: null,
  };
  replies = [first, { role: 'assistant', content: '{"price":"$10"}' }];
  const result = await callMiniMax({ prompt, jsonSchema: schema }, 'minimax-test-key');
  expect(result.values).toEqual({ price: '$10' });
  expect(requests).toHaveLength(2);
  expect(requests[1].body.model).toBe(flash);
  expect(requests[1].body.messages[0]).toEqual(requests[0].body.messages[0]);
  expect(requests[1].body.messages[1]).toEqual(first);
  expect(requests[1].body.messages[2].content).toContain('failed schema validation');
});

it('routes extraction to Flash and separates its cache from saved models and history', async () => {
  const input = { html: '<p>$10</p>', jsonSchema: schema, partial: {}, missing: ['price'] };
  cache.set('minimax:default', '{"price":"historical"}');
  const first = await extractWithLLM(input);
  expect(first.model).toBe(flash);
  expect(first.values).toEqual({ price: '$10' });
  expectRequest(flash);
  expect(cache.get('minimax:default')).toBe('{"price":"historical"}');
  expect(cache.has(`minimax:${flash}`)).toBe(true);
  expect((await extractWithLLM(input)).cached).toBe(true);
  expect(requests).toHaveLength(1);

  vi.stubEnv('WIGOLO_LLM_MODEL_MINIMAX', 'MiniMax-M2.7');
  replies.push({ role: 'assistant', content: '{"price":"$20"}' });
  const legacy = await extractWithLLM(input);
  expect(legacy.model).toBe('MiniMax-M2.7');
  expect(legacy.values).toEqual({ price: '$20' });
  expect(requests[1].body.model).toBe('MiniMax-M2.7');
  expect(cache.has('minimax:MiniMax-M2.7')).toBe(true);
  expect(cache.get('minimax:default')).toBe('{"price":"historical"}');
});
