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

vi.mock('../../src/search/reranker/download.js', () => ({
  downloadModelAssets: vi.fn().mockResolvedValue({
    modelPath: '/tmp/model.onnx',
    tokenizerPath: '/tmp/tokenizer.json',
    configPath: '/tmp/tokenizer_config.json',
  }),
}));
vi.mock('../../src/search/reranker/onnx.js', () => ({
  onnxRerank: vi.fn().mockResolvedValue([{ index: 0, score: 0.5 }]),
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

describe.skipIf(!process.env.WIGOLO_RERANKER_TEST)('warmup --all installs SearXNG + reranker in one resolver pass', () => {
  it('after warmup --all, both embedding and reranker subprocesses spawn cleanly (no numpy ImportError)', async () => {
    const { spawnSync } = await import('node:child_process');
    const cliEntry = (await import('node:path')).join(process.cwd(), 'dist', 'index.js');
    const result = spawnSync('node', [cliEntry, 'warmup', '--all', '--plain'], {
      encoding: 'utf-8',
      timeout: 600_000,
      env: { ...process.env },
    });
    expect(result.status, `warmup exit ${result.status}: ${result.stderr.slice(-500)}`).toBe(0);
    expect(result.stderr).not.toMatch(/ImportError: numpy/);
    expect(result.stderr).not.toMatch(/Cannot uninstall numpy/);
    expect(result.stderr).not.toMatch(/numpy.* requires .* but you have/);

    const { onnxRerank } = await import('../../src/search/reranker/onnx.js');
    const out = await onnxRerank('q', [{ text: 'doc' }]);
    expect(out).toHaveLength(1);

    const { resetAllRerankSubprocesses } = await import('../../src/python/reranker-subprocess.js');
    resetAllRerankSubprocesses();
  }, 720_000);
});
