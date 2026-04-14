import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CacheOutput } from '../../../../src/types.js';

vi.mock('../../../../src/tools/cache.js', () => ({
  handleCache: vi.fn(),
}));

import { handleCache } from '../../../../src/tools/cache.js';
import { executeCache } from '../../../../src/repl/commands/cache.js';

describe('executeCache', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('routes "cache stats" to stats=true', async () => {
    const output: CacheOutput = { stats: { total_urls: 10, total_size_mb: 1, oldest: 'a', newest: 'b' } };
    vi.mocked(handleCache).mockResolvedValue(output);
    const result = await executeCache({ command: 'cache', positional: ['stats'], flags: {} });
    expect(handleCache).toHaveBeenCalledWith(expect.objectContaining({ stats: true }));
    expect(result).toEqual(output);
  });

  it('routes "cache clear" with query positional', async () => {
    const output: CacheOutput = { cleared: 3 };
    vi.mocked(handleCache).mockResolvedValue(output);
    const result = await executeCache({ command: 'cache', positional: ['clear'], flags: { query: 'old stuff' } });
    expect(handleCache).toHaveBeenCalledWith(expect.objectContaining({ clear: true, query: 'old stuff' }));
    expect(result).toEqual(output);
  });

  it('routes "cache search <query>" to query search', async () => {
    const output: CacheOutput = { results: [] };
    vi.mocked(handleCache).mockResolvedValue(output);
    const result = await executeCache({ command: 'cache', positional: ['search', 'react hooks'], flags: {} });
    expect(handleCache).toHaveBeenCalledWith(expect.objectContaining({ query: 'react hooks' }));
    expect(result).toEqual(output);
  });

  it('defaults to stats when no subcommand', async () => {
    const output: CacheOutput = { stats: { total_urls: 0, total_size_mb: 0, oldest: '', newest: '' } };
    vi.mocked(handleCache).mockResolvedValue(output);
    await executeCache({ command: 'cache', positional: [], flags: {} });
    expect(handleCache).toHaveBeenCalledWith(expect.objectContaining({ stats: true }));
  });

  it('handles handler exceptions', async () => {
    vi.mocked(handleCache).mockRejectedValue(new Error('DB error'));
    const result = await executeCache({ command: 'cache', positional: ['stats'], flags: {} });
    expect(result.error).toContain('DB error');
  });
});
