import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../src/config.js';
import { _resetRerankProviderForTest } from '../../src/providers/rerank-provider.js';
import { rerankResults } from '../../src/search/rerank.js';
import type { MergedSearchResult } from '../../src/search/dedup.js';

const originalEnv = process.env;
const results: MergedSearchResult[] = [
  { title: 'First', url: 'https://first.example', snippet: 'one', relevance_score: 0.8, engines: ['test'] },
  { title: 'Second', url: 'https://second.example', snippet: 'two', relevance_score: 0.2, engines: ['test'] },
];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wigolo-remote-rerank-'));
  process.env = {
    ...originalEnv,
    WIGOLO_CONFIG_PATH: join(dir, 'config.json'),
    WIGOLO_RERANKER: 'remote',
    WIGOLO_RERANK_API_BASE: 'http://127.0.0.1:8082/v1',
    WIGOLO_RERANKER_MODEL: 'test-model',
    WIGOLO_RELEVANCE_THRESHOLD: '0',
  };
  resetConfig();
  _resetRerankProviderForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = originalEnv;
  resetConfig();
  _resetRerankProviderForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('remote rerank through search', () => {
  it('uses the HTTP adapter and returns the reordered search results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }],
    })));
    vi.stubGlobal('fetch', fetchMock);
    const out = await rerankResults('second', results);
    expect(out.map((r) => r.title)).toEqual(['Second', 'First']);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps search usable if the endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const out = await rerankResults('q', results);
    expect(out.map((r) => r.title)).toEqual(['First', 'Second']);
  });
});
