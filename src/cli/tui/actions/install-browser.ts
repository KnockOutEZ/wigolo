/**
 * installBrowser action — installs the selected browser via warmup.
 * Returns a structured result for per-item reporting.
 */
import type { WriteResult } from './types.js';
import type { WarmupReporter } from '../reporter.js';

export interface InstallBrowserOptions {
  browser: 'chromium' | 'firefox';
  reporter: WarmupReporter;
}

export interface InstallBrowserResult {
  result: WriteResult;
}

export async function installBrowser(opts: InstallBrowserOptions): Promise<InstallBrowserResult> {
  const { runWarmup } = await import('../../warmup.js');
  const flags = ['--reranker', '--embeddings'];
  if (opts.browser === 'firefox') flags.push('--firefox');
  let error: string | undefined;
  let failed = false;

  const wrappedReporter: WarmupReporter = {
    ...opts.reporter,
    fail(id: string, err: string) {
      failed = true;
      error = err;
      opts.reporter.fail(id, err);
    },
  };

  try {
    await runWarmup(flags, wrappedReporter);
  } catch (err) {
    failed = true;
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    result: failed
      ? { id: 'browser-install', label: 'Browser install', status: 'failed', error }
      : { id: 'browser-install', label: 'Browser install', status: 'ok' },
  };
}
