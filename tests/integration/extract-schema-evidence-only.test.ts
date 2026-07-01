/**
 * Integration test at the `extract` tool boundary for the schema
 * evidence-only filter.
 *
 * The schema-evidence-only unit test covers the verifier; this test pins the
 * contract end-to-end through `handleExtract` so a future refactor of the tool
 * handler can't accidentally bypass the filter.
 *
 * Regression case:
 *   On Wikipedia/Model_Context_Protocol with schema {name, developer, introduced}:
 *     extract returned developer: "Nvidia", introduced: "May 2024"
 *     — both wrong (real values: Anthropic / Nov 2024).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';
import type { SmartRouter } from '../../src/fetch/router.js';

// Mock the local-LLM extraction path. The extract tool routes through
// `extractWithLocalLlm` when ANY LLM provider is configured (see
// src/tools/extract.ts schema-mode branch) — that's the exact path that
// mis-extracted on Wikipedia / Model Context Protocol. We assert the
// evidence-only filter runs AFTER this returns, before the values reach
// the caller.
vi.mock('../../src/extraction/v1/local-llm.js', () => ({
  isLocalLlmEnabled: vi.fn().mockReturnValue(true),
  extractWithLocalLlm: vi.fn(),
}));

import { handleExtract } from '../../src/tools/extract.js';
import { extractWithLocalLlm } from '../../src/extraction/v1/local-llm.js';

// MCP-like Wikipedia infobox excerpt. Source contains the real facts.
const MCP_WIKI_LIKE_HTML = `
<!doctype html>
<html><body>
<h1>Model Context Protocol</h1>
<table class="infobox">
  <tr><th>Developer(s)</th><td>Anthropic</td></tr>
  <tr><th>Initial release</th><td>November 25, 2024</td></tr>
</table>
<p>The Model Context Protocol (MCP) is an open standard introduced by
Anthropic in November 2024.</p>
</body></html>
`;

function noopRouter(): SmartRouter {
  // html input path bypasses the router; this satisfies the parameter shape.
  return {
    fetch: vi.fn(),
    getDomainStats: () => undefined,
  } as unknown as SmartRouter;
}

describe('integration: extract tool — schema mode evidence-only (C1)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.WIGOLO_LLM_PROVIDER;
    process.env.ANTHROPIC_API_KEY = 'k';
    resetConfig();
    initDatabase(':memory:');
    vi.mocked(extractWithLocalLlm).mockReset();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('nulls hallucinated LLM fields at the tool boundary (no Nvidia / May 2024 ever)', async () => {
    // Simulate the exact audit failure: LLM returns wrong values.
    vi.mocked(extractWithLocalLlm).mockResolvedValue({
      name: 'Model Context Protocol',
      developer: 'Nvidia',
      introduced: 'May 2024',
    });

    const result = await handleExtract(
      {
        html: MCP_WIKI_LIKE_HTML,
        mode: 'schema',
        schema: {
          type: 'object',
          required: ['name', 'developer', 'introduced'],
          properties: {
            name: { type: 'string' },
            developer: { type: 'string' },
            introduced: { type: 'string' },
          },
        },
      },
      noopRouter(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    // Hallucinated values must never escape through the tool boundary.
    expect(data.developer).not.toBe('Nvidia');
    expect(data.introduced).not.toBe('May 2024');
    expect(data.developer).toBeNull();
    expect(data.introduced).toBeNull();
    // The name value is in source ("Model Context Protocol" appears in the H1
    // and infobox), so it survives the filter.
    expect(data.name).toBe('Model Context Protocol');

    // Warnings surface the evidence-only filter action so callers can debug.
    expect(result.data.warnings).toBeDefined();
    const warningText = (result.data.warnings ?? []).join(' ').toLowerCase();
    expect(warningText).toContain('evidence');
  });

  it('preserves LLM-extracted values when they are present in source (positive case)', async () => {
    // When the LLM faithfully extracts the facts from source, the tool
    // returns them unmodified — the filter is conservative, not punitive.
    vi.mocked(extractWithLocalLlm).mockResolvedValue({
      name: 'Model Context Protocol',
      developer: 'Anthropic',
      introduced: 'November 25, 2024',
    });

    const result = await handleExtract(
      {
        html: MCP_WIKI_LIKE_HTML,
        mode: 'schema',
        schema: {
          type: 'object',
          required: ['name', 'developer', 'introduced'],
          properties: {
            name: { type: 'string' },
            developer: { type: 'string' },
            introduced: { type: 'string' },
          },
        },
      },
      noopRouter(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    expect(data.name).toBe('Model Context Protocol');
    expect(data.developer).toBe('Anthropic');
    expect(data.introduced).toBe('November 25, 2024');
  });
});
