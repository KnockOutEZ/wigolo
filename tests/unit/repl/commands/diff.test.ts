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

/**
 * K16 — the CLI path to `old.content_hash`.
 *
 * The flag exists so a hash printed by an earlier `fetch` can be the left side
 * of a diff without the caller knowing which URL it came from. Resolution of
 * that hash — live row first, then a retained version — belongs to `handleDiff`
 * and is asserted there; what these pin is that the CLI hands the hash down
 * unchanged, and that the right side is still chosen the same way it is in
 * every other shape of the command.
 */
describe('executeDiff --old-hash', () => {
  const HASH = 'a'.repeat(64);

  beforeEach(() => { vi.clearAllMocks(); });

  it('diff <url> --old-hash: left side is the hash, right side the live fetch', async () => {
    vi.mocked(handleFetch).mockResolvedValue({
      ok: true,
      data: {
        url: 'https://example.com', title: '', markdown: 'live body', metadata: {},
        links: [], images: [], cached: false,
      },
    });
    vi.mocked(handleDiff).mockResolvedValue(okDiff);

    const result = await executeDiff(
      { command: 'diff', positional: ['https://example.com'], flags: { 'old-hash': HASH } },
      deps(),
    );

    expect(handleDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        old: { content_hash: HASH },
        new: { markdown: 'live body' },
      }),
    );
    expect(result).toEqual(okDiff.data);
  });

  it('--old-hash with --new skips the fetch entirely', async () => {
    vi.mocked(handleDiff).mockResolvedValue(okDiff);

    await executeDiff(
      { command: 'diff', positional: [], flags: { 'old-hash': HASH, new: 'new text' } },
      deps(),
    );

    expect(handleFetch).not.toHaveBeenCalled();
    expect(handleDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        old: { content_hash: HASH },
        new: { markdown: 'new text' },
      }),
    );
  });

  it('uppercase hex is accepted and normalized to the stored lowercase form', async () => {
    vi.mocked(handleDiff).mockResolvedValue(okDiff);

    await executeDiff(
      { command: 'diff', positional: [], flags: { 'old-hash': 'B'.repeat(64), new: 'x' } },
      deps(),
    );

    expect(handleDiff).toHaveBeenCalledWith(
      expect.objectContaining({ old: { content_hash: 'b'.repeat(64) } }),
    );
  });

  it('--old-hash alone has no right-hand side and returns usage', async () => {
    const result = await executeDiff(
      { command: 'diff', positional: [], flags: { 'old-hash': HASH } },
      deps(),
    );
    expect(result.error).toContain('Usage');
    expect(handleFetch).not.toHaveBeenCalled();
    expect(handleDiff).not.toHaveBeenCalled();
  });

  it('rejects --old-hash together with --old rather than picking one', async () => {
    const result = await executeDiff(
      { command: 'diff', positional: [], flags: { 'old-hash': HASH, old: 'text', new: 'x' } },
      deps(),
    );
    expect(result.error).toContain('--old-hash');
    expect(result.error).toContain('--old');
    expect(handleDiff).not.toHaveBeenCalled();
  });

  /**
   * A malformed value is an input error, not a lookup outcome. Sending it down
   * would come back as the retention-shaped miss ("no retained version carries
   * it"), which invites a caller to read a typo as an eviction.
   */
  it('rejects a value that is not a 64-char hex hash, without a retention story', async () => {
    const result = await executeDiff(
      { command: 'diff', positional: [], flags: { 'old-hash': 'not-a-hash', new: 'x' } },
      deps(),
    );
    expect(result.error).toContain('64');
    expect(result.error).not.toMatch(/retain/i);
    expect(handleDiff).not.toHaveBeenCalled();
  });

  it('does not treat --old-hash as a stray flag', async () => {
    vi.mocked(handleDiff).mockResolvedValue(okDiff);
    const result = await executeDiff(
      { command: 'diff', positional: [], flags: { 'old-hash': HASH, new: 'x' } },
      deps(),
    );
    expect(result.error).toBeUndefined();
  });
});
