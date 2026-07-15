/**
 * Tests for runUninstall's cleanup guidance.
 *
 * Why: `wigolo uninstall` removes agent integrations but PRESERVES the data
 * dir. The cleanup guidance it prints must match how wigolo was installed:
 *  - npm/source layout: full cleanup is `rm -rf ~/.wigolo`.
 *  - curl|sh bootstrap layout (~/.wigolo/tool or ~/.wigolo/runtime present):
 *    "remove the tool" (bin/tool/runtime) must be distinguished from "wipe all
 *    data" (rm -rf ~/.wigolo, which ALSO deletes the tool). Conflating them
 *    would tell a bootstrap user their only cleanup option destroys the cache.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../../src/cli/agents/registry.js', () => ({
  detectInstalledHandlers: vi.fn(() => []),
}));

let dataDir: string;

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir })),
}));

import { runUninstall } from '../../../src/cli/uninstall.js';
import { detectInstalledHandlers } from '../../../src/cli/agents/registry.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'wigolo-uninstall-'));
  dataDir = join(tmpHome, '.wigolo');
  mkdirSync(dataDir, { recursive: true });
  vi.mocked(detectInstalledHandlers).mockReturnValue([]);
  vi.clearAllMocks();
  vi.mocked(detectInstalledHandlers).mockReturnValue([]);
});

afterEach(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

describe('runUninstall cleanup guidance', () => {
  it('npm/source layout: full cleanup is a single rm -rf of the data dir', async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await runUninstall([]);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('') + cap.stderr.join('');
    expect(code).toBe(0);
    expect(out).toContain('rm -rf');
    expect(out).toContain(dataDir);
    // No bootstrap layout present, so it must NOT mention the installer's
    // --uninstall flag or the tool/runtime split.
    expect(out).not.toContain('install.sh --uninstall');
  });

  it('bootstrap layout (tool/): distinguishes tool removal from data wipe', async () => {
    mkdirSync(join(dataDir, 'tool'), { recursive: true });
    mkdirSync(join(dataDir, 'bin'), { recursive: true });
    mkdirSync(join(dataDir, 'runtime'), { recursive: true });
    const cap = captureOutput();
    let code: number;
    try {
      code = await runUninstall([]);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('') + cap.stderr.join('');
    expect(code).toBe(0);
    // Must offer the tool-only removal path (installer's own uninstall).
    expect(out).toContain('install.sh --uninstall');
    // Must name the tool dirs so the user knows what "remove the tool" touches.
    expect(out).toContain(join(dataDir, 'tool'));
    // Must still offer full-wipe, and make clear it ALSO deletes the tool.
    expect(out).toContain('rm -rf');
    expect(out).toContain(dataDir);
  });

  it('bootstrap layout (runtime only): still triggers the split guidance', async () => {
    mkdirSync(join(dataDir, 'runtime'), { recursive: true });
    const cap = captureOutput();
    try {
      await runUninstall([]);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('') + cap.stderr.join('');
    expect(out).toContain('install.sh --uninstall');
  });

  it('--help documents the bootstrap layout distinction', async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await runUninstall(['--help']);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('') + cap.stderr.join('');
    expect(code).toBe(0);
    expect(out).toContain('install.sh --uninstall');
    expect(out).toContain('rm -rf');
  });
});
