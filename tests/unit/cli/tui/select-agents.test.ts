import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@inquirer/prompts', () => ({
  checkbox: vi.fn(),
}));

import { checkbox } from '@inquirer/prompts';
import { selectAgents, NotTtyError } from '../../../../src/cli/tui/select-agents.js';
import type { DetectedAgent } from '../../../../src/cli/tui/agents.js';

const sample: DetectedAgent[] = [
  { id: 'claude-code', displayName: 'Claude Code', detected: true, configPath: null, installType: 'cli-command' },
  { id: 'cursor', displayName: 'Cursor', detected: true, configPath: '/proj/.cursor/mcp.json', installType: 'config-file' },
  { id: 'zed', displayName: 'Zed', detected: false, configPath: '/home/test/.config/zed/settings.json', installType: 'config-file' },
];

describe('selectAgents', () => {
  const origIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
  });

  it('returns the user-selected agent ids', async () => {
    vi.mocked(checkbox).mockResolvedValue(['claude-code', 'cursor']);
    const result = await selectAgents(sample);
    expect(result).toEqual(['claude-code', 'cursor']);
  });

  it('passes pre-checked choices for detected agents', async () => {
    vi.mocked(checkbox).mockResolvedValue([]);
    await selectAgents(sample);
    const callArgs = vi.mocked(checkbox).mock.calls[0][0] as any;
    const choices = callArgs.choices as Array<{ value: string; checked: boolean; disabled: false | string }>;
    const claudeChoice = choices.find(c => c.value === 'claude-code');
    expect(claudeChoice?.checked).toBe(true);
    expect(claudeChoice?.disabled).toBe(false);
  });

  it('disables choices for not-detected agents', async () => {
    vi.mocked(checkbox).mockResolvedValue([]);
    await selectAgents(sample);
    const callArgs = vi.mocked(checkbox).mock.calls[0][0] as any;
    const zedChoice = callArgs.choices.find((c: any) => c.value === 'zed');
    expect(zedChoice.disabled).toBe('(not installed)');
    expect(zedChoice.checked).toBe(false);
  });

  it('uses each agent displayName as the choice name', async () => {
    vi.mocked(checkbox).mockResolvedValue([]);
    await selectAgents(sample);
    const callArgs = vi.mocked(checkbox).mock.calls[0][0] as any;
    const names = callArgs.choices.map((c: any) => c.name);
    expect(names).toContain('Claude Code');
    expect(names).toContain('Cursor');
    expect(names).toContain('Zed');
  });

  it('throws NotTtyError when stdout is not a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    await expect(selectAgents(sample)).rejects.toBeInstanceOf(NotTtyError);
  });

  it('returns [] when user confirms without selecting anything', async () => {
    vi.mocked(checkbox).mockResolvedValue([]);
    const result = await selectAgents(sample);
    expect(result).toEqual([]);
  });

  it('handles empty input array gracefully', async () => {
    vi.mocked(checkbox).mockResolvedValue([]);
    const result = await selectAgents([]);
    expect(result).toEqual([]);
  });

  it('propagates ExitPromptError from inquirer (Ctrl+C)', async () => {
    class ExitPromptError extends Error { name = 'ExitPromptError'; }
    vi.mocked(checkbox).mockRejectedValue(new ExitPromptError('user aborted'));
    await expect(selectAgents(sample)).rejects.toThrow('user aborted');
  });
});
