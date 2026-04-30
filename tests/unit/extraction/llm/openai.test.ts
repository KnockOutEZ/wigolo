import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

import { callOpenAI } from '../../../../src/extraction/llm/openai.js';

describe('callOpenAI', () => {
  beforeEach(() => create.mockReset());

  it('parses json content into values', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: '{"price":"$10"}' } }],
      model: 'gpt-4o-mini',
    });
    const out = await callOpenAI(
      {
        prompt: 'p',
        jsonSchema: {
          type: 'object',
          properties: { price: { type: 'string' } },
        },
      },
      'k',
    );
    expect(out.values).toEqual({ price: '$10' });
    expect(out.provider).toBe('openai');
    expect(out.model).toBe('gpt-4o-mini');
  });

  it('uses json_schema response_format with strict schema', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: '{}' } }],
      model: 'gpt-4o-mini',
    });
    await callOpenAI(
      { prompt: 'p', jsonSchema: { type: 'object', properties: {} } },
      'k',
    );
    const req = create.mock.calls[0][0];
    expect(req.response_format.type).toBe('json_schema');
    expect(req.response_format.json_schema.name).toBe('extract');
    expect(req.response_format.json_schema.strict).toBe(true);
    expect(req.response_format.json_schema.schema).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('throws on missing content', async () => {
    create.mockResolvedValue({ choices: [{ message: {} }], model: 'm' });
    await expect(
      callOpenAI({ prompt: 'p', jsonSchema: {} }, 'k'),
    ).rejects.toThrow();
  });

  it('throws on malformed json content', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: 'not json' } }],
      model: 'm',
    });
    await expect(
      callOpenAI({ prompt: 'p', jsonSchema: {} }, 'k'),
    ).rejects.toThrow();
  });
});
