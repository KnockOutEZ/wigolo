/**
 * Asserts that write failures surface (are not swallowed) through writeMcpConfig.
 *
 * This tests the "no silent config-write failures" cross-cutting requirement (§8).
 */
import { describe, expect, it, vi } from 'vitest';

const applyConfigsMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../src/cli/tui/config-writer.js', () => ({
  applyConfigs: applyConfigsMock,
}));

import { writeMcpConfig } from '../../../../../src/cli/tui/actions/write-config.js';
import type { DetectedAgent } from '../../../../../src/cli/tui/agents.js';

const singleDetected: DetectedAgent[] = [
  {
    id: 'cursor',
    displayName: 'Cursor',
    detected: true,
    installType: 'config-file',
    configPath: '/home/.cursor/mcp.json',
  } as DetectedAgent,
];

describe('no silent failures', () => {
  it('failure code in applyConfigs is surfaced in WriteResult, not swallowed', async () => {
    applyConfigsMock.mockResolvedValueOnce([
      {
        id: 'cursor',
        displayName: 'Cursor',
        ok: false,
        code: 'JSON_PARSE_ERROR',
        message: 'invalid JSON at line 42',
        configPath: '/home/.cursor/mcp.json',
      },
    ]);

    const r = await writeMcpConfig(singleDetected, ['cursor']);

    // failure must be in results — not silently dropped
    expect(r.anyFailed).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].status).toBe('failed');
    expect(r.results[0].error).toContain('invalid JSON');
  });

  it('applyConfigs throwing is NOT silently swallowed — propagates to caller', async () => {
    applyConfigsMock.mockRejectedValueOnce(new Error('disk full'));

    await expect(writeMcpConfig(singleDetected, ['cursor'])).rejects.toThrow('disk full');
  });

  it('zero selected agents returns empty results with anyFailed=false', async () => {
    applyConfigsMock.mockResolvedValueOnce([]);
    const r = await writeMcpConfig(singleDetected, []);
    expect(r.anyFailed).toBe(false);
    expect(r.results).toHaveLength(0);
  });
});
