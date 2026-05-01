import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

import { callGemini } from '../../../../src/extraction/llm/gemini.js';

describe('callGemini', () => {
  beforeEach(() => generateContent.mockReset());

  it('parses JSON text response', async () => {
    generateContent.mockResolvedValue({ text: '{"price":"$10"}' });
    const out = await callGemini(
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
    expect(out.provider).toBe('gemini');
  });

  it('configures responseMimeType + responseJsonSchema', async () => {
    generateContent.mockResolvedValue({ text: '{}' });
    await callGemini(
      { prompt: 'p', jsonSchema: { type: 'object', properties: {} } },
      'k',
    );
    const req = generateContent.mock.calls[0][0];
    expect(req.config.responseMimeType).toBe('application/json');
    expect(req.config.responseJsonSchema).toEqual({
      type: 'object',
      properties: {},
    });
    expect(req.model).toBe('gemini-2.5-flash-lite');
  });

  it('throws on missing text', async () => {
    generateContent.mockResolvedValue({ text: undefined });
    await expect(
      callGemini({ prompt: 'p', jsonSchema: {} }, 'k'),
    ).rejects.toThrow();
  });

  it('throws on invalid JSON text', async () => {
    generateContent.mockResolvedValue({ text: 'not json' });
    await expect(
      callGemini({ prompt: 'p', jsonSchema: {} }, 'k'),
    ).rejects.toThrow();
  });
});
