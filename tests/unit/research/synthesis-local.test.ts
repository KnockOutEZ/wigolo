import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { synthesizeLocal } from '../../../src/research/synthesis-local.js';

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
