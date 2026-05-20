import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
  },
}));

import { callAnthropic } from '../../../../src/integrations/cloud/llm/anthropic.js';

describe('callAnthropic', () => {
  beforeEach(() => create.mockReset());

  it('returns parsed tool input', async () => {
    create.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'extract', input: { price: '$10' } }],
      model: 'claude-haiku-4-5',
    });
    const out = await callAnthropic(
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
    expect(out.provider).toBe('anthropic');
    expect(out.model).toBe('claude-haiku-4-5');
    expect(out.cached).toBe(false);
    expect(typeof out.latencyMs).toBe('number');
  });

  it('forces tool_choice to extract tool', async () => {
    create.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'extract', input: {} }],
      model: 'claude-haiku-4-5',
    });
    await callAnthropic({ prompt: 'p', jsonSchema: { type: 'object' } }, 'k');
    const call = create.mock.calls[0][0];
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'extract' });
    expect(call.tools[0].name).toBe('extract');
    expect(call.tools[0].input_schema).toEqual({ type: 'object' });
  });

  it('throws when no tool_use block returned', async () => {
    create.mockResolvedValue({
      content: [{ type: 'text', text: 'no' }],
      model: 'm',
    });
    await expect(
      callAnthropic({ prompt: 'p', jsonSchema: {} }, 'k'),
    ).rejects.toThrow();
  });

  it('respects modelOverride', async () => {
    create.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'extract', input: {} }],
      model: 'claude-opus-4-6',
    });
    await callAnthropic(
      { prompt: 'p', jsonSchema: {}, modelOverride: 'claude-opus-4-6' },
      'k',
    );
    expect(create.mock.calls[0][0].model).toBe('claude-opus-4-6');
  });
});
