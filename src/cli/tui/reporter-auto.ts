import type { WarmupReporter } from './reporter.js';
import { PlainReporter } from './reporter.js';
import { TuiReporter } from './tui-reporter.js';

export interface AutoReporterOptions {
  plain?: boolean;
  command?: string;
}

export function autoReporter(opts: AutoReporterOptions = {}): WarmupReporter {
  const plain = opts.plain ?? false;
  const isTTY = Boolean(process.stdout.isTTY);
  const isCI =
    process.env.CI === 'true' ||
    process.env.CI === '1' ||
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.BUILDKITE === 'true';

  if (plain || !isTTY || isCI) {
    return new PlainReporter(opts.command ?? 'warmup');
  }
  return new TuiReporter();
}
