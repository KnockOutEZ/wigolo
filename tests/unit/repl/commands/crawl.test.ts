import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CrawlOutput } from '../../../../src/types.js';
import type { SmartRouter } from '../../../../src/fetch/router.js';

vi.mock('../../../../src/tools/crawl.js', () => ({
  handleCrawl: vi.fn(),
}));

import { handleCrawl } from '../../../../src/tools/crawl.js';
import { executeCrawl } from '../../../../src/repl/commands/crawl.js';
import type { ReplDeps } from '../../../../src/repl/commands/types.js';

const mockRouter = {} as SmartRouter;
const deps: ReplDeps = { router: mockRouter, engines: [], backendStatus: {} as any };

describe('executeCrawl', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const baseOutput: CrawlOutput = {
    pages: [{ url: 'https://ex.com', title: 'T', markdown: 'md', depth: 0 }],
    total_found: 10,
    crawled: 1,
  };

  it('passes url from positional args', async () => {
    vi.mocked(handleCrawl).mockResolvedValue(baseOutput);
    const result = await executeCrawl({ command: 'crawl', positional: ['https://ex.com'], flags: {} }, deps);
    expect(handleCrawl).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://ex.com' }),
      mockRouter,
    );
    expect(result).toEqual(baseOutput);
  });

  it('maps --depth to max_depth', async () => {
    vi.mocked(handleCrawl).mockResolvedValue(baseOutput);
    await executeCrawl({ command: 'crawl', positional: ['https://ex.com'], flags: { depth: '3' } }, deps);
    expect(handleCrawl).toHaveBeenCalledWith(
      expect.objectContaining({ max_depth: 3 }),
      expect.anything(),
    );
  });

  it('maps --max-pages to max_pages', async () => {
    vi.mocked(handleCrawl).mockResolvedValue(baseOutput);
    await executeCrawl({ command: 'crawl', positional: ['https://ex.com'], flags: { 'max-pages': '20' } }, deps);
    expect(handleCrawl).toHaveBeenCalledWith(
      expect.objectContaining({ max_pages: 20 }),
      expect.anything(),
    );
  });

  it('maps --strategy flag', async () => {
    vi.mocked(handleCrawl).mockResolvedValue(baseOutput);
    await executeCrawl({ command: 'crawl', positional: ['https://ex.com'], flags: { strategy: 'sitemap' } }, deps);
    expect(handleCrawl).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'sitemap' }),
      expect.anything(),
    );
  });

  it('returns error when no URL provided', async () => {
    const result = await executeCrawl({ command: 'crawl', positional: [], flags: {} }, deps);
    expect(result.error).toContain('URL');
  });

  it('handles handler exceptions', async () => {
    vi.mocked(handleCrawl).mockRejectedValue(new Error('robots.txt denied'));
    const result = await executeCrawl({ command: 'crawl', positional: ['https://ex.com'], flags: {} }, deps);
    expect(result.error).toContain('robots.txt');
  });
});
