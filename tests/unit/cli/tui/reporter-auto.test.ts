import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { autoReporter } from '../../../../src/cli/tui/reporter-auto.js';
import { PlainReporter } from '../../../../src/cli/tui/reporter.js';
import { TuiReporter } from '../../../../src/cli/tui/tui-reporter.js';

describe('autoReporter', () => {
  const origIsTTY = process.stdout.isTTY;
  const origCI = process.env.CI;
  const origGHA = process.env.GITHUB_ACTIONS;
  const origBK = process.env.BUILDKITE;

  beforeEach(() => {
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.BUILDKITE;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
    if (origCI === undefined) delete process.env.CI; else process.env.CI = origCI;
    if (origGHA === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = origGHA;
    if (origBK === undefined) delete process.env.BUILDKITE; else process.env.BUILDKITE = origBK;
  });

  it('returns TuiReporter when TTY and not CI and not --plain', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const r = autoReporter({ plain: false });
    expect(r).toBeInstanceOf(TuiReporter);
  });

  it('returns PlainReporter when --plain=true even if TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const r = autoReporter({ plain: true });
    expect(r).toBeInstanceOf(PlainReporter);
  });

  it('returns PlainReporter when not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const r = autoReporter({ plain: false });
    expect(r).toBeInstanceOf(PlainReporter);
  });

  it('returns PlainReporter when CI=true', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.CI = 'true';
    const r = autoReporter({ plain: false });
    expect(r).toBeInstanceOf(PlainReporter);
  });

  it('returns PlainReporter when CI=1', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.CI = '1';
    const r = autoReporter({ plain: false });
    expect(r).toBeInstanceOf(PlainReporter);
  });

  it('defaults plain to false when options omitted', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const r = autoReporter();
    expect(r).toBeInstanceOf(TuiReporter);
  });
});
