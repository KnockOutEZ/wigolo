import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  extractWithLocalLlm,
  isLocalLlmEnabled,
} from '../../../../../src/extraction/v1/local-llm.js';

const ORIGINAL_PROVIDER = process.env['WIGOLO_LLM_PROVIDER'];
const ORIGINAL_MODEL = process.env['WIGOLO_LLM_MODEL'];

describe('extractWithLocalLlm', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env['WIGOLO_LLM_PROVIDER'];
    delete process.env['WIGOLO_LLM_MODEL'];
  });

  afterEach(() => {
    if (ORIGINAL_PROVIDER === undefined) {
      delete process.env['WIGOLO_LLM_PROVIDER'];
    } else {
      process.env['WIGOLO_LLM_PROVIDER'] = ORIGINAL_PROVIDER;
    }
    if (ORIGINAL_MODEL === undefined) {
      delete process.env['WIGOLO_LLM_MODEL'];
    } else {
      process.env['WIGOLO_LLM_MODEL'] = ORIGINAL_MODEL;
    }
  });

  it('returns null when env is unset', async () => {
    expect(isLocalLlmEnabled()).toBe(false);
    const result = await extractWithLocalLlm({
      schema: { type: 'object' },
      html: '<html></html>',
      url: 'https://e.com',
    });
    expect(result).toBeNull();
  });

  it('calls the endpoint with correct payload and returns parsed JSON', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234';
    process.env['WIGOLO_LLM_MODEL'] = 'my-model';

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ title: 'Hello', count: 1 }) } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await extractWithLocalLlm({
      schema: { type: 'object', properties: { title: { type: 'string' } } },
      html: '<html></html>',
      url: 'https://e.com',
    });

    expect(result).toEqual({ title: 'Hello', count: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe('my-model');
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0].content).toContain('JSON');
  });

  it('accepts a full endpoint URL', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234/v1/chat/completions';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
        { status: 200 },
      ),
    );
    await extractWithLocalLlm({ schema: {}, html: '<html/>', url: 'u' });
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('throws on non-200', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 }),
    );
    await expect(
      extractWithLocalLlm({ schema: {}, html: '<html/>', url: 'u' }),
    ).rejects.toThrow(/500/);
  });

  it('throws on invalid JSON content', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'not json' } }] }),
        { status: 200 },
      ),
    );
    await expect(
      extractWithLocalLlm({ schema: {}, html: '<html/>', url: 'u' }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it('throws on fetch transport error', async () => {
    process.env['WIGOLO_LLM_PROVIDER'] = 'http://localhost:1234';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('econnrefused'));
    await expect(
      extractWithLocalLlm({ schema: {}, html: '<html/>', url: 'u' }),
    ).rejects.toThrow(/econnrefused/);
  });
});
