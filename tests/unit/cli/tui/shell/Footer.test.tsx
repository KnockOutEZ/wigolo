import React, { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';
import {
  Footer,
  FooterProvider,
  useFooterHints,
} from '../../../../../src/cli/tui/shell/Footer.js';

afterEach(() => {
  cleanup();
});

function HintsHarness({ hints }: { hints: readonly string[] }) {
  useFooterHints(hints);
  return <Text>x</Text>;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('Footer', () => {
  it('renders hints as dot-joined row', async () => {
    const { lastFrame } = render(
      <FooterProvider>
        <HintsHarness hints={['↑↓ nav', '⏎ edit', 'q quit']} />
        <Footer />
      </FooterProvider>,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑↓ nav');
    expect(frame).toContain('⏎ edit');
    expect(frame).toContain('q quit');
    expect(frame).toContain(' · ');
  });

  it('renders empty when no hints registered', () => {
    const { lastFrame } = render(
      <FooterProvider>
        <Footer />
      </FooterProvider>,
    );
    expect(typeof lastFrame()).toBe('string');
  });

  it('stacks hints on mount and pops on unmount', async () => {
    function Scene({ showInner }: { showInner: boolean }) {
      return (
        <FooterProvider>
          <HintsHarness hints={['outer']} />
          {showInner && <HintsHarness hints={['inner']} />}
          <Footer />
        </FooterProvider>
      );
    }

    const { lastFrame, rerender } = render(<Scene showInner={true} />);
    await wait(20);
    expect(lastFrame()).toContain('inner');

    rerender(<Scene showInner={false} />);
    await wait(20);
    expect(lastFrame()).toContain('outer');
    expect(lastFrame() ?? '').not.toContain('inner');
  });

  it('nested hint mount: outer registered first, inner on top', async () => {
    const { lastFrame } = render(
      <FooterProvider>
        <HintsHarness hints={['↑↓ nav', '⏎ edit', '⌃k palette', '? help', 'q quit']} />
        <HintsHarness hints={['⏎ save', 'esc cancel']} />
        <Footer />
      </FooterProvider>,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⏎ save');
    expect(frame).toContain('esc cancel');
  });

  it('unmounting inner restores outer hints', async () => {
    function EditScene({ editing }: { editing: boolean }) {
      return (
        <FooterProvider>
          <HintsHarness hints={['↑↓ nav', '⏎ edit', '⌃k palette', '? help', 'q quit']} />
          {editing && <HintsHarness hints={['⏎ save', 'esc cancel']} />}
          <Footer />
        </FooterProvider>
      );
    }

    const { lastFrame, rerender } = render(<EditScene editing={true} />);
    await wait(20);
    expect(lastFrame()).toContain('⏎ save');

    rerender(<EditScene editing={false} />);
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑↓ nav');
    expect(frame).toContain('q quit');
    expect(frame).not.toContain('⏎ save');
  });
});
