import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const applyConfigsMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../src/cli/tui/config-writer.js', () => ({
  applyConfigs: applyConfigsMock,
}));

import { writeMcpConfig, persistKey } from '../../../../../src/cli/tui/actions/write-config.js';
import { readPersistedConfig, resetPersistedConfig } from '../../../../../src/persisted-config.js';
import type { DetectedAgent } from '../../../../../src/cli/tui/agents.js';

const mockDetected: DetectedAgent[] = [
  {
    id: 'cursor',
    displayName: 'Cursor',
    detected: true,
    installType: 'config-file',
    configPath: '/home/.cursor/mcp.json',
  } as DetectedAgent,
  {
    id: 'vscode',
    displayName: 'VS Code',
    detected: false,
    installType: 'config-file',
    configPath: '/home/.vscode/mcp.json',
  } as DetectedAgent,
];

describe('writeMcpConfig', () => {
  it('maps successful applyConfigs results to status=ok', async () => {
    applyConfigsMock.mockResolvedValueOnce([
      { id: 'cursor', displayName: 'Cursor', ok: true, code: 'OK', configPath: '/home/.cursor/mcp.json' },
    ]);
    const r = await writeMcpConfig(mockDetected, ['cursor']);
    expect(r.anyFailed).toBe(false);
    expect(r.results[0].status).toBe('ok');
    expect(r.results[0].id).toBe('cursor');
    expect(r.results[0].path).toBe('/home/.cursor/mcp.json');
  });

  it('maps already_installed result to status=already_installed', async () => {
    applyConfigsMock.mockResolvedValueOnce([
      { id: 'cursor', displayName: 'Cursor', ok: true, code: 'ALREADY_INSTALLED', configPath: '/x', alreadyInstalled: true },
    ]);
    const r = await writeMcpConfig(mockDetected, ['cursor']);
    expect(r.results[0].status).toBe('already_installed');
    expect(r.anyFailed).toBe(false);
  });

  it('maps failed applyConfigs result to status=failed with error', async () => {
    applyConfigsMock.mockResolvedValueOnce([
      { id: 'vscode', displayName: 'VS Code', ok: false, code: 'WRITE_ERROR', message: 'permission denied', configPath: null },
    ]);
    const r = await writeMcpConfig(mockDetected, ['vscode']);
    expect(r.anyFailed).toBe(true);
    expect(r.results[0].status).toBe('failed');
    expect(r.results[0].error).toContain('permission denied');
  });

  it('surfaces anyFailed=true when one of multiple results fails', async () => {
    applyConfigsMock.mockResolvedValueOnce([
      { id: 'cursor', displayName: 'Cursor', ok: true, code: 'OK', configPath: '/a' },
      { id: 'vscode', displayName: 'VS Code', ok: false, code: 'ERR', message: 'oops', configPath: null },
    ]);
    const r = await writeMcpConfig(mockDetected, ['cursor', 'vscode']);
    expect(r.anyFailed).toBe(true);
    expect(r.results.find((x) => x.id === 'cursor')?.status).toBe('ok');
    expect(r.results.find((x) => x.id === 'vscode')?.status).toBe('failed');
  });

  it('passes dryRun flag through to applyConfigs', async () => {
    applyConfigsMock.mockResolvedValueOnce([]);
    await writeMcpConfig(mockDetected, ['cursor'], { dryRun: true });
    expect(applyConfigsMock).toHaveBeenCalledWith(
      mockDetected,
      ['cursor'],
      expect.objectContaining({ dryRun: true }),
    );
  });
});

describe('persistKey', () => {
  let tmpDir: string;
  let tmpConfig: string;
  let originalConfigPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-persist-unit-'));
    tmpConfig = join(tmpDir, 'config.json');
    originalConfigPath = process.env.WIGOLO_CONFIG_PATH;
    process.env.WIGOLO_CONFIG_PATH = tmpConfig;
    resetPersistedConfig();
  });

  afterEach(() => {
    if (originalConfigPath === undefined) {
      delete process.env.WIGOLO_CONFIG_PATH;
    } else {
      process.env.WIGOLO_CONFIG_PATH = originalConfigPath;
    }
    resetPersistedConfig();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when path is empty', async () => {
    await expect(persistKey('', 42)).rejects.toThrow('persistKey: path must be non-empty');
  });

  it('single-segment path writes value under the correct key', async () => {
    await persistKey('provider', 'anthropic');
    resetPersistedConfig();
    const cfg = readPersistedConfig(tmpConfig);
    expect((cfg.settings as Record<string, unknown>)?.provider).toBe('anthropic');
  });

  it('multi-segment path writes nested value and preserves siblings', async () => {
    await persistKey('llm.apiKey', 'sk-abc');
    await persistKey('llm.provider', 'openai');
    resetPersistedConfig();
    const cfg = readPersistedConfig(tmpConfig);
    const llm = (cfg.settings as Record<string, unknown>)?.llm as Record<string, unknown>;
    expect(llm?.apiKey).toBe('sk-abc');
    expect(llm?.provider).toBe('openai');
  });

  it('refuses an invalid new-tab search engine before writing', async () => {
    await persistKey('provider', 'anthropic');

    await expect(
      persistKey('newTabSearchEngine', 'http://search.example.test/?q={searchTerms}'),
    ).rejects.toMatchObject({ reason: 'template_not_absolute_https' });

    resetPersistedConfig();
    expect(readPersistedConfig(tmpConfig).settings).toEqual({ provider: 'anthropic' });
  });
});
