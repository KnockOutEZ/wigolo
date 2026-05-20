import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const embedMock = vi.fn();
const upsertMock = vi.fn();

vi.mock('../../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(async () => ({
    embed: embedMock,
    dim: 4,
    modelId: 'test-model',
  })),
}));

vi.mock('../../../src/providers/vector-store.js', () => ({
  getVectorStore: vi.fn(async () => ({
    upsert: upsertMock,
    search: vi.fn(),
    delete: vi.fn(),
    size: vi.fn(),
  })),
}));

import { indexCrawlResult, isIndexingEnabled } from '../../../src/crawl/index-to-vec.js';
import type { CrawlResultItem } from '../../../src/types.js';

const originalEnv = process.env.WIGOLO_CRAWL_INDEX;

function makeItem(overrides: Partial<CrawlResultItem> = {}): CrawlResultItem {
  return {
    url: 'https://example.com/page',
    title: 'Sample Page',
    markdown: 'A sufficiently long body about example topics that covers several things.',
    depth: 0,
    ...overrides,
  };
}

describe('isIndexingEnabled', () => {
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WIGOLO_CRAWL_INDEX;
    else process.env.WIGOLO_CRAWL_INDEX = originalEnv;
  });

  it('returns false when WIGOLO_CRAWL_INDEX is unset', () => {
    delete process.env.WIGOLO_CRAWL_INDEX;
    expect(isIndexingEnabled()).toBe(false);
  });

  it('returns true when WIGOLO_CRAWL_INDEX=1', () => {
    process.env.WIGOLO_CRAWL_INDEX = '1';
    expect(isIndexingEnabled()).toBe(true);
  });

  it('returns false when WIGOLO_CRAWL_INDEX has any other value', () => {
    process.env.WIGOLO_CRAWL_INDEX = 'true';
    expect(isIndexingEnabled()).toBe(false);
  });
});

describe('indexCrawlResult', () => {
  beforeEach(() => {
    embedMock.mockReset();
    upsertMock.mockReset();
    embedMock.mockResolvedValue([new Float32Array([0.1, 0.2, 0.3, 0.4])]);
    upsertMock.mockResolvedValue(undefined);
  });

  it('embeds title + first 500 chars and upserts', async () => {
    await indexCrawlResult(makeItem());
    expect(embedMock).toHaveBeenCalledTimes(1);
    const [batch] = embedMock.mock.calls[0];
    expect(batch).toHaveLength(1);
    expect(batch[0]).toContain('Sample Page');
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const [records] = upsertMock.mock.calls[0];
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('https://example.com/page');
    expect(records[0].metadata.url).toBe('https://example.com/page');
    expect(records[0].metadata.modelId).toBe('test-model');
    expect(records[0].metadata.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('skips items with text shorter than MIN_TEXT_LEN', async () => {
    await indexCrawlResult(makeItem({ title: '', markdown: 'hi' }));
    expect(embedMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('truncates summary at 500 characters', async () => {
    const big = 'x'.repeat(2000);
    await indexCrawlResult(makeItem({ markdown: big }));
    expect(embedMock).toHaveBeenCalledTimes(1);
    const [batch] = embedMock.mock.calls[0];
    // title + newline + 500 chars
    expect(batch[0].length).toBeLessThanOrEqual('Sample Page\n'.length + 500);
  });

  it('catches embed errors and never throws', async () => {
    embedMock.mockRejectedValueOnce(new Error('boom'));
    await expect(indexCrawlResult(makeItem())).resolves.toBeUndefined();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('catches upsert errors and never throws', async () => {
    upsertMock.mockRejectedValueOnce(new Error('db down'));
    await expect(indexCrawlResult(makeItem())).resolves.toBeUndefined();
  });

  it('skips upsert when embed returns empty array', async () => {
    embedMock.mockResolvedValueOnce([]);
    await indexCrawlResult(makeItem());
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
