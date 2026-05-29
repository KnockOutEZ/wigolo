import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import type { SidebarRoute } from '../../../../../src/cli/tui/shell/Sidebar.js';
import { Sidebar } from '../../../../../src/cli/tui/shell/Sidebar.js';

const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const ENTER = '\r';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const TEST_ROUTES: readonly SidebarRoute[] = [
  { id: 'browser',   label: 'Browser',       group: 'settings' },
  { id: 'search',    label: 'Search engine', group: 'settings' },
  { id: 'llm',       label: 'LLM provider',  group: 'settings' },
  { id: 'agents',    label: 'Agents',        group: 'settings' },
  { id: 'cache',     label: 'Cache',         group: 'settings' },
  { id: 'advanced',  label: 'Advanced',      group: 'settings' },
  { id: 'verify',    label: 'Verify',        group: 'actions'  },
  { id: 'doctor',    label: 'Doctor',        group: 'actions'  },
  { id: 'export',    label: 'Export',        group: 'actions'  },
  { id: 'import',    label: 'Import',        group: 'actions'  },
  { id: 'uninstall', label: 'Uninstall',     group: 'actions'  },
];

afterEach(() => {
  cleanup();
});

describe('Sidebar', () => {
  it('renders SETTINGS and ACTIONS group labels', () => {
    const { lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={false}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('SETTINGS');
    expect(frame).toContain('ACTIONS');
  });

  it('renders all 6 settings routes', () => {
    const { lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={false}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Browser');
    expect(frame).toContain('Search engine');
    expect(frame).toContain('LLM provider');
    expect(frame).toContain('Agents');
    expect(frame).toContain('Cache');
    expect(frame).toContain('Advanced');
  });

  it('renders all 5 actions routes', () => {
    const { lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={false}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Verify');
    expect(frame).toContain('Doctor');
    expect(frame).toContain('Export');
    expect(frame).toContain('Import');
    expect(frame).toContain('Uninstall');
  });

  it('renders a divider line between groups', () => {
    const { lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={false}
      />,
    );
    expect(lastFrame()).toContain('─');
  });

  it('↓ moves focus index down through settings into actions', async () => {
    const { stdin, lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={true}
      />,
    );
    await wait(20);
    // Initial focus should be on browser (row 0) — shows ▸
    expect(lastFrame()).toContain('▸');
    // Move down 6 times to reach first actions row (verify)
    for (let i = 0; i < 6; i++) {
      stdin.write(ARROW_DOWN);
      await wait(20);
    }
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const focusedLine = lines.find((l) => l.includes('▸'));
    expect(focusedLine).toBeDefined();
    expect(focusedLine).toContain('Verify');
  });

  it('↑ on row 0 stays at row 0', async () => {
    const { stdin, lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={true}
      />,
    );
    await wait(20);
    stdin.write(ARROW_UP);
    await wait(20);
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const focusedLine = lines.find((l) => l.includes('▸'));
    expect(focusedLine).toContain('Browser');
  });

  it('↓ on last row (row 10) stays at row 10', async () => {
    const { stdin, lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="uninstall"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={true}
      />,
    );
    await wait(20);
    // Move to last row first
    for (let i = 0; i < 10; i++) {
      stdin.write(ARROW_DOWN);
      await wait(15);
    }
    const beforeFrame = lastFrame() ?? '';
    stdin.write(ARROW_DOWN);
    await wait(20);
    const afterFrame = lastFrame() ?? '';
    const beforeLine = beforeFrame.split('\n').find((l) => l.includes('▸')) ?? '';
    const afterLine = afterFrame.split('\n').find((l) => l.includes('▸')) ?? '';
    expect(beforeLine).toContain('Uninstall');
    expect(afterLine).toContain('Uninstall');
  });

  it('Enter calls onSelect with the focused route id', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{}}
        onSelect={onSelect}
        focused={true}
      />,
    );
    await wait(20);
    stdin.write(ENTER);
    await wait(20);
    expect(onSelect).toHaveBeenCalledWith('browser');
  });

  it('Enter calls onSelect with correct id after moving focus', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{}}
        onSelect={onSelect}
        focused={true}
      />,
    );
    await wait(20);
    stdin.write(ARROW_DOWN);
    await wait(20);
    stdin.write(ENTER);
    await wait(20);
    expect(onSelect).toHaveBeenCalledWith('search');
  });

  it('shows ▸ and bold on focused row when focused=true', async () => {
    const { lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={true}
      />,
    );
    await wait(20);
    expect(lastFrame()).toContain('▸');
  });

  it('does not show ▸ when focused=false', () => {
    const { lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{}}
        onSelect={() => {}}
        focused={false}
      />,
    );
    expect(lastFrame() ?? '').not.toContain('▸');
  });

  it('ignores keyboard input when focused=false', async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{}}
        onSelect={onSelect}
        focused={false}
      />,
    );
    await wait(20);
    stdin.write(ARROW_DOWN);
    stdin.write(ENTER);
    await wait(20);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows dirty dot ● for settings route with dirtyByCategory > 0', () => {
    const { lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{ browser: 2 }}
        onSelect={() => {}}
        focused={false}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('●');
  });

  it('does not show dirty dot for settings route with dirtyByCategory === 0', () => {
    const { lastFrame } = render(
      <Sidebar
        routes={TEST_ROUTES}
        activeRoute="browser"
        dirtyByCategory={{ browser: 0 }}
        onSelect={() => {}}
        focused={false}
      />,
    );
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const browserLine = lines.find((l) => l.includes('Browser'));
    expect(browserLine ?? '').not.toContain('●');
  });
});
