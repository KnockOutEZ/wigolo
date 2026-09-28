import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

import {
  callMiniMax,
  resolveMiniMaxBaseUrl,
  MINIMAX_ENDPOINTS,
  MINIMAX_MODELS,
  DEFAULT_MODEL,
  DEFAULT_MINIMAX_REGION,
} from '../../../../src/integrations/cloud/llm/minimax.js';
import { providerDefaultModel } from '../../../../src/integrations/cloud/llm/model-select.js';

const schema = {
  type: 'object',
  required: ['price'],
  properties: { price: { type: 'string' } },
};

describe('resolveMiniMaxBaseUrl', () => {
  it('defaults to the global OpenAI-compatible endpoint', () => {
    expect(resolveMiniMaxBaseUrl({})).toBe('https://api.minimax.io/v1');
    expect(MINIMAX_ENDPOINTS[DEFAULT_MINIMAX_REGION]).toBe('https://api.minimax.io/v1');
  });

  it('selects the CN endpoint when WIGOLO_MINIMAX_REGION=cn_zh', () => {
    expect(resolveMiniMaxBaseUrl({ WIGOLO_MINIMAX_REGION: 'cn_zh' })).toBe(
      'https://api.minimaxi.com/v1',
    );
  });

  it('keeps the global endpoint for global_en and unknown regions', () => {
    expect(resolveMiniMaxBaseUrl({ WIGOLO_MINIMAX_REGION: 'global_en' })).toBe(
      'https://api.minimax.io/v1',
    );
    expect(resolveMiniMaxBaseUrl({ WIGOLO_MINIMAX_REGION: 'bogus' })).toBe(
      'https://api.minimax.io/v1',
    );
  });

  it('WIGOLO_MINIMAX_BASE_URL overrides the region entirely', () => {
    expect(
      resolveMiniMaxBaseUrl({
        WIGOLO_MINIMAX_BASE_URL: 'https://proxy.example/v1',
        WIGOLO_MINIMAX_REGION: 'cn_zh',
      }),
    ).toBe('https://proxy.example/v1');
  });
});

describe('minimax model metadata', () => {
  it('exposes MiniMax-M3 as the default model', () => {
    expect(DEFAULT_MODEL).toBe('MiniMax-M3');
    expect(providerDefaultModel('minimax')).toBe('MiniMax-M3');
  });

  it('recognizes both MiniMax-M3 and MiniMax-M2.7', () => {
    expect(MINIMAX_MODELS).toEqual(['MiniMax-M3', 'MiniMax-M2.7']);
  });
});

describe('callMiniMax', () => {
  beforeEach(() => create.mockReset());

  it('returns parsed JSON values with the minimax provider tag', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: '{"price":"$10"}' } }],
      model: 'MiniMax-M3',
    });
    const out = await callMiniMax({ prompt: 'p', jsonSchema: schema }, 'k');
    expect(out.values).toEqual({ price: '$10' });
    expect(out.provider).toBe('minimax');
    expect(out.model).toBe('MiniMax-M3');
  });

  it('defaults to MiniMax-M3 and uses json_object response_format', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: '{"price":"$1"}' } }],
      model: 'MiniMax-M3',
    });
    await callMiniMax({ prompt: 'p', jsonSchema: schema }, 'k');
    expect(create.mock.calls[0][0].model).toBe('MiniMax-M3');
    expect(create.mock.calls[0][0].response_format).toEqual({ type: 'json_object' });
  });

  it('honors modelOverride (e.g. MiniMax-M2.7)', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: '{"price":"$2"}' } }],
      model: 'MiniMax-M2.7',
    });
    const out = await callMiniMax(
      { prompt: 'p', jsonSchema: schema, modelOverride: 'MiniMax-M2.7' },
      'k',
    );
    expect(create.mock.calls[0][0].model).toBe('MiniMax-M2.7');
    expect(out.model).toBe('MiniMax-M2.7');
  });

  it('retries once on schema validation failure', async () => {
    create
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"price":42}' } }],
        model: 'MiniMax-M3',
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"price":"$5"}' } }],
        model: 'MiniMax-M3',
      });
    const out = await callMiniMax({ prompt: 'p', jsonSchema: schema }, 'k');
    expect(out.values).toEqual({ price: '$5' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].messages.length).toBeGreaterThan(1);
  });

  it('throws after retry still invalid', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: '{"price":42}' } }],
      model: 'MiniMax-M3',
    });
    await expect(
      callMiniMax({ prompt: 'p', jsonSchema: schema }, 'k'),
    ).rejects.toThrow(/schema/i);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('throws on empty content', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: '' } }], model: 'm' });
    await expect(
      callMiniMax({ prompt: 'p', jsonSchema: schema }, 'k'),
    ).rejects.toThrow(/empty content/);
  });
});
