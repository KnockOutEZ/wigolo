import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

vi.mock('../../src/extraction/llm/anthropic.js', () => ({
  callAnthropic: vi.fn(),
}));

import { extractWithSchemaDetailedAsync } from '../../src/extraction/schema.js';
import { callAnthropic } from '../../src/extraction/llm/anthropic.js';

describe('extractWithSchemaDetailedAsync — llm fallback wiring', () => {
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

  it('fills missing required field from LLM with provenance "llm"', async () => {
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { price: '$1' },
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      cached: false,
      latencyMs: 1,
    });
    const html = '<html><body><h1>Widget</h1></body></html>';
    const schema = {
      type: 'object',
      required: ['price'],
      properties: { price: { type: 'string' } },
    };
    const out = await extractWithSchemaDetailedAsync(html, schema);
    expect(out.values.price).toBe('$1');
    expect(out.provenance.price).toBe('llm');
  });

  it('skips LLM when no required fields are missing', async () => {
    const html =
      '<html><body><span itemprop="price">$2</span></body></html>';
    const schema = {
      type: 'object',
      required: ['price'],
      properties: { price: { type: 'string' } },
    };
    const out = await extractWithSchemaDetailedAsync(html, schema);
    expect(out.values.price).toBe('$2');
    expect(out.provenance.price).not.toBe('llm');
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  it('does not invoke LLM when schema has no required array', async () => {
    const html = '<p/>';
    const schema = {
      type: 'object',
      properties: { price: { type: 'string' } },
    };
    const out = await extractWithSchemaDetailedAsync(html, schema);
    expect(out.values.price).toBeUndefined();
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  it('does not override existing partial values from heuristic', async () => {
    vi.mocked(callAnthropic).mockResolvedValue({
      values: { price: 'LLM-PRICE', name: 'LLM-NAME' },
      provider: 'anthropic',
      model: 'm',
      cached: false,
      latencyMs: 1,
    });
    const html = '<span itemprop="name">heuristic-name</span>';
    const schema = {
      type: 'object',
      required: ['price', 'name'],
      properties: { price: { type: 'string' }, name: { type: 'string' } },
    };
    const out = await extractWithSchemaDetailedAsync(html, schema);
    expect(out.values.name).toBe('heuristic-name');
    expect(out.values.price).toBe('LLM-PRICE');
  });
});
