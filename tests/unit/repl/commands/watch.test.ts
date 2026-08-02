import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WatchJobOutput, WatchJob, StageResult } from '../../../../src/types.js';
import type { ReplDeps } from '../../../../src/repl/commands/types.js';

vi.mock('../../../../src/tools/watch.js', () => ({
  handleWatch: vi.fn(),
}));

import { handleWatch } from '../../../../src/tools/watch.js';
import { executeWatch, WATCH_SCHEDULER_CAVEAT } from '../../../../src/repl/commands/watch.js';

function deps(): ReplDeps {
  return {
    router: {} as ReplDeps['router'],
    engines: [],
    backendStatus: {} as ReplDeps['backendStatus'],
  };
}

const job: WatchJob = {
  id: 'job-1',
  url: 'https://example.com',
  interval_seconds: 120,
  status: 'active',
  notification: 'inline',
  created_at: 0,
};

const okList: StageResult<WatchJobOutput> = { ok: true, data: { jobs: [job] } };

describe('executeWatch', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('maps "add <url>" to action=create with interval', async () => {
    vi.mocked(handleWatch).mockResolvedValue({ ok: true, data: { job, jobs: [job] } });
    const result = await executeWatch(
      { command: 'watch', positional: ['add', 'https://example.com'], flags: { interval: '120' } },
      deps(),
    );
    expect(handleWatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create', url: 'https://example.com', interval_seconds: 120 }),
      expect.anything(),
    );
    expect(result.jobs).toHaveLength(1);
  });

  it('add attaches the scheduler caveat notice', async () => {
    vi.mocked(handleWatch).mockResolvedValue({ ok: true, data: { job, jobs: [job] } });
    const result = await executeWatch(
      { command: 'watch', positional: ['add', 'https://example.com'], flags: { interval: '120' } },
      deps(),
    );
    expect(result.notice).toBe(WATCH_SCHEDULER_CAVEAT);
    expect(result.notice).toContain('wigolo serve');
    expect(result.notice).toContain('MCP session');
  });

  it('maps "list" to action=list without a caveat notice', async () => {
    vi.mocked(handleWatch).mockResolvedValue(okList);
    const result = await executeWatch(
      { command: 'watch', positional: ['list'], flags: {} },
      deps(),
    );
    expect(handleWatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'list' }),
      expect.anything(),
    );
    expect(result.notice).toBeUndefined();
  });

  it('maps "rm <job_id>" to action=delete (with caveat)', async () => {
    vi.mocked(handleWatch).mockResolvedValue({ ok: true, data: { jobs: [job] } });
    const result = await executeWatch(
      { command: 'watch', positional: ['rm', 'job-1'], flags: {} },
      deps(),
    );
    expect(handleWatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'delete', job_id: 'job-1' }),
      expect.anything(),
    );
    expect(result.notice).toBe(WATCH_SCHEDULER_CAVEAT);
  });

  it('maps "run <job_id>" to action=check (read, no caveat)', async () => {
    vi.mocked(handleWatch).mockResolvedValue({
      ok: true,
      data: { jobs: [job], changes_since_last: [{ url: job.url, changed: false }] },
    });
    const result = await executeWatch(
      { command: 'watch', positional: ['run', 'job-1'], flags: {} },
      deps(),
    );
    expect(handleWatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'check', job_id: 'job-1' }),
      expect.anything(),
    );
    expect(result.notice).toBeUndefined();
  });

  it('returns a usage error for an unknown subcommand', async () => {
    const result = await executeWatch(
      { command: 'watch', positional: ['frobnicate'], flags: {} },
      deps(),
    );
    expect(result.error).toContain('Usage');
    expect(handleWatch).not.toHaveBeenCalled();
  });

  it('returns a usage error when no subcommand given', async () => {
    const result = await executeWatch(
      { command: 'watch', positional: [], flags: {} },
      deps(),
    );
    expect(result.error).toContain('Usage');
    expect(handleWatch).not.toHaveBeenCalled();
  });

  it('surfaces a handler failure as an error envelope', async () => {
    vi.mocked(handleWatch).mockResolvedValue({
      ok: false, error: 'invalid_input', error_reason: 'interval_seconds must be >= 60', stage: 'watch',
    });
    const result = await executeWatch(
      { command: 'watch', positional: ['add', 'https://example.com'], flags: { interval: '5' } },
      deps(),
    );
    expect(result.error).toContain('interval_seconds must be >= 60');
    expect(result.notice).toBeUndefined();
  });

  it('handles thrown exceptions', async () => {
    vi.mocked(handleWatch).mockRejectedValue(new Error('db gone'));
    const result = await executeWatch(
      { command: 'watch', positional: ['list'], flags: {} },
      deps(),
    );
    expect(result.error).toContain('db gone');
  });
});
