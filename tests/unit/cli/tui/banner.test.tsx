import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Banner } from '../../../../src/cli/tui/components/Banner.js';

afterEach(() => {
  cleanup();
});

describe('Banner', () => {
  it('renders ASCII art text', () => {
    const onComplete = vi.fn();
    const { lastFrame } = render(<Banner onComplete={onComplete} />);
    const frame = lastFrame();
    // BigText "tiny" font uses box-drawing chars like ╦ ╔ ║
    expect(frame).toBeTruthy();
    expect(frame!.length).toBeGreaterThan(50);
  });

  it('renders the tagline', () => {
    const onComplete = vi.fn();
    const { lastFrame } = render(<Banner onComplete={onComplete} />);
    expect(lastFrame()).toContain('Local-first web intelligence for AI agents');
  });

  it('renders a version string', () => {
    const onComplete = vi.fn();
    const { lastFrame } = render(<Banner onComplete={onComplete} />);
    expect(lastFrame()).toMatch(/v\d+\.\d+\.\d+/);
  });

  it('calls onComplete after delay', async () => {
    const onComplete = vi.fn();
    render(<Banner onComplete={onComplete} />);

    expect(onComplete).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 1600));
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
