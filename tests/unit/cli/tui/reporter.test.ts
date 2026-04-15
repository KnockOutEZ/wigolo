import { describe, it, expect, beforeEach } from 'vitest';
import { PlainReporter } from '../../../../src/cli/tui/reporter.js';

function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr.write as any) = (chunk: any) => { lines.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = orig as any;
  }
  return lines;
}

describe('PlainReporter', () => {
  let reporter: PlainReporter;

  beforeEach(() => {
    reporter = new PlainReporter('warmup');
  });

  it('start() writes the start line to stderr with the wigolo prefix', () => {
    const lines = captureStderr(() => reporter.start('playwright', 'Installing Playwright Chromium'));
    expect(lines.join('')).toContain('[wigolo warmup] Installing Playwright Chromium');
  });

  it('success() writes the success line', () => {
    const lines = captureStderr(() => {
      reporter.start('playwright', 'Installing Playwright Chromium');
      reporter.success('playwright', 'installed');
    });
    expect(lines.join('')).toContain('installed');
  });

  it('fail() writes the failure line with the error message', () => {
    const lines = captureStderr(() => {
      reporter.start('traf', 'Installing Trafilatura');
      reporter.fail('traf', 'pip not found');
    });
    expect(lines.join('')).toContain('pip not found');
    expect(lines.join('')).toContain('failed');
  });

  it('update() is a no-op for PlainReporter (no mid-task chatter)', () => {
    const lines = captureStderr(() => {
      reporter.start('flash', 'Installing FlashRank');
      reporter.update('flash', 'downloading weights');
    });
    expect(lines.filter(l => l.includes('downloading weights'))).toHaveLength(0);
  });

  it('progress() is a no-op for PlainReporter', () => {
    const lines = captureStderr(() => {
      reporter.start('lp', 'Downloading Lightpanda');
      reporter.progress('lp', 0.5);
      reporter.progress('lp', 1.0);
    });
    expect(lines.filter(l => /\d+%/.test(l))).toHaveLength(0);
  });

  it('note() writes a plain log line', () => {
    const lines = captureStderr(() => reporter.note('Summary:'));
    expect(lines.join('')).toContain('Summary:');
  });

  it('finish() is a no-op (plain mode has no overall bar to close)', () => {
    expect(() => reporter.finish()).not.toThrow();
  });
});
