import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { selectAgentsMock, applyConfigsMock } = vi.hoisted(() => ({
  selectAgentsMock: vi.fn(),
  applyConfigsMock: vi.fn(),
}));

vi.mock('../../../src/cli/tui/select-agents.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/cli/tui/select-agents.js')>();
  return {
    ...actual,
    selectAgents: selectAgentsMock,
  };
});

vi.mock('../../../src/cli/tui/config-writer.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/cli/tui/config-writer.js')>();
  return {
    ...actual,
    applyConfigs: applyConfigsMock,
  };
});

import { runSetupMcp } from '../../../src/cli/setup-mcp.js';

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'wigolo-d6-'));
  mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  selectAgentsMock.mockReset();
  applyConfigsMock.mockReset();
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('setup mcp — real detection, mocked selection/writers', () => {
  it('detects Cursor from $HOME/.cursor and offers it to selectAgents', async () => {
    selectAgentsMock.mockResolvedValue([]);

    const code = await runSetupMcp(['mcp']);

    expect(code).toBe(0);
    const detectedArg = selectAgentsMock.mock.calls[0]?.[0];
    expect(Array.isArray(detectedArg)).toBe(true);
    expect((detectedArg as Array<{ id: string; detected: boolean }>).some(a => a.id === 'cursor' && a.detected)).toBe(true);
  });

  it('writes the summary line ✓ for every ok result', async () => {
    selectAgentsMock.mockResolvedValue(['cursor']);
    applyConfigsMock.mockResolvedValue([
      { id: 'cursor', displayName: 'Cursor', ok: true, code: 'OK', configPath: join(tmpHome, '.cursor', 'mcp.json') },
    ]);

    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = ((s: string | Uint8Array) => {
      lines.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
      return true;
    });
    try {
      const code = await runSetupMcp(['mcp']);
      expect(code).toBe(0);
    } finally {
      (process.stderr.write as unknown) = orig;
    }
    const output = lines.join('');
    expect(output).toMatch(/Summary:/);
    expect(output).toContain('✓ Cursor');
  });
});
