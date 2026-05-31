import { describe, expect, it, vi } from 'vitest';

const applyConfigsMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../src/cli/tui/config-writer.js', () => ({
  applyConfigs: applyConfigsMock,
}));

import { writeMcpConfig, unflattenDottedKey } from '../../../../../src/cli/tui/actions/write-config.js';
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

describe('unflattenDottedKey', () => {
  it('single-segment path wraps value under one key', () => {
    expect(unflattenDottedKey('foo', 1)).toEqual({ foo: 1 });
  });

  it('two-segment path produces nested object', () => {
    expect(unflattenDottedKey('llm.apiKey', 'x')).toEqual({ llm: { apiKey: 'x' } });
  });

  it('three-segment path produces doubly-nested object', () => {
    expect(unflattenDottedKey('a.b.c', true)).toEqual({ a: { b: { c: true } } });
  });

  it('empty path returns empty object without crashing', () => {
    expect(unflattenDottedKey('', 42)).toEqual({});
  });
});
