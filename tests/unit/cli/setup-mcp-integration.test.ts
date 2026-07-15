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
let origUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'wigolo-d6-'));
  mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  // Production agent detection reads os.homedir(), which resolves $HOME on
  // POSIX but USERPROFILE on Windows. Set BOTH so the temp home is honored on
  // every platform — setting HOME alone is a no-op on Windows and the .cursor
  // detection would fall back to the real user profile.
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  selectAgentsMock.mockReset();
  applyConfigsMock.mockReset();
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
  else delete process.env.USERPROFILE;
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

  it('--json emits a single parseable object on stdout with agent-registration results', async () => {
    // WHY (D8/D4-json): AI-drivable setup needs a machine-readable result. The
    // ENTIRE stdout must parse as JSON — the human summary must route to stderr.
    selectAgentsMock.mockResolvedValue(['cursor']);
    applyConfigsMock.mockResolvedValue([
      { id: 'cursor', displayName: 'Cursor', ok: true, code: 'OK', configPath: join(tmpHome, '.cursor', 'mcp.json') },
    ]);

    const outLines: string[] = [];
    const errLines: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout.write as unknown) = ((s: string | Uint8Array) => {
      outLines.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
      return true;
    });
    (process.stderr.write as unknown) = ((s: string | Uint8Array) => {
      errLines.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
      return true;
    });
    let code: number;
    try {
      code = await runSetupMcp(['mcp', '--non-interactive', '--agents=cursor', '--json']);
    } finally {
      (process.stdout.write as unknown) = origOut;
      (process.stderr.write as unknown) = origErr;
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(outLines.join('').trim());
    expect(parsed.status).toBe('ok');
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(parsed.agents).toEqual([
      expect.objectContaining({ id: 'cursor', ok: true }),
    ]);
    // Human banner/summary must not pollute stdout.
    expect(outLines.join('')).not.toMatch(/Summary:/);
  });

  it('--json reports status=error and exit 1 when a config write fails', async () => {
    selectAgentsMock.mockResolvedValue(['cursor']);
    applyConfigsMock.mockResolvedValue([
      { id: 'cursor', displayName: 'Cursor', ok: false, code: 'WRITE_FAILED', message: 'EACCES', configPath: null },
    ]);
    const outLines: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout.write as unknown) = ((s: string | Uint8Array) => {
      outLines.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
      return true;
    });
    (process.stderr.write as unknown) = (() => true);
    let code: number;
    try {
      code = await runSetupMcp(['mcp', '--non-interactive', '--agents=cursor', '--json']);
    } finally {
      (process.stdout.write as unknown) = origOut;
      (process.stderr.write as unknown) = origErr;
    }
    expect(code).toBe(1);
    const parsed = JSON.parse(outLines.join('').trim());
    expect(parsed.status).toBe('error');
    expect(parsed.agents[0]).toEqual(expect.objectContaining({ id: 'cursor', ok: false }));
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
