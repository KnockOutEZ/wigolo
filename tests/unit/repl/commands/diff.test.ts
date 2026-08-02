import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DiffOutput, FetchOutput, StageResult } from '../../../../src/types.js';
import type { ReplDeps } from '../../../../src/repl/commands/types.js';

vi.mock('../../../../src/tools/diff.js', () => ({
  handleDiff: vi.fn(),
}));
vi.mock('../../../../src/tools/fetch.js', () => ({
  handleFetch: vi.fn(),
}));

import { handleDiff } from '../../../../src/tools/diff.js';
import { handleFetch } from '../../../../src/tools/fetch.js';
import { executeDiff } from '../../../../src/repl/commands/diff.js';

function deps(): ReplDeps {
  return {
    router: {} as ReplDeps['router'],
    engines: [],
    backendStatus: {} as ReplDeps['backendStatus'],
  };
}

const okDiff: StageResult<DiffOutput> = {
  ok: true,
  data: { changed: true, unified_diff: '--- a\n+++ b\n', summary: undefined },
};

describe('executeDiff', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns a usage error when no url and no inline markdown', async () => {
    const result = await executeDiff({ command: 'diff', positional: [], flags: {} }, deps());
    expect(result.error).toContain('Usage');
    expect(handleDiff).not.toHaveBeenCalled();
  });

  it('one-shot diff <url>: fetches live, diffs cached (old.url) vs live (new.markdown)', async () => {
    const live: StageResult<FetchOutput> = {
      ok: true,
      data: {
        url: 'https://example.com',
        title: 'Example',
        markdown: 'live body',
        metadata: {},
        links: [],
        images: [],
        cached: false,
      },
    };
    vi.mocked(handleFetch).mockResolvedValue(live);
    vi.mocked(handleDiff).mockResolvedValue(okDiff);

    const result = await executeDiff(
      { command: 'diff', positional: ['https://example.com'], flags: {} },
      deps(),
    );

    expect(handleFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com' }),
      expect.anything(),
    );
    expect(handleDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        old: { url: 'https://example.com' },
        new: { markdown: 'live body' },
      }),
    );
    expect(result).toEqual(okDiff.data);
  });

  it('passes --output and --granularity through', async () => {
    vi.mocked(handleFetch).mockResolvedValue({
      ok: true,
      data: {
        url: 'https://example.com', title: '', markdown: 'x', metadata: {},
        links: [], images: [], cached: false,
      },
    });
    vi.mocked(handleDiff).mockResolvedValue(okDiff);

    await executeDiff(
      { command: 'diff', positional: ['https://example.com'], flags: { output: 'summary', granularity: 'word' } },
      deps(),
    );
    expect(handleDiff).toHaveBeenCalledWith(
      expect.objectContaining({ output: 'summary', granularity: 'word' }),
    );
  });

  it('inline mode: --old and --new markdown skip the live fetch', async () => {
    vi.mocked(handleDiff).mockResolvedValue(okDiff);
    const result = await executeDiff(
      { command: 'diff', positional: [], flags: { old: 'old text', new: 'new text' } },
      deps(),
    );
    expect(handleFetch).not.toHaveBeenCalled();
    expect(handleDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        old: { markdown: 'old text' },
        new: { markdown: 'new text' },
      }),
    );
    expect(result).toEqual(okDiff.data);
  });

  it('surfaces a failed live fetch as a diff error envelope', async () => {
    vi.mocked(handleFetch).mockResolvedValue({
      ok: false, error: 'fetch_failed', error_reason: 'network down', stage: 'fetch',
    });
    const result = await executeDiff(
      { command: 'diff', positional: ['https://example.com'], flags: {} },
      deps(),
    );
    expect(result.error).toContain('network down');
    expect(handleDiff).not.toHaveBeenCalled();
  });

  it('surfaces a handleDiff failure as an error envelope', async () => {
    vi.mocked(handleFetch).mockResolvedValue({
      ok: true,
      data: {
        url: 'https://example.com', title: '', markdown: 'x', metadata: {},
        links: [], images: [], cached: false,
      },
    });
    vi.mocked(handleDiff).mockResolvedValue({
      ok: false, error: 'cache_miss', error_reason: 'No cached content', stage: 'diff',
    });
    const result = await executeDiff(
      { command: 'diff', positional: ['https://example.com'], flags: {} },
      deps(),
    );
    expect(result.error).toContain('No cached content');
  });

  it('handles thrown exceptions', async () => {
    vi.mocked(handleFetch).mockRejectedValue(new Error('boom'));
    const result = await executeDiff(
      { command: 'diff', positional: ['https://example.com'], flags: {} },
      deps(),
    );
    expect(result.error).toContain('boom');
  });
});
