import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { ActionBar } from '../../../../../src/cli/tui/components/ActionBar.js';

afterEach(() => {
  cleanup();
});

const hotkeys = [
  { key: '↑↓', label: 'field' },
  { key: 'enter', label: 'edit' },
  { key: 's', label: 'save 0 pending' },
  { key: 'esc', label: 'back' },
  { key: 'q', label: 'quit' },
];

describe('ActionBar', () => {
  it('renders every hotkey and label', () => {
    const { lastFrame } = render(
      <ActionBar pendingCount={0} hotkeys={hotkeys} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑↓');
    expect(frame).toContain('field');
    expect(frame).toContain('enter');
    expect(frame).toContain('edit');
    expect(frame).toContain('s');
    expect(frame).toContain('save 0 pending');
    expect(frame).toContain('esc');
    expect(frame).toContain('back');
    expect(frame).toContain('q');
    expect(frame).toContain('quit');
  });

  it('renders pending count in label when caller provides it', () => {
    const dirty = hotkeys.map((h) =>
      h.key === 's' ? { ...h, label: 'save 3 pending' } : h,
    );
    const { lastFrame } = render(
      <ActionBar pendingCount={3} hotkeys={dirty} />,
    );
    expect(lastFrame()).toContain('save 3 pending');
  });

  it('renders cleanly with an empty hotkey list', () => {
    const { lastFrame } = render(<ActionBar pendingCount={0} hotkeys={[]} />);
    // No throw, frame is a string.
    expect(typeof lastFrame()).toBe('string');
  });
});
