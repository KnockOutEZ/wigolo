import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockSearchEngine, loadPrerecordedResponses } from '../../../../benchmarks/search/mock-engine.js';
import type { PrerecordedResponse } from '../../../../benchmarks/search/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

import { readFileSync, existsSync, readdirSync } from 'node:fs';

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleResponse: PrerecordedResponse = {
  queryId: 'docs-001',
  results: [
    { title: 'TypeScript Docs', url: 'https://typescriptlang.org/docs', snippet: 'TS docs', relevance_score: 0.95, engine: 'searxng' },
    { title: 'MDN Reference', url: 'https://developer.mozilla.org/js', snippet: 'MDN', relevance_score: 0.8, engine: 'searxng' },
    { title: 'Blog Post', url: 'https://blog.example.com/ts', snippet: 'Blog', relevance_score: 0.6, engine: 'searxng' },
  ],
};

describe('loadPrerecordedResponses', () => {
  it('loads all response files from directory', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['docs-001.json', 'docs-002.json'] as any);
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify(sampleResponse))
      .mockReturnValueOnce(JSON.stringify({ ...sampleResponse, queryId: 'docs-002' }));

    const responses = loadPrerecordedResponses('/responses');
    expect(responses.size).toBe(2);
    expect(responses.has('docs-001')).toBe(true);
    expect(responses.has('docs-002')).toBe(true);
  });

  it('throws when directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => loadPrerecordedResponses('/nonexistent')).toThrow();
  });

  it('skips non-JSON files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['docs-001.json', 'README.md', '.DS_Store'] as any);
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleResponse));

    const responses = loadPrerecordedResponses('/responses');
    expect(responses.size).toBe(1);
  });

  it('handles empty directory', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([] as any);
    const responses = loadPrerecordedResponses('/responses');
    expect(responses.size).toBe(0);
  });

  it('skips malformed JSON files gracefully', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['good.json', 'bad.json'] as any);
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify(sampleResponse))
      .mockReturnValueOnce('not valid json {{{');

    const responses = loadPrerecordedResponses('/responses');
    expect(responses.size).toBe(1);
  });
});

describe('MockSearchEngine', () => {
  it('returns prerecorded results for matching query', async () => {
    const responses = new Map<string, PrerecordedResponse>();
    responses.set('docs-001', sampleResponse);

    const engine = new MockSearchEngine(responses, 'docs-001');
    const results = await engine.search('typescript Record utility type');

    expect(results).toHaveLength(3);
    expect(results[0].title).toBe('TypeScript Docs');
    expect(results[0].engine).toBe('mock');
  });

  it('returns empty array for non-matching query', async () => {
    const responses = new Map<string, PrerecordedResponse>();
    const engine = new MockSearchEngine(responses, 'nonexistent');
    const results = await engine.search('anything');
    expect(results).toEqual([]);
  });

  it('respects maxResults option', async () => {
    const responses = new Map<string, PrerecordedResponse>();
    responses.set('docs-001', sampleResponse);

    const engine = new MockSearchEngine(responses, 'docs-001');
    const results = await engine.search('query', { maxResults: 1 });
    expect(results).toHaveLength(1);
  });

  it('has name "mock"', () => {
    const engine = new MockSearchEngine(new Map(), 'x');
    expect(engine.name).toBe('mock');
  });

  it('simulates latency when configured', async () => {
    const responses = new Map<string, PrerecordedResponse>();
    responses.set('docs-001', sampleResponse);

    const engine = new MockSearchEngine(responses, 'docs-001', { simulateLatencyMs: 50 });
    const start = Date.now();
    await engine.search('query');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('can simulate errors', async () => {
    const responses = new Map<string, PrerecordedResponse>();
    const engine = new MockSearchEngine(responses, 'docs-001', { simulateError: true });
    await expect(engine.search('query')).rejects.toThrow();
  });
});
