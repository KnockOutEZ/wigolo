/**
 * Task 3.2 — Sidebar dirty-dot transient pulse
 *
 * When a category's dirty count drops from N → 0, the dirty dot does a brief
 * 500ms accent-color pulse before vanishing. Gated on reducedMotion().
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import type { SidebarRoute } from '../../../../../src/cli/tui/shell/Sidebar.js';
import { Sidebar } from '../../../../../src/cli/tui/shell/Sidebar.js';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const TEST_ROUTES: readonly SidebarRoute[] = [
  { id: 'llm',     label: 'LLM provider', group: 'settings' },
  { id: 'browser', label: 'Browser',      group: 'settings' },
  { id: 'verify',  label: 'Verify',       group: 'actions'  },
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete process.env.WIGOLO_TUI_REDUCED_MOTION;
});

describe('Sidebar — dirty-dot pulse', () => {
  it('dirty dot ● is visible when dirtyByCategory > 0', () => {
    const { lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="llm"
        dirtyByCategory={{ llm: 1 }}
        onSelect={() => {}}
        focused={false}
      />,
    );
    expect(lastFrame() ?? '').toContain('●');
  });

  it('dirty dot disappears immediately with reducedMotion when count drops to 0', async () => {
    process.env.WIGOLO_TUI_REDUCED_MOTION = '1';

    const { lastFrame, rerender } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="llm"
        dirtyByCategory={{ llm: 1 }}
        onSelect={() => {}}
        focused={false}
      />,
    );
    await wait(20);
    expect(lastFrame() ?? '').toContain('●');

    rerender(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="llm"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={false}
      />,
    );
    await wait(20);
    // With reduced motion, dot vanishes immediately — no pulse phase
    const lines = (lastFrame() ?? '').split('\n');
    const llmLine = lines.find((l) => l.includes('LLM provider')) ?? '';
    expect(llmLine).not.toContain('●');
  });

  it('dirty dot pulses (still visible) briefly after count drops to 0', async () => {
    vi.useFakeTimers();

    const { lastFrame, rerender } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="llm"
        dirtyByCategory={{ llm: 1 }}
        onSelect={() => {}}
        focused={false}
      />,
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(lastFrame() ?? '').toContain('●');

    // Dirty count drops to 0 — pulse begins
    rerender(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="llm"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={false}
      />,
    );

    // Within 500ms pulse window: dot still visible
    await vi.advanceTimersByTimeAsync(100);
    expect(lastFrame() ?? '').toContain('●');
  });

  it('dirty dot vanishes after 500ms pulse completes', async () => {
    vi.useFakeTimers();

    const { lastFrame, rerender } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="llm"
        dirtyByCategory={{ llm: 1 }}
        onSelect={() => {}}
        focused={false}
      />,
    );
    await vi.advanceTimersByTimeAsync(20);

    // Dirty count drops to 0
    rerender(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="llm"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={false}
      />,
    );

    // After 500ms pulse: dot gone
    await vi.advanceTimersByTimeAsync(600);
    const lines = (lastFrame() ?? '').split('\n');
    const llmLine = lines.find((l) => l.includes('LLM provider')) ?? '';
    expect(llmLine).not.toContain('●');
  });

  it('timer cleans up on unmount before pulse completes', async () => {
    vi.useFakeTimers();

    const { unmount, rerender } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="llm"
        dirtyByCategory={{ llm: 1 }}
        onSelect={() => {}}
        focused={false}
      />,
    );
    await vi.advanceTimersByTimeAsync(20);

    rerender(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="llm"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={false}
      />,
    );

    // Unmount before pulse finishes — no dangling timer errors
    unmount();
    // Advance timers: if there were dangling handlers this would cause React
    // "Can't perform a state update on an unmounted component" warnings.
    await vi.advanceTimersByTimeAsync(600);
    // Test passes if no error is thrown
  });
});
