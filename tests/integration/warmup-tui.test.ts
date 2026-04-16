import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('../../src/searxng/bootstrap.js', () => ({
  checkPythonAvailable: vi.fn(() => true),
  bootstrapNativeSearxng: vi.fn(async () => undefined),
  getBootstrapState: vi.fn(() => null),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: '/tmp/test-wigolo' })),
}));

vi.mock('../../src/search/flashrank.js', () => ({
  resetAvailabilityCache: vi.fn(),
  isFlashRankAvailable: vi.fn(),
}));

import { runCommand } from '../../src/cli/tui/run-command.js';
import { runWarmup } from '../../src/cli/warmup.js';
import type { WarmupReporter } from '../../src/cli/tui/reporter.js';

class SpyReporter implements WarmupReporter {
  events: string[] = [];
  start(id: string, label: string) { this.events.push(`start:${id}:${label}`); }
  update(id: string, text: string) { this.events.push(`update:${id}:${text}`); }
  progress(id: string, fraction: number) { this.events.push(`progress:${id}:${fraction.toFixed(2)}`); }
  success(id: string, detail?: string) { this.events.push(`success:${id}:${detail ?? ''}`); }
  fail(id: string, err: string) { this.events.push(`fail:${id}:${err}`); }
  note(t: string) { this.events.push(`note:${t}`); }
  finish() { this.events.push('finish'); }
}

describe('runWarmup TUI integration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fires expected events for a clean --all run (mocked installs)', async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    const reporter = new SpyReporter();

    await runWarmup(['--trafilatura', '--reranker', '--firefox'], reporter);

    const startIds = reporter.events.filter(e => e.startsWith('start:')).map(e => e.split(':')[1]);
    const finishedIds = reporter.events
      .filter(e => e.startsWith('success:') || e.startsWith('fail:'))
      .map(e => e.split(':')[1]);
    for (const id of startIds) {
      expect(finishedIds).toContain(id);
    }
    expect(reporter.events[reporter.events.length - 1]).toBe('finish');
  });

  it('fires fail event when runCommand reports non-zero', async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args.includes('trafilatura')) {
        return { code: 1, stdout: '', stderr: 'pip failed', timedOut: false };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    });

    const reporter = new SpyReporter();
    const result = await runWarmup(['--trafilatura'], reporter);

    expect(reporter.events).toEqual(expect.arrayContaining([
      expect.stringMatching(/^fail:trafilatura:/),
    ]));
    expect(result.trafilatura).toBe('failed');
  });

  it('emits the final Summary block via note()', async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    const reporter = new SpyReporter();

    await runWarmup([], reporter);

    expect(reporter.events).toEqual(expect.arrayContaining([
      'note:Summary:',
      expect.stringMatching(/^note:\s+Browser:/),
      expect.stringMatching(/^note:\s+Search engine:/),
    ]));
  });
});
