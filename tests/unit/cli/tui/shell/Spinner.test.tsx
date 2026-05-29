import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { spinner } from '../../../../../src/cli/tui/theme/motion.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete process.env.WIGOLO_TUI_REDUCED_MOTION;
  delete process.env.CI;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
});

describe('Spinner', () => {
  it('renders one of the dots frames at initial render', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    delete process.env.CI;
    delete process.env.WIGOLO_TUI_REDUCED_MOTION;
    vi.useFakeTimers();
    const { Spinner } = await import('../../../../../src/cli/tui/shell/Spinner.js');
    const { lastFrame } = render(<Spinner />);
    const frame = lastFrame() ?? '';
    const matchesAFrame = spinner.dots.some((f) => frame.includes(f));
    expect(matchesAFrame).toBe(true);
  });

  it('advances frame after 80ms when running in real TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    delete process.env.CI;
    delete process.env.WIGOLO_TUI_REDUCED_MOTION;
    const { Spinner } = await import('../../../../../src/cli/tui/shell/Spinner.js');
    const { lastFrame } = render(<Spinner />);
    const before = lastFrame() ?? '';
    expect(spinner.dots.some((f) => before.includes(f))).toBe(true);
    await new Promise((r) => setTimeout(r, 90));
    const after = lastFrame() ?? '';
    expect(spinner.dots.some((f) => after.includes(f))).toBe(true);
    const beforeIndex = spinner.dots.findIndex((f) => before.includes(f));
    const afterIndex = spinner.dots.findIndex((f) => after.includes(f));
    if (beforeIndex >= 0 && afterIndex >= 0) {
      expect(afterIndex).toBe((beforeIndex + 1) % spinner.dots.length);
    }
  });

  it('renders static ellipsis when reduced motion is on', async () => {
    process.env.WIGOLO_TUI_REDUCED_MOTION = '1';
    const { Spinner } = await import('../../../../../src/cli/tui/shell/Spinner.js');
    const { lastFrame } = render(<Spinner />);
    expect(lastFrame()).toContain('…');
  });

  it('does not advance frame when CI=true (reduced motion)', async () => {
    process.env.CI = 'true';
    vi.useFakeTimers();
    const { Spinner } = await import('../../../../../src/cli/tui/shell/Spinner.js');
    const { lastFrame } = render(<Spinner />);
    const before = lastFrame() ?? '';
    vi.advanceTimersByTime(800);
    const after = lastFrame() ?? '';
    expect(before).toBe(after);
    expect(after).toContain('…');
  });
});
