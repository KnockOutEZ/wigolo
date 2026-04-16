import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { BrowserSelect } from '../../../../src/cli/tui/components/BrowserSelect.js';

afterEach(() => {
  cleanup();
});

describe('BrowserSelect', () => {
  it('renders the header', () => {
    const { lastFrame } = render(<BrowserSelect onComplete={() => {}} />);
    expect(lastFrame()).toContain('Browser Engine');
  });

  it('renders browser options', () => {
    const { lastFrame } = render(<BrowserSelect onComplete={() => {}} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Lightpanda');
    expect(frame).toContain('Chromium');
    expect(frame).toContain('Firefox');
  });

  it('renders the description text', () => {
    const { lastFrame } = render(<BrowserSelect onComplete={() => {}} />);
    expect(lastFrame()).toContain('Choose your default');
  });

  it('calls onComplete with selected value on enter', async () => {
    const onComplete = vi.fn();
    const { stdin } = render(<BrowserSelect onComplete={onComplete} />);
    // Allow Ink to finish initial render
    await new Promise((r) => setTimeout(r, 50));
    // Press enter to select the first (default) option
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));
    expect(onComplete).toHaveBeenCalledWith('lightpanda');
  });
});
