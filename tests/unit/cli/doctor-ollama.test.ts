import { describe, it, expect, vi } from 'vitest';
import {
  buildOllamaDoctorLines,
  resolveOllamaModelBounded,
  sanitizeForTerminal,
} from '../../../src/cli/doctor.js';

describe('resolveOllamaModelBounded', () => {
  it('returns the picked model when the pick resolves in time', async () => {
    const pick = vi.fn(async () => 'llama3.1:8b');
    expect(await resolveOllamaModelBounded('http://localhost:11434', pick, 400)).toBe('llama3.1:8b');
  });

  it('does NOT hang when the server accepts then stalls — aborts within the timeout', async () => {
    // WHY: the unbounded fetch this replaces would hang doctor forever if the
    // Ollama server accepted the connection then went silent (the exact case
    // the probe defends against). A bounded signal must abort and degrade to
    // "no model" rather than blocking the command indefinitely.
    const pick = vi.fn(
      (_url: string, _fetchImpl: typeof fetch, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          // Mimic the real pickOllamaModel: its fetch honors the signal, so an
          // abort rejects the in-flight call.
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const start = Date.now();
    const result = await resolveOllamaModelBounded('http://localhost:11434', pick, 30);
    const elapsed = Date.now() - start;
    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(2000);
  });

  it('returns undefined (no throw) when the pick rejects', async () => {
    const pick = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await resolveOllamaModelBounded('http://localhost:11434', pick, 400)).toBeUndefined();
  });
});

describe('sanitizeForTerminal', () => {
  it('strips control + ANSI escape bytes from an untrusted model name', () => {
    // WHY: a compromised localhost server could return an ANSI-laden model name;
    // printing it verbatim is a terminal-injection vector.
    expect(sanitizeForTerminal('llama3.1\x1b[31m\x07evil')).toBe('llama3.1[31mevil');
    expect(sanitizeForTerminal('clean-model')).toBe('clean-model');
  });

  it('keeps the injected model name out of the doctor line when it carries control bytes', () => {
    const lines = buildOllamaDoctorLines({
      llmConfigured: true,
      ollamaActive: true,
      reachable: true,
      baseUrl: 'http://localhost:11434',
      model: 'm\x1b[2Jx',
    });
    expect(lines.join('\n')).not.toMatch(/\x1b/);
    expect(lines.join('\n')).toContain('m[2Jx');
  });
});

describe('buildOllamaDoctorLines', () => {
  it('emits an enable-hint when a server is reachable and NO LLM is configured', () => {
    // WHY: the whole point of autodetect is discoverability — a reachable local
    // server with no configured LLM is exactly when the user should learn the lever.
    const lines = buildOllamaDoctorLines({
      llmConfigured: false,
      ollamaActive: false,
      reachable: true,
      baseUrl: 'http://localhost:11434',
    });
    const joined = lines.join('\n');
    expect(joined).toMatch(/local llm server detected/i);
    expect(joined).toContain('http://localhost:11434');
    expect(joined).toMatch(/WIGOLO_LLM_PROVIDER=ollama/);
    expect(joined).toMatch(/no api key/i);
  });

  it('does NOT nag when an LLM is already configured, even if a server is reachable', () => {
    // WHY: hinting at a lever the user already pulled (or pulled a different one)
    // is noise — the hint must be suppressed whenever any LLM is configured.
    const lines = buildOllamaDoctorLines({
      llmConfigured: true,
      ollamaActive: false,
      reachable: true,
      baseUrl: 'http://localhost:11434',
    });
    expect(lines.join('\n')).not.toMatch(/detected/i);
  });

  it('emits NO hint when the server is unreachable', () => {
    // WHY: absence of a server means there is nothing to enable — no hint, no noise.
    const lines = buildOllamaDoctorLines({
      llmConfigured: false,
      ollamaActive: false,
      reachable: false,
      baseUrl: 'http://localhost:11434',
    });
    expect(lines).toEqual([]);
  });

  it('shows resolved base URL + model when ollama is the active provider', () => {
    // WHY: when ollama IS active, doctor must surface WHAT it resolved (base + model)
    // so the user can confirm the right server/model is wired, not just "configured".
    const lines = buildOllamaDoctorLines({
      llmConfigured: true,
      ollamaActive: true,
      reachable: true,
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1:8b',
    });
    const joined = lines.join('\n');
    expect(joined).toMatch(/ollama/i);
    expect(joined).toContain('http://localhost:11434');
    expect(joined).toContain('llama3.1:8b');
    expect(joined).not.toMatch(/detected/i);
  });

  it('shows the ollama active section even when the server is mid-run unreachable', () => {
    // WHY: an active-but-down ollama should still be reported as the configured
    // provider (graceful fallback happens at runtime) — not silently hidden.
    const lines = buildOllamaDoctorLines({
      llmConfigured: true,
      ollamaActive: true,
      reachable: false,
      baseUrl: 'http://localhost:11434',
    });
    expect(lines.join('\n')).toMatch(/ollama/i);
  });
});
