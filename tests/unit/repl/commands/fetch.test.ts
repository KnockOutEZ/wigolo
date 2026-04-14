import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchOutput } from '../../../../src/types.js';
import type { SmartRouter } from '../../../../src/fetch/router.js';

vi.mock('../../../../src/tools/fetch.js', () => ({
  handleFetch: vi.fn(),
}));

import { handleFetch } from '../../../../src/tools/fetch.js';
import { executeFetch } from '../../../../src/repl/commands/fetch.js';
import type { ReplDeps } from '../../../../src/repl/commands/types.js';

const mockRouter = {} as SmartRouter;
const deps: ReplDeps = { router: mockRouter, engines: [], backendStatus: {} as any };

describe('executeFetch', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const baseOutput: FetchOutput = {
    url: 'https://example.com',
    title: 'Example',
    markdown: '# Hello',
    metadata: {},
    links: [],
    images: [],
    cached: false,
  };

  it('passes url from positional args', async () => {
    vi.mocked(handleFetch).mockResolvedValue(baseOutput);
    const result = await executeFetch({ command: 'fetch', positional: ['https://example.com'], flags: {} }, deps);
    expect(handleFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com' }),
      mockRouter,
    );
    expect(result).toEqual(baseOutput);
  });

  it('maps --mode=raw to render_js=never', async () => {
    vi.mocked(handleFetch).mockResolvedValue(baseOutput);
    await executeFetch({ command: 'fetch', positional: ['https://example.com'], flags: { mode: 'raw' } }, deps);
    expect(handleFetch).toHaveBeenCalledWith(
      expect.objectContaining({ render_js: 'never' }),
      expect.anything(),
    );
  });

  it('maps --mode=markdown to render_js=auto', async () => {
    vi.mocked(handleFetch).mockResolvedValue(baseOutput);
    await executeFetch({ command: 'fetch', positional: ['https://example.com'], flags: { mode: 'markdown' } }, deps);
    expect(handleFetch).toHaveBeenCalledWith(
      expect.objectContaining({ render_js: 'auto' }),
      expect.anything(),
    );
  });

  it('returns error when no URL provided', async () => {
    const result = await executeFetch({ command: 'fetch', positional: [], flags: {} }, deps);
    expect(result.error).toContain('URL');
  });

  it('handles handler exceptions', async () => {
    vi.mocked(handleFetch).mockRejectedValue(new Error('timeout'));
    const result = await executeFetch({ command: 'fetch', positional: ['https://ex.com'], flags: {} }, deps);
    expect(result.error).toContain('timeout');
  });
});
