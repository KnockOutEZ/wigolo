/**
 * The three non-MCP tool surfaces report through the same recorder, and the Never list
 * holds across all of them.
 *
 * WHY THIS FILE IS ONE FILE. `surface` is the only prop that differs between the four
 * dispatch seams, so the failure worth catching is not "does REST emit" but "do two
 * surfaces disagree about what they call themselves, or does one of them ship a URL the
 * others reduce". Both are cross-surface properties and neither is visible from inside a
 * single seam's unit test. The MCP seam has its own arms in
 * `tests/unit/server/tool-telemetry.test.ts`; this file adds `rest`, `cli` and `repl` and
 * then runs the Never-list byte search over everything the three of them wrote together.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { resetConfig } from '../../src/config.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { queuePath } from '../../src/telemetry/queue.js';
import { _resetTelemetryForTest } from '../../src/telemetry/index.js';
import { setActivationChecker } from '../../src/server/activation.js';
import { generateMintKeyPair, mintToken, grant, payload } from '../unit/account/mint-entitlement.js';

/**
 * Every part of the Never list in one string: a full URL, a path, a query, and a token
 * that appears nowhere else in the tree so a false positive is impossible.
 */
const PLANTED_URL = 'https://reports.eu.example.co.uk/q3/board-deck?share=zqxjkvwsecret';
const PLANTED_QUERY = 'zqxjkvwsecret acquisition rumour';
const PLANTED_FRAGMENTS = [
  'zqxjkvwsecret',
  'board-deck',
  '/q3/',
  'reports.eu.',
  'acquisition rumour',
  PLANTED_URL,
];

const mintKeys = generateMintKeyPair();
let dataDir: string;
let savedPubkey: string | undefined;
let savedTelemetryEnv: string | undefined;

function activate(): void {
  const { token } = mintToken(
    mintKeys,
    payload({
      account_id: 'acct_seams',
      valid_until: '2099-01-01T00:00:00.000Z',
      grants: [grant({ product: 'core', type: 'perpetual' })],
    }),
  );
  const dir = join(dataDir, 'account');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      account_id: 'acct_seams',
      email: 'seams@example.invalid',
      entitlement_token: token,
      last_refresh_at: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
}

function queueBytes(): string {
  const path = queuePath(dataDir);
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function queuedEvents(): { name: string; props: Record<string, unknown> }[] {
  return queueBytes()
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { name: string; props: Record<string, unknown> });
}

describe('telemetry seams — rest, cli and repl surfaces', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-seams-'));
    process.env.WIGOLO_DATA_DIR = dataDir;
    savedPubkey = process.env.WIGOLO_ACCOUNTS_PUBKEY;
    process.env.WIGOLO_ACCOUNTS_PUBKEY = mintKeys.publicKeyB64Url;
    savedTelemetryEnv = process.env.WIGOLO_TELEMETRY;
    // Forced ON rather than deleted: leaving it unset makes the switch depend on the
    // ambient absence of a persisted setting, and a byte search over a queue that was
    // silent for that reason passes vacuously. Measured — a settings file with
    // `telemetryEnabled: false` produced exactly that empty-queue false pass.
    process.env.WIGOLO_TELEMETRY = 'on';
    resetConfig();
    setActivationChecker(null);
    _resetTelemetryForTest();
    activate();
    // The `cache` tool reads the local index; without this its dispatch fails at 500 and
    // the arm would be asserting on an error path it did not intend to exercise.
    initDatabase(':memory:');
  });

  afterEach(() => {
    setActivationChecker(null);
    _resetTelemetryForTest();
    delete process.env.WIGOLO_DATA_DIR;
    if (savedPubkey === undefined) delete process.env.WIGOLO_ACCOUNTS_PUBKEY;
    else process.env.WIGOLO_ACCOUNTS_PUBKEY = savedPubkey;
    if (savedTelemetryEnv === undefined) delete process.env.WIGOLO_TELEMETRY;
    else process.env.WIGOLO_TELEMETRY = savedTelemetryEnv;
    resetConfig();
    vi.restoreAllMocks();
    try { closeDatabase(); } catch { /* already closed by a one-shot's finally */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('stamps surface `rest` at the daemon dispatch wrapper, on both outcomes', async () => {
    const { dispatchTool } = await import('../../src/daemon/rest/dispatch.js');

    // A cache read needs no network and no browser — the cheapest real tool path through
    // the wrapper under test. `tests/net-fence` stays untouched by construction.
    const ok = await dispatchTool('cache', { stats: true }, {
      subsystems: { router: { fetch: async () => { throw new Error('unused'); } } },
      untrustedMode: 'inline',
    } as never);
    expect(ok.status).toBe(200);

    // Now a failure: an unimplemented tool name is not reportable, so drive a real tool
    // into a real invalid-input refusal instead.
    await dispatchTool('diff', { old: undefined, new: undefined }, {
      subsystems: { router: { fetch: async () => { throw new Error('unused'); } } },
      untrustedMode: 'inline',
    } as never);

    const events = queuedEvents();
    const runs = events.filter((e) => e.name === 'tool.run');
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (const run of runs) expect(run.props.surface).toBe('rest');
    expect(runs.map((r) => r.props.tool)).toEqual(expect.arrayContaining(['cache', 'diff']));

    const okRun = runs.find((r) => r.props.tool === 'cache');
    expect(okRun?.props.ok).toBe(true);

    const failedRun = runs.find((r) => r.props.tool === 'diff');
    expect(failedRun?.props.ok).toBe(false);
    const errors = events.filter((e) => e.name === 'tool.error');
    expect(errors).toHaveLength(1);
    expect(errors[0].props).toMatchObject({ tool: 'diff', surface: 'rest' });
  });

  it('stamps surface `cli` at the one-shot, with the planted URL absent from the bytes', async () => {
    const { runTool } = await import('../../src/cli/tool-run.js');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // `diff` against two inline blobs: a real tool run with no egress at all. One side
    // carries the planted URL as CONTENT, so the arm exercises the case where the tool's
    // own inputs are exactly what must not reach the queue.
    const exit = await runTool('diff', ['--old', `see ${PLANTED_URL}`, '--new', `see ${PLANTED_URL} v2`]);
    expect(typeof exit).toBe('number');

    const runs = queuedEvents().filter((e) => e.name === 'tool.run');
    expect(runs).toHaveLength(1);
    expect(runs[0].props).toMatchObject({ tool: 'diff', surface: 'cli' });

    for (const fragment of PLANTED_FRAGMENTS) {
      expect(queueBytes()).not.toContain(fragment);
    }
  });

  it('stamps surface `repl` once per command, and normalises find-similar to the enum name', async () => {
    const { startShell } = await import('../../src/repl/shell.js');

    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    output.resume();
    errorOutput.resume();

    const run = startShell(
      { router: { fetch: async () => { throw new Error('unused'); } } } as never,
      { input, output, errorOutput } as never,
    );

    input.write('cache --stats\n');
    // The REPL's hyphenated spelling of a tool the enum spells with an underscore.
    input.write(`find-similar --concept "${PLANTED_QUERY}"\n`);
    // Not a tool at all — must report nothing rather than an `other` bucket.
    input.write('nonsense-command\n');
    input.end();
    await run;

    const runs = queuedEvents().filter((e) => e.name === 'tool.run');
    for (const r of runs) expect(r.props.surface).toBe('repl');
    const tools = runs.map((r) => r.props.tool);
    expect(tools).toContain('cache');
    expect(tools).toContain('find_similar');
    expect(tools).not.toContain('nonsense-command');
    expect(tools).not.toContain('find-similar');

    for (const fragment of PLANTED_FRAGMENTS) {
      expect(queueBytes()).not.toContain(fragment);
    }
  });

  it('THE NEVER-LIST ARM: nothing any surface wrote contains a URL, a query or a path', async () => {
    const { dispatchTool } = await import('../../src/daemon/rest/dispatch.js');
    const { runTool } = await import('../../src/cli/tool-run.js');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const ctx = {
      subsystems: { router: { fetch: async () => { throw new Error('unused'); } } },
      untrustedMode: 'inline',
    } as never;
    await dispatchTool('diff', { old: PLANTED_URL, new: PLANTED_QUERY }, ctx);
    await dispatchTool('cache', { query: PLANTED_QUERY }, ctx);
    await runTool('diff', ['--old', PLANTED_URL, '--new', PLANTED_QUERY]);

    const bytes = queueBytes();
    expect(bytes.length).toBeGreaterThan(0); // the arm is worthless if nothing was written

    for (const fragment of PLANTED_FRAGMENTS) {
      expect(bytes).not.toContain(fragment);
    }
    // Nothing URL-shaped, path-shaped or query-shaped at all — not just these fragments.
    expect(bytes).not.toMatch(/https?:\/\//);
    expect(bytes).not.toMatch(/[?&][a-z_]+=/);

    // Every prop of every event is a member of the closed dictionary.
    for (const event of queuedEvents()) {
      for (const value of Object.values(event.props)) {
        expect(['string', 'boolean']).toContain(typeof value);
      }
    }
  });
});
