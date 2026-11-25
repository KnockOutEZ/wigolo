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
    vi.mocked(handleFetch).mockResolvedValue({ ok: true, data: baseOutput });
    const result = await executeFetch({ command: 'fetch', positional: ['https://example.com'], flags: {} }, deps);
    expect(handleFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com' }),
      mockRouter,
    );
    expect(result).toEqual(baseOutput);
  });

  it('maps --mode=raw to render_js=never', async () => {
    vi.mocked(handleFetch).mockResolvedValue({ ok: true, data: baseOutput });
    await executeFetch({ command: 'fetch', positional: ['https://example.com'], flags: { mode: 'raw' } }, deps);
    expect(handleFetch).toHaveBeenCalledWith(
      expect.objectContaining({ render_js: 'never' }),
      expect.anything(),
    );
  });

  it('maps --mode=markdown to render_js=auto', async () => {
    vi.mocked(handleFetch).mockResolvedValue({ ok: true, data: baseOutput });
    await executeFetch({ command: 'fetch', positional: ['https://example.com'], flags: { mode: 'markdown' } }, deps);
    expect(handleFetch).toHaveBeenCalledWith(
      expect.objectContaining({ render_js: 'auto' }),
      expect.anything(),
    );
  });

  it('maps --mode=stealth to the schema mode property (not render_js)', async () => {
    vi.mocked(handleFetch).mockResolvedValue({ ok: true, data: baseOutput });
    await executeFetch({ command: 'fetch', positional: ['https://example.com'], flags: { mode: 'stealth' } }, deps);
    expect(handleFetch).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'stealth' }),
      expect.anything(),
    );
    const passed = vi.mocked(handleFetch).mock.calls[0][0];
    expect(passed.render_js).toBeUndefined();
  });

  it('maps --mode=cache and --mode=default to the schema mode property', async () => {
    vi.mocked(handleFetch).mockResolvedValue({ ok: true, data: baseOutput });
    await executeFetch({ command: 'fetch', positional: ['https://example.com'], flags: { mode: 'cache' } }, deps);
    expect(vi.mocked(handleFetch).mock.calls[0][0].mode).toBe('cache');
    vi.clearAllMocks();
    vi.mocked(handleFetch).mockResolvedValue({ ok: true, data: baseOutput });
    await executeFetch({ command: 'fetch', positional: ['https://example.com'], flags: { mode: 'default' } }, deps);
    expect(vi.mocked(handleFetch).mock.calls[0][0].mode).toBe('default');
  });

  it('rejects an unknown --mode value with an error listing all five accepted values', async () => {
    // WHY: --mode is value-dispatched across two schemas (render_js + mode);
    // an invalid value must fail loudly rather than silently no-op.
    const result = await executeFetch({ command: 'fetch', positional: ['https://example.com'], flags: { mode: 'bogus' } }, deps);
    expect(result.error).toBeDefined();
    for (const v of ['raw', 'markdown', 'cache', 'default', 'stealth']) {
      expect(result.error).toContain(v);
    }
    expect(handleFetch).not.toHaveBeenCalled();
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

  it('surfaces solve-ladder provenance on a blocked_by_challenge stage error', async () => {
    // WHY: the MCP tool output carries challenge_class/solve_method on a blocked
    // fetch; the REPL/CLI surface must match, not drop them in the error envelope.
    // A behavioral block is the honest ceiling: classified 'behavioral', no solve.
    vi.mocked(handleFetch).mockResolvedValue({
      ok: false,
      error: 'blocked_by_challenge',
      error_reason: "The site's bot protection served a challenge page that could not be cleared automatically",
      stage: 'fetch',
      http_status: 403,
      challenge_class: 'behavioral',
      solve_method: null,
    } as any);
    const result = await executeFetch({ command: 'fetch', positional: ['https://blocked.example'], flags: {} }, deps);
    expect(result.error).toContain('bot protection');
    expect(result.challenge_class).toBe('behavioral');
    expect(result.solve_method).toBeNull();
  });
});
