import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/cli/tui/config-writer-json.js', () => ({
  writeJsonConfig: vi.fn(),
}));
vi.mock('../../../../src/cli/tui/config-writer-toml.js', () => ({
  writeTomlConfig: vi.fn(),
}));
vi.mock('../../../../src/cli/tui/config-writer-cli.js', () => ({
  installViaClaudeCli: vi.fn(),
}));

import { writeJsonConfig } from '../../../../src/cli/tui/config-writer-json.js';
import { writeTomlConfig } from '../../../../src/cli/tui/config-writer-toml.js';
import { installViaClaudeCli } from '../../../../src/cli/tui/config-writer-cli.js';
import { applyConfigs } from '../../../../src/cli/tui/config-writer.js';
import type { DetectedAgent } from '../../../../src/cli/tui/agents.js';

const all: DetectedAgent[] = [
  { id: 'claude-code', displayName: 'Claude Code', detected: true, configPath: null, installType: 'cli-command' },
  { id: 'cursor', displayName: 'Cursor', detected: true, configPath: '/proj/.cursor/mcp.json', installType: 'config-file' },
  { id: 'vscode', displayName: 'VS Code (Copilot)', detected: false, configPath: '/proj/.vscode/mcp.json', installType: 'config-file' },
  { id: 'zed', displayName: 'Zed', detected: true, configPath: '/home/test/.config/zed/settings.json', installType: 'config-file' },
  { id: 'gemini-cli', displayName: 'Gemini CLI', detected: false, configPath: '/home/test/.gemini/settings.json', installType: 'config-file' },
  { id: 'windsurf', displayName: 'Windsurf', detected: false, configPath: '/home/test/.codeium/windsurf/mcp_config.json', installType: 'config-file' },
  { id: 'codex', displayName: 'Codex (OpenAI CLI)', detected: false, configPath: '/home/test/.codex/config.toml', installType: 'config-toml' },
  { id: 'opencode', displayName: 'OpenCode', detected: false, configPath: '/home/test/.config/opencode/config.json', installType: 'config-file' },
];

describe('applyConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writeJsonConfig).mockResolvedValue({ ok: true, code: 'OK' });
    vi.mocked(writeTomlConfig).mockResolvedValue({ ok: true, code: 'OK' });
    vi.mocked(installViaClaudeCli).mockResolvedValue({ ok: true, code: 'OK' });
  });

  it('routes claude-code to installViaClaudeCli', async () => {
    await applyConfigs(all, ['claude-code']);
    expect(installViaClaudeCli).toHaveBeenCalledTimes(1);
    expect(writeJsonConfig).not.toHaveBeenCalled();
  });

  it('routes Cursor to writeJsonConfig with correct keyPath', async () => {
    await applyConfigs(all, ['cursor']);
    expect(writeJsonConfig).toHaveBeenCalledWith(expect.objectContaining({
      path: '/proj/.cursor/mcp.json',
      keyPath: ['mcpServers', 'wigolo'],
      entry: expect.objectContaining({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] }),
    }));
  });

  it('routes VS Code with type:stdio in entry and keyPath=servers.wigolo', async () => {
    await applyConfigs(all, ['vscode']);
    expect(writeJsonConfig).toHaveBeenCalledWith(expect.objectContaining({
      keyPath: ['servers', 'wigolo'],
      entry: expect.objectContaining({ type: 'stdio' }),
    }));
  });

  it('routes Zed with keyPath=context_servers.wigolo', async () => {
    await applyConfigs(all, ['zed']);
    expect(writeJsonConfig).toHaveBeenCalledWith(expect.objectContaining({
      keyPath: ['context_servers', 'wigolo'],
    }));
  });

  it('routes Gemini CLI to writeJsonConfig with keyPath=mcpServers.wigolo', async () => {
    await applyConfigs(all, ['gemini-cli']);
    expect(writeJsonConfig).toHaveBeenCalledWith(expect.objectContaining({
      keyPath: ['mcpServers', 'wigolo'],
    }));
  });

  it('routes Windsurf to writeJsonConfig', async () => {
    await applyConfigs(all, ['windsurf']);
    expect(writeJsonConfig).toHaveBeenCalledWith(expect.objectContaining({
      keyPath: ['mcpServers', 'wigolo'],
      path: '/home/test/.codeium/windsurf/mcp_config.json',
    }));
  });

  it('routes Codex to writeTomlConfig', async () => {
    await applyConfigs(all, ['codex']);
    expect(writeTomlConfig).toHaveBeenCalledWith(expect.objectContaining({
      tablePath: ['mcp_servers', 'wigolo'],
      path: '/home/test/.codex/config.toml',
    }));
  });

  it('routes OpenCode with type:local in entry and keyPath=mcp.wigolo', async () => {
    await applyConfigs(all, ['opencode']);
    expect(writeJsonConfig).toHaveBeenCalledWith(expect.objectContaining({
      keyPath: ['mcp', 'wigolo'],
      entry: expect.objectContaining({ type: 'local' }),
    }));
  });

  it('returns one ConfigApplyResult per selected id, in order', async () => {
    const results = await applyConfigs(all, ['claude-code', 'cursor', 'codex']);
    expect(results.map(r => r.id)).toEqual(['claude-code', 'cursor', 'codex']);
  });

  it('continues when one agent fails', async () => {
    vi.mocked(writeJsonConfig).mockResolvedValueOnce({ ok: false, code: 'PERMISSION_DENIED', message: 'denied' });
    const results = await applyConfigs(all, ['cursor', 'zed']);
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);
  });

  it('skips ids not present in detected[]', async () => {
    const results = await applyConfigs(all, ['cursor', 'unknown' as any]);
    expect(results.map(r => r.id)).toEqual(['cursor']);
  });

  it('forwards dryRun to underlying writers', async () => {
    await applyConfigs(all, ['cursor', 'codex', 'claude-code'], { dryRun: true });
    expect(writeJsonConfig).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(writeTomlConfig).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(installViaClaudeCli).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });
});
