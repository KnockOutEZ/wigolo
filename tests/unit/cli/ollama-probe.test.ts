import { describe, it, expect, vi } from 'vitest';
import { probeOllama, resolveProbeBaseUrl, maybeOllamaHint } from '../../../src/cli/ollama-probe.js';
import { DEFAULT_OLLAMA_BASE_URL } from '../../../src/integrations/cloud/llm/custom-backend.js';

describe('resolveProbeBaseUrl', () => {
  it('prefers WIGOLO_LLM_BASE_URL env over the default', () => {
    expect(resolveProbeBaseUrl({ WIGOLO_LLM_BASE_URL: 'http://box:9999' })).toBe('http://box:9999');
  });

  it('falls back to the default local server when nothing is set', () => {
    // WHY: with no override the hint must point users at the canonical local
    // Ollama port, otherwise the suggested env var would target the wrong host.
    expect(resolveProbeBaseUrl({})).toBe(DEFAULT_OLLAMA_BASE_URL);
  });
});

describe('probeOllama', () => {
  it('returns reachable=true when /api/tags responds ok', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
    const res = await probeOllama('http://localhost:11434', fetchImpl);
    expect(res.reachable).toBe(true);
    // WHY: the probe must hit the tags endpoint, not the bare base — a 404 on
    // the root would otherwise be misread as "no server".
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns reachable=false on a non-ok response without throwing', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false }) as Response);
    const res = await probeOllama('http://localhost:11434', fetchImpl);
    expect(res.reachable).toBe(false);
  });

  it('NEVER throws and reports unreachable when the server is absent', async () => {
    // WHY: a down/absent Ollama must never error or change the command's exit
    // code — absence is simply "no hint", a fail-safe path.
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await probeOllama('http://localhost:11434', fetchImpl);
    expect(res.reachable).toBe(false);
  });

  it('returns unreachable (no throw) when the probe times out', async () => {
    // WHY: a slow server must not stall the CLI — the AbortSignal fires and the
    // probe degrades to "no hint" rather than hanging the whole command.
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const res = await probeOllama('http://localhost:11434', fetchImpl, 10);
    expect(res.reachable).toBe(false);
  });

  it('strips a trailing slash from the base before appending /api/tags', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
    await probeOllama('http://localhost:11434/', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.anything(),
    );
  });
});

describe('maybeOllamaHint', () => {
  it('returns a hint string when a server is reachable and no LLM is configured', () => {
    const hint = maybeOllamaHint({ reachable: true, llmConfigured: false, baseUrl: 'http://localhost:11434' });
    expect(hint).toMatch(/local llm server detected/i);
    expect(hint).toContain('http://localhost:11434');
    expect(hint).toMatch(/WIGOLO_LLM_PROVIDER=ollama/);
  });

  it('returns null when an LLM is already configured (no nag)', () => {
    // WHY: the hint is for discovery only — a user who already picked an LLM
    // must not be pestered to switch.
    expect(maybeOllamaHint({ reachable: true, llmConfigured: true, baseUrl: 'http://localhost:11434' })).toBeNull();
  });

  it('returns null when no server is reachable (nothing to enable)', () => {
    expect(maybeOllamaHint({ reachable: false, llmConfigured: false, baseUrl: 'http://localhost:11434' })).toBeNull();
  });
});
