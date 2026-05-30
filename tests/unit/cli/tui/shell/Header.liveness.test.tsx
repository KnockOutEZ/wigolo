/**
 * Liveness tests for Header: status-dot pulse + gradient cycle while busy,
 * and reduced-motion guard that short-circuits all animation.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { spinner } from '../../../../../src/cli/tui/theme/motion.js';
import { createActivityStore } from '../../../../../src/cli/tui/state/activity-store.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete process.env.WIGOLO_TUI_REDUCED_MOTION;
  delete process.env.CI;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
});

describe('Header liveness — status-dot pulse', () => {
  it('renders a static dot (●) when not busy', async () => {
    process.env.WIGOLO_TUI_REDUCED_MOTION = '1';

    const { Header } = await import('../../../../../src/cli/tui/shell/Header.js');
    const store = createActivityStore();
    const { lastFrame } = render(
      <Header status="ok" pending={0} toast={null} activityStore={store} />,
    );
    expect(lastFrame()).toContain(spinner.pulse[0]);
  });

  it('renders first pulse frame when busy (initial render)', async () => {
    process.env.WIGOLO_TUI_REDUCED_MOTION = '1';

    const { Header } = await import('../../../../../src/cli/tui/shell/Header.js');
    const store = createActivityStore();
    const end = store.begin('verify');
    const { lastFrame } = render(
      <Header status="ok" pending={0} toast={null} activityStore={store} />,
    );
    // With reduced motion, pulse is static (always frame 0 = ●)
    expect(lastFrame()).toContain(spinner.pulse[0]);
    end();
  });

  it('advances pulse frames in real TTY when busy (real timer)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    delete process.env.CI;
    delete process.env.WIGOLO_TUI_REDUCED_MOTION;

    const { Header } = await import('../../../../../src/cli/tui/shell/Header.js');
    const store = createActivityStore();
    const end = store.begin('verify');

    const { lastFrame } = render(
      <Header status="ok" pending={0} toast={null} activityStore={store} />,
    );

    const before = lastFrame() ?? '';
    expect(spinner.pulse.some((f) => before.includes(f))).toBe(true);

    // Wait longer than two tick durations so frame definitely advances
    await new Promise((r) => setTimeout(r, 300));

    const after = lastFrame() ?? '';
    expect(spinner.pulse.some((f) => after.includes(f))).toBe(true);
    // Frame must have changed
    expect(after).not.toBe(before);

    end();
  });

  it('resets to static dot (●) when busy transitions to idle', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    delete process.env.CI;
    delete process.env.WIGOLO_TUI_REDUCED_MOTION;

    const { Header } = await import('../../../../../src/cli/tui/shell/Header.js');
    const store = createActivityStore();
    const end = store.begin('verify');

    const { lastFrame } = render(
      <Header status="ok" pending={0} toast={null} activityStore={store} />,
    );

    // Let it advance
    await new Promise((r) => setTimeout(r, 300));
    end();

    // Give React a moment to re-render after busy=false
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? '';
    expect(frame).toContain(spinner.pulse[0]);
  });
});

describe('Header liveness — reduced motion guard', () => {
  it('does not cycle pulse when WIGOLO_TUI_REDUCED_MOTION=1', async () => {
    process.env.WIGOLO_TUI_REDUCED_MOTION = '1';

    vi.useFakeTimers();
    const { Header } = await import('../../../../../src/cli/tui/shell/Header.js');
    const store = createActivityStore();
    const end = store.begin('verify');

    const { lastFrame } = render(
      <Header status="ok" pending={0} toast={null} activityStore={store} />,
    );

    const before = lastFrame() ?? '';
    // Advance many ticks — no interval set due to reduced motion
    vi.advanceTimersByTime(5000);
    const after = lastFrame() ?? '';

    // Frame unchanged — no pulse cycling with reduced motion
    expect(after).toBe(before);
    // Always static dot
    expect(after).toContain(spinner.pulse[0]);

    end();
  });

  it('does not cycle gradient when WIGOLO_TUI_REDUCED_MOTION=1', async () => {
    process.env.WIGOLO_TUI_REDUCED_MOTION = '1';

    vi.useFakeTimers();
    const { Header } = await import('../../../../../src/cli/tui/shell/Header.js');
    const store = createActivityStore();
    const end = store.begin('verify');

    const { lastFrame } = render(
      <Header status="ok" pending={0} toast={null} activityStore={store} />,
    );

    const before = lastFrame() ?? '';
    vi.advanceTimersByTime(5000);
    const after = lastFrame() ?? '';

    // No change from timer ticks — gradient animation frozen
    expect(after).toBe(before);
    // Title still present
    expect(after).toContain('wigolo');

    end();
  });
});
