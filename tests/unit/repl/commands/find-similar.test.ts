import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FindSimilarOutput, StageResult } from '../../../../src/types.js';
import type { ReplDeps } from '../../../../src/repl/commands/types.js';

vi.mock('../../../../src/tools/find-similar.js', () => ({
  handleFindSimilar: vi.fn(),
}));

import { handleFindSimilar } from '../../../../src/tools/find-similar.js';
import { executeFindSimilar } from '../../../../src/repl/commands/find-similar.js';

function deps(): ReplDeps {
  return {
    router: {} as ReplDeps['router'],
    engines: [],
    backendStatus: {} as ReplDeps['backendStatus'],
  };
}

const okOutput: FindSimilarOutput = {
  results: [],
  method: 'hybrid',
  cache_hits: 0,
  search_hits: 0,
  embedding_available: true,
  total_time_ms: 5,
};

describe('executeFindSimilar', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns a usage error when no target given', async () => {
    const result = await executeFindSimilar({ command: 'find-similar', positional: [], flags: {} }, deps());
    expect(result.error).toContain('Usage');
    expect(handleFindSimilar).not.toHaveBeenCalled();
  });

  it('routes a URL positional to input.url', async () => {
    vi.mocked(handleFindSimilar).mockResolvedValue({ ok: true, data: okOutput });
    const result = await executeFindSimilar(
      { command: 'find-similar', positional: ['https://example.com'], flags: {} },
      deps(),
    );
    expect(handleFindSimilar).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com' }),
      expect.anything(), expect.anything(), expect.anything(),
    );
    expect(result).toEqual(okOutput);
  });

  it('routes a non-URL positional to input.concept', async () => {
    vi.mocked(handleFindSimilar).mockResolvedValue({ ok: true, data: okOutput });
    await executeFindSimilar(
      { command: 'find-similar', positional: ['machine', 'learning'], flags: {} },
      deps(),
    );
    expect(handleFindSimilar).toHaveBeenCalledWith(
      expect.objectContaining({ concept: 'machine' }),
      expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('passes --limit, --domains, --no-cache, --no-web through', async () => {
    vi.mocked(handleFindSimilar).mockResolvedValue({ ok: true, data: okOutput });
    await executeFindSimilar(
      {
        command: 'find-similar',
        positional: ['https://example.com'],
        flags: { limit: '7', domains: 'a.com,b.com', 'no-cache': 'true', 'no-web': 'true' },
      },
      deps(),
    );
    expect(handleFindSimilar).toHaveBeenCalledWith(
      expect.objectContaining({
        max_results: 7,
        include_domains: ['a.com', 'b.com'],
        include_cache: false,
        include_web: false,
      }),
      expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('surfaces a handler failure as an error envelope', async () => {
    vi.mocked(handleFindSimilar).mockResolvedValue({
      ok: false, error: 'find_similar_failed', error_reason: 'no signal', stage: 'find_similar',
    });
    const result = await executeFindSimilar(
      { command: 'find-similar', positional: ['https://example.com'], flags: {} },
      deps(),
    );
    expect(result.error).toContain('no signal');
  });

  it('handles thrown exceptions', async () => {
    vi.mocked(handleFindSimilar).mockRejectedValue(new Error('kaboom'));
    const result = await executeFindSimilar(
      { command: 'find-similar', positional: ['https://example.com'], flags: {} },
      deps(),
    );
    expect(result.error).toContain('kaboom');
  });
});
