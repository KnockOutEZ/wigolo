import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

import { callOrcaRouter } from '../../../../src/integrations/cloud/llm/orcarouter.js';

const schema = {
  type: 'object',
  required: ['price'],
  properties: { price: { type: 'string' } },
};

describe('callOrcaRouter', () => {
  beforeEach(() => create.mockReset());

  it('returns parsed JSON values', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: '{"price":"$10"}' } }],
      model: 'orcarouter/auto',
    });
    const out = await callOrcaRouter({ prompt: 'p', jsonSchema: schema }, 'k');
    expect(out.values).toEqual({ price: '$10' });
    expect(out.provider).toBe('orcarouter');
  });

  it('uses the OrcaRouter base URL and json_object response_format', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: '{"price":"$1"}' } }],
      model: 'm',
    });
    await callOrcaRouter({ prompt: 'p', jsonSchema: schema }, 'k');
    expect(create.mock.calls[0][0].response_format).toEqual({
      type: 'json_object',
    });
  });

  it('retries once on schema validation failure', async () => {
    create
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"price":42}' } }],
        model: 'm',
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"price":"$5"}' } }],
        model: 'm',
      });
    const out = await callOrcaRouter({ prompt: 'p', jsonSchema: schema }, 'k');
    expect(out.values).toEqual({ price: '$5' });
    expect(create).toHaveBeenCalledTimes(2);
    const retryReq = create.mock.calls[1][0];
    expect(retryReq.messages.length).toBeGreaterThan(1);
  });

  it('throws after retry still invalid', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: '{"price":42}' } }],
      model: 'm',
    });
    await expect(
      callOrcaRouter({ prompt: 'p', jsonSchema: schema }, 'k'),
    ).rejects.toThrow(/schema/i);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('throws on missing required field', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: '{}' } }],
      model: 'm',
    });
    await expect(
      callOrcaRouter({ prompt: 'p', jsonSchema: schema }, 'k'),
    ).rejects.toThrow();
  });
});
