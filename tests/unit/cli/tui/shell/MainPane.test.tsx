import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';
import { MainPane } from '../../../../../src/cli/tui/shell/MainPane.js';

afterEach(() => {
  cleanup();
});

describe('MainPane', () => {
  it('renders children inside the pane', () => {
    const { lastFrame } = render(
      <MainPane title="Browser" focused={true}>
        <Text>child content</Text>
      </MainPane>,
    );
    expect(lastFrame()).toContain('child content');
  });

  it('renders title prop at top', () => {
    const { lastFrame } = render(
      <MainPane title="Search engine" focused={true}>
        <Text>body</Text>
      </MainPane>,
    );
    expect(lastFrame()).toContain('Search engine');
  });

  it('renders a rounded border', () => {
    const { lastFrame } = render(
      <MainPane title="Browser" focused={true}>
        <Text>x</Text>
      </MainPane>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/[╭╮╰╯│─]/);
  });

  it('renders with focused=true without throwing', () => {
    const { lastFrame } = render(
      <MainPane title="Agents" focused={true}>
        <Text>focused</Text>
      </MainPane>,
    );
    expect(lastFrame()).toContain('focused');
  });

  it('renders with focused=false without throwing', () => {
    const { lastFrame } = render(
      <MainPane title="Agents" focused={false}>
        <Text>unfocused</Text>
      </MainPane>,
    );
    expect(lastFrame()).toContain('unfocused');
  });
});
