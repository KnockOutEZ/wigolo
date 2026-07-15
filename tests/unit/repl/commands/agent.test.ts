import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentOutput } from '../../../../src/types.js';
import type { ReplDeps } from '../../../../src/repl/commands/types.js';

vi.mock('../../../../src/tools/agent.js', () => ({
  handleAgent: vi.fn(),
}));

import { handleAgent } from '../../../../src/tools/agent.js';
import { executeAgent } from '../../../../src/repl/commands/agent.js';

function deps(): ReplDeps {
  return {
    router: {} as ReplDeps['router'],
    engines: [],
    backendStatus: {} as ReplDeps['backendStatus'],
  };
}

const okOutput: AgentOutput = {
  result: 'done',
  sources: [],
  pages_fetched: 0,
  steps: [],
  total_time_ms: 8,
  sampling_supported: false,
};

describe('executeAgent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns a usage error when no prompt given', async () => {
    const result = await executeAgent({ command: 'agent', positional: [], flags: {} }, deps());
    expect(result.error).toContain('Usage');
    expect(handleAgent).not.toHaveBeenCalled();
  });

  it('joins positionals into the prompt', async () => {
    vi.mocked(handleAgent).mockResolvedValue({ ok: true, data: okOutput });
    await executeAgent(
      { command: 'agent', positional: ['gather', 'pricing'], flags: {} },
      deps(),
    );
    expect(handleAgent).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'gather pricing' }),
      expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('passes --urls, --max-pages, --max-time through', async () => {
    vi.mocked(handleAgent).mockResolvedValue({ ok: true, data: okOutput });
    await executeAgent(
      {
        command: 'agent',
        positional: ['prompt'],
        flags: { urls: 'https://a.com,https://b.com', 'max-pages': '5', 'max-time': '30000' },
      },
      deps(),
    );
    expect(handleAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        urls: ['https://a.com', 'https://b.com'],
        max_pages: 5,
        max_time_ms: 30000,
      }),
      expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('surfaces a handler failure as an error envelope', async () => {
    vi.mocked(handleAgent).mockResolvedValue({
      ok: false, error: 'agent_failed', error_reason: 'plan aborted', stage: 'agent',
    });
    const result = await executeAgent(
      { command: 'agent', positional: ['prompt'], flags: {} },
      deps(),
    );
    expect(result.error).toContain('plan aborted');
  });

  it('handles thrown exceptions', async () => {
    vi.mocked(handleAgent).mockRejectedValue(new Error('wham'));
    const result = await executeAgent(
      { command: 'agent', positional: ['prompt'], flags: {} },
      deps(),
    );
    expect(result.error).toContain('wham');
  });
});
