/**
 * --json house-contract tests for CLI commands that gained machine output.
 *
 * The house contract: under `--json`, stdout carries EXACTLY ONE JSON document
 * and nothing else; all human/progress text is routed to stderr (or suppressed)
 * so the JSON pipes cleanly through jq. Exit code stays 0/1.
 *
 * These tests pin that contract per command and — for `auth` — assert that no
 * credential material ever appears in the machine output (auth reads only
 * user-configured paths/endpoints, never storage-state contents or tokens).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function capture(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => { stdout.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { stderr.push(String(c)); return true; }) as typeof process.stderr.write;
  return { stdout, stderr, restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; } };
}

/** Assert `text` is exactly one parseable JSON document (one non-empty line). */
function expectSingleJsonDoc(text: string): unknown {
  const trimmed = text.trim();
  const lines = trimmed.split('\n').filter((l) => l.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

// ---------------------------------------------------------------------------
// auth --json
// ---------------------------------------------------------------------------

describe('auth status --json', () => {
  const origEnv = process.env;
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...origEnv };
  });
  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
  });

  it('emits a single JSON status doc on stdout, nothing on stdout otherwise', async () => {
    process.env.WIGOLO_AUTH_STATE_PATH = '/home/u/.auth/state.json';
    process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
    const { resetConfig } = await import('../../../src/config.js');
    resetConfig();
    const { runAuth } = await import('../../../src/cli/auth.js');

    const cap = capture();
    let code: number;
    try {
      code = await runAuth(['status', '--json']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const doc = expectSingleJsonDoc(cap.stdout.join('')) as {
      status: string;
      storageState: { configured: boolean };
      cdp: { configured: boolean };
    };
    expect(doc.status).toBe('ok');
    expect(doc.storageState.configured).toBe(true);
    expect(doc.cdp.configured).toBe(true);
    resetConfig();
  });

  it('never leaks credential material (no token/cookie/secret values) in the JSON', async () => {
    // Seed a token-shaped env var that auth must NOT read into its output.
    process.env.WIGOLO_GITHUB_TOKEN = 'ghp_SUPERSECRETtokenABCDEF1234567890';
    process.env.WIGOLO_AUTH_STATE_PATH = '/home/u/.auth/state.json';
    const { resetConfig } = await import('../../../src/config.js');
    resetConfig();
    const { runAuth } = await import('../../../src/cli/auth.js');

    const cap = capture();
    try {
      await runAuth(['status', '--json']);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('');
    expect(out).not.toContain('ghp_SUPERSECRET');
    expect(out).not.toContain('SUPERSECRETtoken');
    expect(out).not.toMatch(/cf_clearance/i);
    resetConfig();
  });
});

// ---------------------------------------------------------------------------
// plugin list/validate --json
// ---------------------------------------------------------------------------

describe('plugin list/validate --json', () => {
  let dir: string;
  const origEnv = process.env;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-plugins-'));
    process.env = { ...origEnv, WIGOLO_PLUGINS_DIR: dir };
  });
  afterEach(async () => {
    process.env = origEnv;
    const { resetConfig } = await import('../../../src/config.js');
    resetConfig();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('plugin list --json emits a single {plugins:[]} doc on stdout', async () => {
    const pluginDir = join(dir, 'demo');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.2.3', main: 'index.mjs' }));
    writeFileSync(join(pluginDir, 'index.mjs'), 'export default {};');

    const { resetConfig } = await import('../../../src/config.js');
    resetConfig();
    const { runPluginList } = await import('../../../src/cli/plugin.js');

    const cap = capture();
    try {
      runPluginList(true);
    } finally {
      cap.restore();
    }
    const doc = expectSingleJsonDoc(cap.stdout.join('')) as { plugins: Array<{ name: string; version: string }> };
    expect(doc.plugins).toHaveLength(1);
    expect(doc.plugins[0].name).toBe('demo');
    expect(doc.plugins[0].version).toBe('1.2.3');
  });

  it('plugin validate --json reports valid=true for a well-formed plugin (exit 0)', async () => {
    const pluginDir = join(dir, 'good');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'good', version: '1.0.0', main: 'index.mjs' }));
    writeFileSync(join(pluginDir, 'index.mjs'), 'export default {};');

    const { resetConfig } = await import('../../../src/config.js');
    resetConfig();
    const { runPluginValidate } = await import('../../../src/cli/plugin.js');

    const cap = capture();
    let code: number;
    try {
      code = runPluginValidate(true);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const doc = expectSingleJsonDoc(cap.stdout.join('')) as { status: string; plugins: Array<{ valid: boolean }> };
    expect(doc.status).toBe('ok');
    expect(doc.plugins[0].valid).toBe(true);
  });

  it('plugin validate --json flags a plugin whose main file is missing (exit 1)', async () => {
    const pluginDir = join(dir, 'bad');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'bad', version: '1.0.0', main: 'nope.mjs' }));

    const { resetConfig } = await import('../../../src/config.js');
    resetConfig();
    const { runPluginValidate } = await import('../../../src/cli/plugin.js');

    const cap = capture();
    let code: number;
    try {
      code = runPluginValidate(true);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    const doc = expectSingleJsonDoc(cap.stdout.join('')) as { status: string; plugins: Array<{ valid: boolean; issues: string[] }> };
    expect(doc.status).toBe('error');
    expect(doc.plugins[0].valid).toBe(false);
    expect(doc.plugins[0].issues.join(' ')).toContain('nope.mjs');
  });
});

// ---------------------------------------------------------------------------
// backfill --json
// ---------------------------------------------------------------------------

describe('backfill --json', () => {
  const origEnv = process.env;
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...origEnv };
  });
  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
  });

  it('emits a single JSON counts doc on stdout (dry-run) and keeps progress on stderr', async () => {
    vi.doMock('../../../src/cache/backfill-embeddings.js', () => ({
      backfillEmbeddings: vi.fn(async () => ({
        scanned: 10, embedded: 8, skipped: 2, errors: 0, modelId: 'bge-small', reason: undefined,
      })),
    }));
    const { runBackfill } = await import('../../../src/cli/backfill.js');

    const cap = capture();
    let code: number;
    try {
      code = await runBackfill(['--json', '--dry-run']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const doc = expectSingleJsonDoc(cap.stdout.join('')) as {
      status: string; scanned: number; embedded: number; skipped: number; failed: number; dryRun: boolean;
    };
    expect(doc.status).toBe('ok');
    expect(doc.scanned).toBe(10);
    expect(doc.embedded).toBe(8);
    expect(doc.skipped).toBe(2);
    expect(doc.failed).toBe(0);
    expect(doc.dryRun).toBe(true);
    // The scanning banner is on stderr, not stdout.
    expect(cap.stderr.join('')).toContain('scanning');
    vi.doUnmock('../../../src/cache/backfill-embeddings.js');
  });

  it('emits a skipped doc (exit 1) when the backfill reports a reason', async () => {
    vi.doMock('../../../src/cache/backfill-embeddings.js', () => ({
      backfillEmbeddings: vi.fn(async () => ({
        scanned: 0, embedded: 0, skipped: 0, errors: 0, modelId: '', reason: 'embeddings disabled',
      })),
    }));
    const { runBackfill } = await import('../../../src/cli/backfill.js');

    const cap = capture();
    let code: number;
    try {
      code = await runBackfill(['--json']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    const doc = expectSingleJsonDoc(cap.stdout.join('')) as { status: string; reason: string };
    expect(doc.status).toBe('skipped');
    expect(doc.reason).toBe('embeddings disabled');
    vi.doUnmock('../../../src/cache/backfill-embeddings.js');
  });
});
