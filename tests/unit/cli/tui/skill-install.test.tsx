import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { SkillInstall } from '../../../../src/cli/tui/components/SkillInstall.js';

afterEach(() => {
  cleanup();
});

describe('SkillInstall', () => {
  it('renders header when agents provided', async () => {
    const { lastFrame } = render(
      <SkillInstall agents={['claude-code']} onComplete={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame()!;
    expect(frame).toContain('Installing agent skills');
  });

  it('shows not_supported for agents without skill mechanism', async () => {
    const { lastFrame } = render(
      <SkillInstall agents={['claude-code', 'gemini-cli']} onComplete={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame()!;
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('MCP instructions');
  });

  it('calls onComplete after processing', async () => {
    const onComplete = vi.fn();
    render(<SkillInstall agents={['claude-code']} onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 500));
    expect(onComplete).toHaveBeenCalled();
  });

  it('calls onComplete immediately with empty agents', async () => {
    const onComplete = vi.fn();
    render(<SkillInstall agents={[]} onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 500));
    expect(onComplete).toHaveBeenCalled();
  });
});
