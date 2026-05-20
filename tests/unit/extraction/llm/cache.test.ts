import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../../src/cache/db.js';
import {
  ensureLLMCacheTable,
  lookupLLMCache,
  insertLLMCache,
} from '../../../../src/integrations/cloud/llm/cache.js';

describe('llm cache', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    ensureLLMCacheTable();
  });
  afterEach(() => {
    closeDatabase();
  });

  it('miss → insert → hit', () => {
    expect(lookupLLMCache('m', 'p1', 's1')).toBeNull();
    insertLLMCache({
      modelId: 'm',
      promptHash: 'p1',
      schemaHash: 's1',
      response: '{"x":1}',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    expect(lookupLLMCache('m', 'p1', 's1')).toBe('{"x":1}');
  });

  it('expired rows are not returned', () => {
    insertLLMCache({
      modelId: 'm',
      promptHash: 'p2',
      schemaHash: 's2',
      response: '{}',
      createdAt: 0,
      expiresAt: 1,
    });
    expect(lookupLLMCache('m', 'p2', 's2')).toBeNull();
  });

  it('different model id is a separate row', () => {
    insertLLMCache({
      modelId: 'm1',
      promptHash: 'p',
      schemaHash: 's',
      response: 'a',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    insertLLMCache({
      modelId: 'm2',
      promptHash: 'p',
      schemaHash: 's',
      response: 'b',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    expect(lookupLLMCache('m1', 'p', 's')).toBe('a');
    expect(lookupLLMCache('m2', 'p', 's')).toBe('b');
  });

  it('re-insert with same key replaces row', () => {
    insertLLMCache({
      modelId: 'm',
      promptHash: 'p',
      schemaHash: 's',
      response: 'old',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    insertLLMCache({
      modelId: 'm',
      promptHash: 'p',
      schemaHash: 's',
      response: 'new',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    expect(lookupLLMCache('m', 'p', 's')).toBe('new');
  });
});
