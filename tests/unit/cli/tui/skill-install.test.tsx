import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

// Mock the agent registry so tests don't hit real fs/execSync
vi.mock('../../../../src/cli/agents/registry.js', () => ({
  getAgentHandler: vi.fn(),
}));

import { getAgentHandler } from '../../../../src/cli/agents/registry.js';
import { SkillInstall } from '../../../../src/cli/tui/components/SkillInstall.js';

function makeHandler(opts: {
  id: string;
  supportsSkills?: boolean;
  supportsCommands?: boolean;
  failInstructions?: boolean;
}) {
  return {
    id: opts.id,
    displayName: opts.id,
    supportsSkills: opts.supportsSkills ?? false,
    supportsCommands: opts.supportsCommands ?? false,
    detect: vi.fn().mockReturnValue(true),
    installMcp: vi.fn().mockResolvedValue(undefined),
    installInstructions: opts.failInstructions
      ? vi.fn().mockRejectedValue(new Error('permissions denied'))
      : vi.fn().mockResolvedValue(undefined),
    installSkills: vi.fn().mockResolvedValue(undefined),
    installCommand: vi.fn().mockResolvedValue(undefined),
    uninstall: vi.fn().mockResolvedValue({ removed: [] }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('SkillInstall', () => {
  it('renders "Installing agent skills" header when agents provided', async () => {
    vi.mocked(getAgentHandler).mockReturnValue(makeHandler({ id: 'claude-code', supportsSkills: true, supportsCommands: true }));
    const { lastFrame } = render(
      <SkillInstall agents={['claude-code']} onComplete={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(lastFrame()!).toContain('Installing agent skills');
  });

  it('calls installInstructions for claude-code', async () => {
    const handler = makeHandler({ id: 'claude-code', supportsSkills: true, supportsCommands: true });
    vi.mocked(getAgentHandler).mockReturnValue(handler);
    const onComplete = vi.fn();
    render(<SkillInstall agents={['claude-code']} onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 500));
    expect(handler.installInstructions).toHaveBeenCalled();
  });

  it('calls installSkills and installCommand for claude-code', async () => {
    const handler = makeHandler({ id: 'claude-code', supportsSkills: true, supportsCommands: true });
    vi.mocked(getAgentHandler).mockReturnValue(handler);
    const onComplete = vi.fn();
    render(<SkillInstall agents={['claude-code']} onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 500));
    expect(handler.installSkills).toHaveBeenCalled();
    expect(handler.installCommand).toHaveBeenCalled();
    const results = onComplete.mock.calls[0][0];
    expect(results[0].status).toBe('installed');
    expect(results[0].detail).toContain('8 skills');
    expect(results[0].detail).toContain('command');
  });

  it('calls installInstructions for cursor, reports installed', async () => {
    const handler = makeHandler({ id: 'cursor', supportsSkills: false, supportsCommands: false });
    vi.mocked(getAgentHandler).mockReturnValue(handler);
    const onComplete = vi.fn();
    render(<SkillInstall agents={['cursor']} onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 500));
    expect(handler.installInstructions).toHaveBeenCalled();
    const results = onComplete.mock.calls[0][0];
    expect(results[0].status).toBe('installed');
    expect(results[0].detail).toContain('instructions');
  });

  it('reports not_supported for unknown agent id (no handler)', async () => {
    vi.mocked(getAgentHandler).mockReturnValue(undefined);
    const onComplete = vi.fn();
    render(<SkillInstall agents={['zed' as never]} onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 500));
    const results = onComplete.mock.calls[0][0];
    expect(results[0].status).toBe('not_supported');
  });

  it('reports failed when installInstructions throws', async () => {
    const handler = makeHandler({ id: 'cursor', failInstructions: true });
    vi.mocked(getAgentHandler).mockReturnValue(handler);
    const onComplete = vi.fn();
    render(<SkillInstall agents={['cursor']} onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 500));
    const results = onComplete.mock.calls[0][0];
    expect(results[0].status).toBe('failed');
  });

  it('calls onComplete after processing', async () => {
    const handler = makeHandler({ id: 'claude-code' });
    vi.mocked(getAgentHandler).mockReturnValue(handler);
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
