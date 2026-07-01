/**
 * Evidence-only constraint on schema-mode extraction.
 *
 * Why this matters:
 *
 *   On Wikipedia/Model_Context_Protocol with schema {name, developer, introduced}:
 *     extract returned {
 *       "developer": "Nvidia",     ← wrong (it's Anthropic)
 *       "introduced": "May 2024"   ← wrong (Nov 2024)
 *     }
 *   Wikipedia infobox clearly lists "Developed by: Anthropic, Introduced: November 25,
 *   2024" — so the LLM free-form-completed values that were not literally
 *   present in the page text. This is a significant trust killer.
 *
 * Contract:
 *   - Any field whose value is NOT literally present in the extracted text
 *     (or a trivially derivable transform: number parse, date normalization
 *     where source text contains the number/year/date) MUST be null.
 *   - LLM free-form completion is never permitted to fill a missing value.
 *   - The verification is a substring match (case-insensitive) of the value
 *     against the source markdown/text.
 *
 * The implementation lives in src/extraction/schema-truth.ts (verifier
 * applied AFTER the LLM returns a candidate; values that fail the
 * verifier become null).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/integrations/cloud/llm/anthropic.js', () => ({
  callAnthropic: vi.fn(),
}));

import { extractWithSchemaDetailedAsync } from '../../../src/extraction/schema.js';
import { callAnthropic } from '../../../src/integrations/cloud/llm/anthropic.js';

// MCP-like Wikipedia infobox excerpt. The page lists:
//   Developer(s): Anthropic
//   Initial release: November 25, 2024
// — so a faithful extraction must NEVER return "Nvidia" or "May 2024".
const MCP_WIKI_LIKE_HTML = `
<html>
<body>
<h1>Model Context Protocol</h1>
<table class="infobox">
  <tr><th>Developer(s)</th><td>Anthropic</td></tr>
  <tr><th>Initial release</th><td>November 25, 2024</td></tr>
  <tr><th>Type</th><td>Open standard</td></tr>
</table>
<p>The Model Context Protocol (MCP) is an open standard introduced by
Anthropic in November 2024 for connecting AI assistants to external data
sources and tools.</p>
</body>
</html>
`;

const MCP_SCHEMA = {
  type: 'object',
  required: ['name', 'developer', 'introduced'],
  properties: {
    name: { type: 'string' },
    developer: { type: 'string' },
    introduced: { type: 'string' },
  },
};

describe('schema extraction — evidence-only constraint (C1)', () => {
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
    vi.mocked(callAnthropic).mockReset();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('nulls fields the LLM hallucinated that are not present in source text', async () => {
    // LLM "completes" wrong facts — these were the exact hallucinated values.
    // The evidence-only filter must reject them.
    vi.mocked(callAnthropic).mockResolvedValue({
      values: {
        name: 'Model Context Protocol',
        developer: 'Nvidia', // not in source — must be nulled
        introduced: 'May 2024', // not in source — must be nulled
      },
      provider: 'anthropic',
      model: 'claude',
      cached: false,
      latencyMs: 1,
    });

    const out = await extractWithSchemaDetailedAsync(MCP_WIKI_LIKE_HTML, MCP_SCHEMA);

    // name is in the source text → kept
    expect(out.values.name).toBe('Model Context Protocol');

    // hallucinated values MUST be null — never the LLM's guess
    expect(out.values.developer).not.toBe('Nvidia');
    expect(out.values.introduced).not.toBe('May 2024');
    expect(out.values.developer).toBeNull();
    expect(out.values.introduced).toBeNull();
  });

  it('keeps LLM values that ARE in the source text (positive case)', async () => {
    // When the LLM faithfully extracts what's actually in the page, all
    // fields survive the verifier.
    vi.mocked(callAnthropic).mockResolvedValue({
      values: {
        name: 'Model Context Protocol',
        developer: 'Anthropic',
        introduced: 'November 25, 2024',
      },
      provider: 'anthropic',
      model: 'claude',
      cached: false,
      latencyMs: 1,
    });

    const out = await extractWithSchemaDetailedAsync(MCP_WIKI_LIKE_HTML, MCP_SCHEMA);

    expect(out.values.name).toBe('Model Context Protocol');
    expect(out.values.developer).toBe('Anthropic');
    expect(out.values.introduced).toBe('November 25, 2024');
  });

  it('emits a warning when fields are nulled by the evidence-only filter', async () => {
    // Callers need to know why a field came back null vs why it was missing —
    // a warning surfaces the difference so the caller can debug.
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { name: 'Model Context Protocol', developer: 'Nvidia', introduced: 'May 2024' },
      provider: 'anthropic',
      model: 'claude',
      cached: false,
      latencyMs: 1,
    });

    const out = await extractWithSchemaDetailedAsync(MCP_WIKI_LIKE_HTML, MCP_SCHEMA);

    const warningText = out.warnings.join(' ');
    expect(warningText.toLowerCase()).toContain('evidence');
    expect(warningText).toMatch(/developer|introduced/);
  });

  it('accepts a number value derived from a number literal in the source ("$42" → 42)', async () => {
    // Trivial transform: number parse. Source contains the literal, so the
    // verifier must accept the numeric value the LLM returns.
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { price: 42 },
      provider: 'anthropic',
      model: 'claude',
      cached: false,
      latencyMs: 1,
    });

    const html = '<html><body><p>the price is $42 today</p></body></html>';
    const schema = {
      type: 'object',
      required: ['price'],
      properties: { price: { type: 'number' } },
    };

    const out = await extractWithSchemaDetailedAsync(html, schema);
    expect(out.values.price).toBe(42);
  });

  it('accepts a year value when source text contains the year literal ("released in 2024" → 2024)', async () => {
    // Trivial transform: date normalization. The bare year is present in
    // source — verifier accepts.
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { year: 2024 },
      provider: 'anthropic',
      model: 'claude',
      cached: false,
      latencyMs: 1,
    });

    const html = '<html><body><p>released in 2024 to general acclaim.</p></body></html>';
    const schema = {
      type: 'object',
      required: ['year'],
      properties: { year: { type: 'number' } },
    };

    const out = await extractWithSchemaDetailedAsync(html, schema);
    expect(out.values.year).toBe(2024);
  });

  it('nulls a year when the source only says "recently" (no number in text)', async () => {
    // Contrast to the above: the LLM may guess "2024" from context, but
    // the source text doesn't contain the number — verifier nulls it.
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { year: 2024 },
      provider: 'anthropic',
      model: 'claude',
      cached: false,
      latencyMs: 1,
    });

    const html = '<html><body><p>released recently to general acclaim.</p></body></html>';
    const schema = {
      type: 'object',
      required: ['year'],
      properties: { year: { type: 'number' } },
    };

    const out = await extractWithSchemaDetailedAsync(html, schema);
    expect(out.values.year).toBeNull();
  });

  it('accepts a value present inside a <code> block', async () => {
    // Source-text matching must include code-block content. A `<code>`
    // block is still source content; the LLM may quote a value from it.
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { version: '1.2.3' },
      provider: 'anthropic',
      model: 'claude',
      cached: false,
      latencyMs: 1,
    });

    const html = `
      <html><body>
        <pre><code>npm install foo@1.2.3</code></pre>
      </body></html>`;
    const schema = {
      type: 'object',
      required: ['version'],
      properties: { version: { type: 'string' } },
    };

    const out = await extractWithSchemaDetailedAsync(html, schema);
    expect(out.values.version).toBe('1.2.3');
  });

  it('accepts a value present inside a <blockquote>', async () => {
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { quote_author: 'Ada Lovelace' },
      provider: 'anthropic',
      model: 'claude',
      cached: false,
      latencyMs: 1,
    });

    const html = `
      <html><body>
        <blockquote>"That brain of mine is more than merely mortal," wrote Ada Lovelace in 1843.</blockquote>
      </body></html>`;
    const schema = {
      type: 'object',
      required: ['quote_author'],
      properties: { quote_author: { type: 'string' } },
    };

    const out = await extractWithSchemaDetailedAsync(html, schema);
    expect(out.values.quote_author).toBe('Ada Lovelace');
  });

  it('matches case-insensitively', async () => {
    // The LLM may normalize case (e.g. "ANTHROPIC" → "Anthropic"). A literal
    // case-sensitive substring match would reject this; we accept.
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { developer: 'Anthropic' },
      provider: 'anthropic',
      model: 'claude',
      cached: false,
      latencyMs: 1,
    });

    const html = '<html><body><p>Made by ANTHROPIC in San Francisco.</p></body></html>';
    const schema = {
      type: 'object',
      required: ['developer'],
      properties: { developer: { type: 'string' } },
    };

    const out = await extractWithSchemaDetailedAsync(html, schema);
    expect(out.values.developer).toBe('Anthropic');
  });

  it('accepts values that survive whitespace normalization (multi-line source)', async () => {
    // Multi-line snippet — the source contains the value but split across
    // line breaks. The verifier must normalize whitespace so the value
    // matches the rendered text.
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { developer: 'Anthropic PBC' },
      provider: 'anthropic',
      model: 'claude',
      cached: false,
      latencyMs: 1,
    });

    const html = `
      <html><body>
        <p>Developer:
           Anthropic
           PBC</p>
      </body></html>`;
    const schema = {
      type: 'object',
      required: ['developer'],
      properties: { developer: { type: 'string' } },
    };

    const out = await extractWithSchemaDetailedAsync(html, schema);
    expect(out.values.developer).toBe('Anthropic PBC');
  });

  it('does NOT verify heuristic / structured-data values (only LLM provenance)', async () => {
    // The evidence-only filter is specifically about untrusted LLM output.
    // Values that came from JSON-LD or microdata are already verified by
    // their provenance — we don't double-check them.
    const html = `
      <html><body>
        <script type="application/ld+json">
          {"@type":"Product","name":"Widget","price":"$99"}
        </script>
      </body></html>`;
    const schema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    };

    const out = await extractWithSchemaDetailedAsync(html, schema);
    // name came from JSON-LD; provenance is "json-ld", LLM never invoked.
    expect(out.values.name).toBe('Widget');
    expect(out.provenance.name).toBe('json-ld');
    expect(callAnthropic).not.toHaveBeenCalled();
  });
});
