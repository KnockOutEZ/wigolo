/**
 * Tests installBrowser action — covers the fail()-interception / error-capture
 * path so a warmup reporter failure surfaces as WriteResult.failed + error.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { WarmupReporter } from '../../../../../src/cli/tui/reporter.js';

const runWarmupMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../src/cli/warmup.js', () => ({
  runWarmup: runWarmupMock,
}));

import { installBrowser } from '../../../../../src/cli/tui/actions/install-browser.js';

function noopReporter(): WarmupReporter {
  return {
    start: vi.fn(),
    update: vi.fn(),
    progress: vi.fn(),
    success: vi.fn(),
    fail: vi.fn(),
    note: vi.fn(),
    finish: vi.fn(),
  };
}

beforeEach(() => {
  runWarmupMock.mockReset();
});

describe('installBrowser', () => {
  it('returns status=ok when warmup completes with no failures', async () => {
    runWarmupMock.mockResolvedValueOnce({});
    const reporter = noopReporter();
    const { result } = await installBrowser({ browser: 'chromium', reporter });
    expect(result.status).toBe('ok');
    expect(result.error).toBeUndefined();
  });

  it('passes --reranker and --embeddings flags to runWarmup', async () => {
    runWarmupMock.mockResolvedValueOnce({});
    const reporter = noopReporter();
    await installBrowser({ browser: 'chromium', reporter });
    const flags = runWarmupMock.mock.calls[0][0] as string[];
    expect(flags).toContain('--reranker');
    expect(flags).toContain('--embeddings');
    expect(flags).not.toContain('--firefox');
  });

  it('adds --firefox when browser=firefox', async () => {
    runWarmupMock.mockResolvedValueOnce({});
    const reporter = noopReporter();
    await installBrowser({ browser: 'firefox', reporter });
    const flags = runWarmupMock.mock.calls[0][0] as string[];
    expect(flags).toContain('--firefox');
  });

  it('captures failure when the warmup reporter reports a fail()', async () => {
    // Simulate warmup invoking reporter.fail() mid-run (the interception path)
    runWarmupMock.mockImplementationOnce(async (_flags: string[], reporter: WarmupReporter) => {
      reporter.fail('reranker', 'model download failed');
      return {};
    });
    const reporter = noopReporter();
    const { result } = await installBrowser({ browser: 'chromium', reporter });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('model download failed');
  });

  it('forwards the fail() through to the caller-supplied reporter', async () => {
    runWarmupMock.mockImplementationOnce(async (_flags: string[], reporter: WarmupReporter) => {
      reporter.fail('embeddings', 'oom');
      return {};
    });
    const reporter = noopReporter();
    await installBrowser({ browser: 'chromium', reporter });
    // The original reporter's fail should still receive the call (wrapping does
    // not swallow it).
    expect(reporter.fail).toHaveBeenCalledWith('embeddings', 'oom');
  });

  it('captures failure when runWarmup throws', async () => {
    runWarmupMock.mockRejectedValueOnce(new Error('disk full'));
    const reporter = noopReporter();
    const { result } = await installBrowser({ browser: 'chromium', reporter });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('disk full');
  });
});
