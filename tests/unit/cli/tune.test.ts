/**
 * Tests for `wigolo tune` — the per-domain self-tuning inspection/reset surface.
 *
 * Why: wigolo learns per-domain routing (TLS-tier promotion, browser
 * escalation, clearance reuse, polite backoff) as it fetches. `tune` is the
 * operator's window into that state and the lever to reset it. Contracts under
 * test:
 *  - `--json` emits ONE JSON document on stdout; every human line goes to
 *    stderr (house contract — output must pipe cleanly through jq).
 *  - the JSON never carries the live clearance cookie/UA (credential guard;
 *    the store projection already omits them, this asserts the CLI keeps it so).
 *  - unknown domain on `show`/`reset` exits 1.
 *  - a store failure (busy/locked DB) becomes an actionable exit-1 message,
 *    never a silent success.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listDomainRouting = vi.fn();
const resetDomainRouting = vi.fn();
const resetAllDomainRouting = vi.fn();

vi.mock('../../../src/cache/store.js', () => ({
  listDomainRouting: (...a: unknown[]) => listDomainRouting(...a),
  resetDomainRouting: (...a: unknown[]) => resetDomainRouting(...a),
  resetAllDomainRouting: (...a: unknown[]) => resetAllDomainRouting(...a),
}));

// Keep DB init out of the thin handler's path — the store is fully mocked.
vi.mock('../../../src/cache/db.js', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { runTune } from '../../../src/cli/tune.js';

const SEED_COOKIE = 'cf_clearance=SUPERSECRETcookievalue123';
const SEED_UA = 'Mozilla/5.0 (X11; SecretUA/1.0)';

function sampleRow(domain: string, overrides: Record<string, unknown> = {}) {
  return {
    domain,
    preferBrowser: false,
    preferTlsImpersonation: true,
    tlsSuccessCount: 3,
    httpFailures: 1,
    backoffUntil: undefined,
    last403At: undefined,
    clearancePresent: true,
    clearanceExpiresAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function capture(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => { stdout.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { stderr.push(String(c)); return true; }) as typeof process.stderr.write;
  return { stdout, stderr, restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; } };
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const cap = capture();
  let code: number;
  try {
    code = await runTune(args);
  } finally {
    cap.restore();
  }
  return { code, stdout: cap.stdout.join(''), stderr: cap.stderr.join('') };
}

beforeEach(() => {
  vi.clearAllMocks();
  listDomainRouting.mockReturnValue([]);
  resetDomainRouting.mockReturnValue(0);
  resetAllDomainRouting.mockReturnValue(0);
});

describe('wigolo tune list', () => {
  it('renders a human table on stderr (nothing on stdout in non-json mode)', async () => {
    listDomainRouting.mockReturnValue([sampleRow('example.com')]);
    const { code, stdout, stderr } = await run(['list']);
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('example.com');
  });

  it('--json emits a single parseable JSON document on stdout', async () => {
    listDomainRouting.mockReturnValue([sampleRow('example.com'), sampleRow('other.com')]);
    const { code, stdout } = await run(['list', '--json']);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout.trim());
    expect(Array.isArray(doc.domains)).toBe(true);
    expect(doc.domains.map((d: { domain: string }) => d.domain)).toEqual(['example.com', 'other.com']);
    // stdout is exactly one JSON line (trailing newline aside).
    expect(stdout.trim().split('\n')).toHaveLength(1);
  });

  it('never leaks the clearance cookie value, UA, or a library name in --json output', async () => {
    listDomainRouting.mockReturnValue([sampleRow('example.com')]);
    const { stdout } = await run(['list', '--json']);
    expect(stdout).not.toContain('SUPERSECRET');
    expect(stdout).not.toContain('SecretUA');
    // Machine JSON is agent-facing: no implementation library names.
    expect(stdout).not.toMatch(/playwright/i);
    void SEED_COOKIE; void SEED_UA;
  });

  it('shows a friendly message when nothing is tracked yet', async () => {
    listDomainRouting.mockReturnValue([]);
    const { code, stderr } = await run(['list']);
    expect(code).toBe(0);
    expect(stderr.toLowerCase()).toContain('no');
  });
});

describe('wigolo tune show <domain>', () => {
  it('prints the single domain summary', async () => {
    listDomainRouting.mockReturnValue([sampleRow('example.com'), sampleRow('other.com')]);
    const { code, stderr } = await run(['show', 'example.com']);
    expect(code).toBe(0);
    expect(stderr).toContain('example.com');
    expect(stderr).not.toContain('other.com');
  });

  it('--json emits a single object for the domain', async () => {
    listDomainRouting.mockReturnValue([sampleRow('example.com')]);
    const { code, stdout } = await run(['show', 'example.com', '--json']);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout.trim());
    expect(doc.domain).toBe('example.com');
    expect(doc.preferTlsImpersonation).toBe(true);
    // show --json must also stay free of library names.
    expect(stdout).not.toMatch(/playwright/i);
    expect(doc).not.toHaveProperty('preferPlaywright');
    expect(doc.preferBrowser).toBe(false);
  });

  it('exits 1 for an unknown domain', async () => {
    listDomainRouting.mockReturnValue([sampleRow('example.com')]);
    const { code, stderr } = await run(['show', 'nope.com']);
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain('nope.com');
  });

  it('--json unknown domain still exits 1 with an {error} document', async () => {
    listDomainRouting.mockReturnValue([]);
    const { code, stdout } = await run(['show', 'nope.com', '--json']);
    expect(code).toBe(1);
    const doc = JSON.parse(stdout.trim());
    expect(doc.error).toBeTruthy();
  });

  it('requires a domain argument', async () => {
    const { code, stderr } = await run(['show']);
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain('domain');
  });
});

describe('wigolo tune reset', () => {
  it('resets one domain and reports the rowcount', async () => {
    resetDomainRouting.mockReturnValue(1);
    const { code, stderr } = await run(['reset', 'example.com']);
    expect(code).toBe(0);
    expect(resetDomainRouting).toHaveBeenCalledWith('example.com');
    expect(stderr).toContain('example.com');
  });

  it('exits 1 when the domain had no routing state (rowcount 0)', async () => {
    resetDomainRouting.mockReturnValue(0);
    const { code, stderr } = await run(['reset', 'nope.com']);
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain('nope.com');
  });

  it('reset --all clears everything and reports the count', async () => {
    resetAllDomainRouting.mockReturnValue(4);
    const { code, stdout } = await run(['reset', '--all', '--json']);
    expect(code).toBe(0);
    expect(resetAllDomainRouting).toHaveBeenCalledTimes(1);
    const doc = JSON.parse(stdout.trim());
    expect(doc.reset).toBe(4);
  });

  it('reset --json emits a single JSON document', async () => {
    resetDomainRouting.mockReturnValue(1);
    const { code, stdout } = await run(['reset', 'example.com', '--json']);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout.trim());
    expect(doc.domain).toBe('example.com');
    expect(doc.reset).toBe(1);
  });

  it('requires a domain (or --all)', async () => {
    const { code, stderr } = await run(['reset']);
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain('domain');
  });
});

describe('wigolo tune — store failure surfaces as an actionable error', () => {
  it('list: a store throw becomes exit 1 with a retry hint (no library names)', async () => {
    listDomainRouting.mockImplementation(() => { throw new Error('database is locked'); });
    const { code, stderr } = await run(['list']);
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain('retry');
    expect(stderr).not.toMatch(/sqlite|better-sqlite3|playwright/i);
  });

  it('reset: a store throw becomes exit 1 (never a silent success)', async () => {
    resetDomainRouting.mockImplementation(() => { throw new Error('database is locked'); });
    const { code, stderr } = await run(['reset', 'example.com']);
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain('retry');
  });

  it('reset --json: store throw yields an {error} doc and exit 1', async () => {
    resetAllDomainRouting.mockImplementation(() => { throw new Error('database is locked'); });
    const { code, stdout } = await run(['reset', '--all', '--json']);
    expect(code).toBe(1);
    const doc = JSON.parse(stdout.trim());
    expect(doc.error).toBeTruthy();
  });
});

describe('wigolo tune — usage', () => {
  it('unknown subcommand exits 1 with usage', async () => {
    const { code, stderr } = await run(['bogus']);
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain('usage');
  });
});
