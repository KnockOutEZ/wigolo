import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all four provider SDKs so we can inspect the request body each adapter
// builds. WHY: vision input must produce a multimodal message shape; a wrong
// shape silently drops the image and the model answers blind.
const anthropicCreate = vi.fn();
const openaiCreate = vi.fn();
const geminiGenerate = vi.fn();
const groqCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: geminiGenerate };
  },
}));
vi.mock('groq-sdk', () => ({
  default: class {
    chat = { completions: { create: groqCreate } };
  },
}));

const { callAnthropicText, callOpenAIText, callGeminiText, callGroqText } = await import(
  '../../../../../src/integrations/cloud/llm/text-adapters.js'
);

const IMG = { data: 'aGVsbG8=', mediaType: 'image/png' };

describe('text adapters — vision (image) input', () => {
  beforeEach(() => {
    anthropicCreate.mockReset();
    openaiCreate.mockReset();
    geminiGenerate.mockReset();
    groqCreate.mockReset();
  });

  describe('anthropic', () => {
    it('builds a multimodal content array when image is present', async () => {
      anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], model: 'm' });
      await callAnthropicText({ prompt: 'describe', model: 'm', image: IMG }, 'k');
      const body = anthropicCreate.mock.calls[0][0];
      expect(body.messages[0].content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        { type: 'text', text: 'describe' },
      ]);
    });

    it('sends bare string content when no image (byte-identical text path)', async () => {
      anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], model: 'm' });
      await callAnthropicText({ prompt: 'plain', model: 'm' }, 'k');
      const body = anthropicCreate.mock.calls[0][0];
      expect(body.messages).toEqual([{ role: 'user', content: 'plain' }]);
    });
  });

  describe('gemini', () => {
    it('builds a parts array with inlineData when image is present', async () => {
      geminiGenerate.mockResolvedValue({ text: 'ok' });
      await callGeminiText({ prompt: 'describe', model: 'm', image: IMG }, 'k');
      const req = geminiGenerate.mock.calls[0][0];
      expect(req.contents).toEqual([
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
            { text: 'describe' },
          ],
        },
      ]);
    });

    it('passes bare string contents when no image (byte-identical text path)', async () => {
      geminiGenerate.mockResolvedValue({ text: 'ok' });
      await callGeminiText({ prompt: 'plain', model: 'm' }, 'k');
      const req = geminiGenerate.mock.calls[0][0];
      expect(req.contents).toBe('plain');
    });
  });

  describe('openai', () => {
    it('builds a multimodal content array with a data: url when image is present', async () => {
      openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }], model: 'm' });
      await callOpenAIText({ prompt: 'describe', model: 'm', image: IMG }, 'k');
      const body = openaiCreate.mock.calls[0][0];
      expect(body.messages[0].content).toEqual([
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
      ]);
    });

    it('sends bare string content when no image (byte-identical text path)', async () => {
      openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }], model: 'm' });
      await callOpenAIText({ prompt: 'plain', model: 'm' }, 'k');
      const body = openaiCreate.mock.calls[0][0];
      expect(body.messages).toEqual([{ role: 'user', content: 'plain' }]);
    });
  });

  describe('groq', () => {
    it('ignores image and stays text-only (does not crash)', async () => {
      groqCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }], model: 'm' });
      const out = await callGroqText({ prompt: 'plain', model: 'm', image: IMG }, 'k');
      expect(out.text).toBe('ok');
      const body = groqCreate.mock.calls[0][0];
      expect(body.messages).toEqual([{ role: 'user', content: 'plain' }]);
    });
  });
});
