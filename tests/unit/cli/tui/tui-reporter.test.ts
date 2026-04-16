import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const oraMocks: Array<{ start: ReturnType<typeof vi.fn>; succeed: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; text: string }> = [];

vi.mock('ora', () => {
  const factory = vi.fn((arg: any) => {
    const text = typeof arg === 'string' ? arg : (arg?.text ?? '');
    const inst = {
      text,
      start: vi.fn(function (this: any) { this.isSpinning = true; return this; }),
      succeed: vi.fn(function (this: any, t?: string) { this.finalText = t; return this; }),
      fail: vi.fn(function (this: any, t?: string) { this.finalText = t; return this; }),
      stop: vi.fn(function (this: any) { this.isSpinning = false; return this; }),
      isSpinning: false,
    };
    oraMocks.push(inst as any);
    return inst;
  });
  return { default: factory };
});

const barInstances: Array<{ start: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];

vi.mock('cli-progress', () => {
  class SingleBar {
    start = vi.fn();
    update = vi.fn();
    stop = vi.fn();
    constructor() {
      barInstances.push(this as any);
    }
  }
  return {
    default: {
      SingleBar,
      Presets: { shades_classic: {} },
    },
  };
});

import { TuiReporter } from '../../../../src/cli/tui/tui-reporter.js';

describe('TuiReporter', () => {
  beforeEach(() => {
    oraMocks.length = 0;
    barInstances.length = 0;
  });

  afterEach(() => vi.clearAllMocks());

  it('start() creates and starts an ora spinner for the id', () => {
    const r = new TuiReporter();
    r.start('pw', 'Installing Playwright');
    expect(oraMocks).toHaveLength(1);
    expect(oraMocks[0].start).toHaveBeenCalledTimes(1);
    expect(oraMocks[0].text).toContain('Installing Playwright');
  });

  it('update() changes spinner text without creating a new spinner', () => {
    const r = new TuiReporter();
    r.start('pw', 'Installing Playwright');
    r.update('pw', 'Downloading chromium');
    expect(oraMocks[0].text).toBe('Downloading chromium');
  });

  it('success() calls succeed with the detail text', () => {
    const r = new TuiReporter();
    r.start('pw', 'Installing Playwright');
    r.success('pw', 'ready');
    expect(oraMocks[0].succeed).toHaveBeenCalledWith(expect.stringContaining('ready'));
  });

  it('fail() calls fail on the spinner', () => {
    const r = new TuiReporter();
    r.start('pw', 'Installing Playwright');
    r.fail('pw', 'pip not found');
    expect(oraMocks[0].fail).toHaveBeenCalledWith(expect.stringContaining('pip not found'));
  });

  it('progress() promotes the spinner to a progress bar on first call', () => {
    const r = new TuiReporter();
    r.start('lp', 'Downloading Lightpanda', { totalBytes: 50_000_000 });
    r.progress('lp', 0.25);
    expect(barInstances).toHaveLength(1);
    expect(barInstances[0].start).toHaveBeenCalledWith(50_000_000, 0);
    expect(barInstances[0].update).toHaveBeenCalledWith(12_500_000);
  });

  it('progress() on a step with no totalBytes falls back to spinner text', () => {
    const r = new TuiReporter();
    r.start('sx', 'Bootstrapping SearXNG');
    r.progress('sx', 0.3);
    expect(barInstances).toHaveLength(0);
    expect(oraMocks[0].text).toMatch(/30%/);
  });

  it('success() after progress() stops the bar and writes a success line', () => {
    const r = new TuiReporter();
    r.start('lp', 'Downloading Lightpanda', { totalBytes: 1000 });
    r.progress('lp', 0.5);
    r.success('lp', 'installed');
    expect(barInstances[0].stop).toHaveBeenCalled();
  });

  it('finish() stops any still-running spinners', () => {
    const r = new TuiReporter();
    r.start('a', 'A');
    r.start('b', 'B');
    r.finish();
    expect(oraMocks[0].stop).toHaveBeenCalled();
    expect(oraMocks[1].stop).toHaveBeenCalled();
  });

  it('note() writes text to stdout', () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as any) = (chunk: any) => { writes.push(String(chunk)); return true; };
    try {
      const r = new TuiReporter();
      r.note('Summary:');
    } finally {
      process.stdout.write = orig as any;
    }
    expect(writes.join('')).toContain('Summary:');
  });
});
