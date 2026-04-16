import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { AgentSelect } from '../../../../src/cli/tui/components/AgentSelect.js';

vi.mock('../../../../src/cli/tui/hooks/useAgentDetect.js', () => ({
  useAgentDetect: () => ({
    agents: [
      { id: 'claude-code', displayName: 'Claude Code', detected: true, configPath: null, installType: 'cli-command' },
      { id: 'cursor', displayName: 'Cursor', detected: true, configPath: '/tmp/.cursor/mcp.json', installType: 'config-file' },
      { id: 'vscode', displayName: 'VS Code (Copilot)', detected: false, configPath: '/tmp/.vscode/mcp.json', installType: 'config-file' },
    ],
    done: true,
  }),
}));

vi.mock('../../../../src/cli/tui/config-writer.js', () => ({
  applyConfigs: vi.fn().mockResolvedValue([]),
}));

afterEach(() => {
  cleanup();
});

describe('AgentSelect', () => {
  it('renders the header', () => {
    const { lastFrame } = render(<AgentSelect onComplete={() => {}} />);
    expect(lastFrame()).toContain('Connect to AI Tools');
  });

  it('shows detected agents with label', () => {
    const { lastFrame } = render(<AgentSelect onComplete={() => {}} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('detected');
    expect(frame).toContain('Cursor');
  });

  it('shows non-detected agents', () => {
    const { lastFrame } = render(<AgentSelect onComplete={() => {}} />);
    expect(lastFrame()).toContain('VS Code');
  });

  it('renders instructions', () => {
    const { lastFrame } = render(<AgentSelect onComplete={() => {}} />);
    expect(lastFrame()).toContain('space');
    expect(lastFrame()).toContain('enter');
  });
});
