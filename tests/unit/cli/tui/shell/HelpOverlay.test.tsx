import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { HelpOverlay } from '../../../../../src/cli/tui/shell/HelpOverlay.js';

afterEach(() => {
  cleanup();
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('HelpOverlay', () => {
  it('shows all required keybind labels', async () => {
    const { lastFrame } = render(<HelpOverlay onClose={() => {}} />);
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑↓');
    expect(frame).toContain('Tab');
    expect(frame).toContain('esc');
    expect(frame).toContain('⌃k');
    expect(frame).toContain('?');
    expect(frame).toContain('q');
  });

  it('shows Enter keybind', async () => {
    const { lastFrame } = render(<HelpOverlay onClose={() => {}} />);
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/enter|⏎/i);
  });

  it('calls onClose when Esc is pressed', async () => {
    const onClose = vi.fn();
    const { stdin } = render(<HelpOverlay onClose={onClose} />);
    await wait(20);
    stdin.write('\x1b'); // Esc
    await wait(30);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when ? is pressed', async () => {
    const onClose = vi.fn();
    const { stdin } = render(<HelpOverlay onClose={onClose} />);
    await wait(20);
    stdin.write('?');
    await wait(30);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders Keyboard Shortcuts title', async () => {
    const { lastFrame } = render(<HelpOverlay onClose={() => {}} />);
    await wait(20);
    expect(lastFrame()).toContain('Keyboard');
  });
});
