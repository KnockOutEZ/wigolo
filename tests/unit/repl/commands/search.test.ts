import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchOutput, SearchEngine, RawSearchResult } from '../../../../src/types.js';
import type { SmartRouter } from '../../../../src/fetch/router.js';
import type { BackendStatus } from '../../../../src/server/backend-status.js';

vi.mock('../../../../src/tools/search.js', () => ({
  handleSearch: vi.fn(),
}));

import { handleSearch } from '../../../../src/tools/search.js';
import { executeSearch } from '../../../../src/repl/commands/search.js';
import type { ReplDeps } from '../../../../src/repl/commands/types.js';

const mockRouter = {} as SmartRouter;
const mockEngines: SearchEngine[] = [];
const mockStatus = {} as BackendStatus;
const deps: ReplDeps = { router: mockRouter, engines: mockEngines, backendStatus: mockStatus };

describe('executeSearch', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const baseOutput: SearchOutput = {
    results: [{ title: 'T', url: 'https://a.com', snippet: 'S', relevance_score: 0.9 }],
    query: 'test',
    engines_used: ['stub'],
    total_time_ms: 100,
  };

  it('passes query from positional args to handleSearch', async () => {
    vi.mocked(handleSearch).mockResolvedValue(baseOutput);
    const result = await executeSearch({ command: 'search', positional: ['react hooks'], flags: {} }, deps);
    expect(handleSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'react hooks' }),
      mockEngines,
      mockRouter,
      mockStatus,
    );
    expect(result).toEqual(baseOutput);
  });

  it('maps --limit flag to max_results', async () => {
    vi.mocked(handleSearch).mockResolvedValue(baseOutput);
    await executeSearch({ command: 'search', positional: ['q'], flags: { limit: '10' } }, deps);
    expect(handleSearch).toHaveBeenCalledWith(
      expect.objectContaining({ max_results: 10 }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('maps --domains flag to include_domains', async () => {
    vi.mocked(handleSearch).mockResolvedValue(baseOutput);
    await executeSearch({ command: 'search', positional: ['q'], flags: { domains: 'a.com,b.com' } }, deps);
    expect(handleSearch).toHaveBeenCalledWith(
      expect.objectContaining({ include_domains: ['a.com', 'b.com'] }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('maps --from flag to from_date', async () => {
    vi.mocked(handleSearch).mockResolvedValue(baseOutput);
    await executeSearch({ command: 'search', positional: ['q'], flags: { from: '2024-01-01' } }, deps);
    expect(handleSearch).toHaveBeenCalledWith(
      expect.objectContaining({ from_date: '2024-01-01' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('returns error output when no query provided', async () => {
    const result = await executeSearch({ command: 'search', positional: [], flags: {} }, deps);
    expect(result.error).toContain('query');
  });

  it('handles handler exceptions gracefully', async () => {
    vi.mocked(handleSearch).mockRejectedValue(new Error('network down'));
    const result = await executeSearch({ command: 'search', positional: ['q'], flags: {} }, deps);
    expect(result.error).toContain('network down');
  });
});
