import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from '../../../../src/cli/tui/run-command.js';
import { installViaClaudeCli } from '../../../../src/cli/tui/config-writer-cli.js';

describe('installViaClaudeCli', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs `claude mcp add wigolo -- npx -y @staticn0va/wigolo` on success', async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: 'added', stderr: '', timedOut: false });
    const r = await installViaClaudeCli();
    expect(runCommand).toHaveBeenCalledWith(
      'claude',
      ['mcp', 'add', 'wigolo', '--', 'npx', '-y', '@staticn0va/wigolo'],
      expect.any(Object),
    );
    expect(r.ok).toBe(true);
    expect(r.alreadyInstalled).toBe(false);
  });

  it('returns alreadyInstalled=true when stderr says "already exists"', async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 1, stdout: '', stderr: 'wigolo already exists', timedOut: false });
    const r = await installViaClaudeCli();
    expect(r.ok).toBe(true);
    expect(r.alreadyInstalled).toBe(true);
  });

  it('returns ok=false on other non-zero exit', async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 2, stdout: '', stderr: 'unknown command', timedOut: false });
    const r = await installViaClaudeCli();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('unknown command');
  });

  it('returns ok=false and a clear message when claude binary is missing (rejection)', async () => {
    vi.mocked(runCommand).mockRejectedValue(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    const r = await installViaClaudeCli();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CLAUDE_NOT_FOUND');
  });

  it('respects dryRun (does not call runCommand)', async () => {
    const r = await installViaClaudeCli({ dryRun: true });
    expect(runCommand).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
  });
});
