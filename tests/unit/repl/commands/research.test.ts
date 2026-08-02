import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResearchOutput } from '../../../../src/types.js';
import type { ReplDeps } from '../../../../src/repl/commands/types.js';

vi.mock('../../../../src/tools/research.js', () => ({
  handleResearch: vi.fn(),
}));

import { handleResearch } from '../../../../src/tools/research.js';
import { executeResearch } from '../../../../src/repl/commands/research.js';

function deps(): ReplDeps {
  return {
    router: {} as ReplDeps['router'],
    engines: [],
    backendStatus: {} as ReplDeps['backendStatus'],
  };
}

const okOutput: ResearchOutput = {
  report: 'a report',
  citations: [],
  sources: [],
  sub_queries: [],
  depth: 'standard',
  total_time_ms: 10,
  sampling_supported: false,
};

describe('executeResearch', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns a usage error when no question given', async () => {
    const result = await executeResearch({ command: 'research', positional: [], flags: {} }, deps());
    expect(result.error).toContain('Usage');
    expect(handleResearch).not.toHaveBeenCalled();
  });

  it('joins positionals into the question', async () => {
    vi.mocked(handleResearch).mockResolvedValue({ ok: true, data: okOutput });
    await executeResearch(
      { command: 'research', positional: ['what', 'is', 'rust'], flags: {} },
      deps(),
    );
    expect(handleResearch).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'what is rust' }),
      expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('passes --depth, --max-sources, --domains through', async () => {
    vi.mocked(handleResearch).mockResolvedValue({ ok: true, data: okOutput });
    await executeResearch(
      {
        command: 'research',
        positional: ['topic'],
        flags: { depth: 'comprehensive', 'max-sources': '12', domains: 'a.com,b.com' },
      },
      deps(),
    );
    expect(handleResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        depth: 'comprehensive',
        max_sources: 12,
        include_domains: ['a.com', 'b.com'],
      }),
      expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('surfaces a handler failure as an error envelope', async () => {
    vi.mocked(handleResearch).mockResolvedValue({
      ok: false, error: 'research_failed', error_reason: 'decomposition failed', stage: 'research',
    });
    const result = await executeResearch(
      { command: 'research', positional: ['topic'], flags: {} },
      deps(),
    );
    expect(result.error).toContain('decomposition failed');
  });

  it('handles thrown exceptions', async () => {
    vi.mocked(handleResearch).mockRejectedValue(new Error('splat'));
    const result = await executeResearch(
      { command: 'research', positional: ['topic'], flags: {} },
      deps(),
    );
    expect(result.error).toContain('splat');
  });
});
