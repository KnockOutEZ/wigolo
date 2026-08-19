/**
 * `wigolo flow` — the CLI seam for recorded flows.
 *
 * WHAT THIS COMMAND IS AND IS NOT. It lists and shows recordings. It does **not** run them, and that is
 * a measured limitation rather than a scoping preference: `runStudio` spawns the desktop app and the
 * code states that the daemon-side headless host *"survives only to back tests; the app is the real
 * session host."* A terminal therefore has no session to attend, and an attended replay needs one. The
 * two ways to make a CLI `run` work are both closed — a new MCP tool (refused) or a second dispatch lane
 * (forbidden, since the runner must call the act handler directly). See A178.
 *
 * So what is pinned here is the inspectable half: a recording is worth having before anything replays
 * it, which is the promise the sidecar was built on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCommand } from '../../../src/cli/index.js';
import { runFlowCommand } from '../../../src/cli/flow.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { insertFlowStep } from '../../../src/studio/flow/store.js';
import { resetConfig } from '../../../src/config.js';

function capture(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => { stdout.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { stderr.push(String(c)); return true; }) as typeof process.stderr.write;
  return { stdout, stderr, restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; } };
}

function expectSingleJsonDoc(text: string): Record<string, unknown> {
  const lines = text.trim().split('\n').filter((l) => l.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

let dir: string;
const ORIG_ENV = process.env;

function seedFlow(): void {
  const db = initDatabase(join(dir, 'wigolo.db'));
  const base = {
    flowId: 'flw_cli', sessionId: 'sess-cli', pageUrl: 'https://shop.example.com/search?q=boots',
    healTierAtRecord: 'high' as const,
  };
  insertFlowStep(db, { ...base, seq: 1, auditSeq: 1, action: 'navigate', ts: 1000 });
  insertFlowStep(db, {
    ...base, seq: 2, auditSeq: 2, action: 'type', slot: 'search_orders', ts: 1001,
    target: { role: 'textbox', name: 'Search orders', fingerprint: 'fp1', ancestorPath: 'html/body/form', attrs: { type: 'text' } },
    recordedRef: 'e1',
  });
  insertFlowStep(db, {
    ...base, seq: 3, auditSeq: 3, action: 'click', ts: 1002,
    target: { role: 'button', name: 'Go', fingerprint: 'fp2', ancestorPath: 'html/body/form', attrs: { type: 'submit' } },
    recordedRef: 'e2',
  });
  // Closed on purpose: the command opens the cache itself, exercising the production path.
  closeDatabase();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wg-flow-cli-'));
  // The command resolves its own data dir from config and opens the cache itself, so the test points
  // config AT the temp dir rather than pre-opening a database of its own. Pre-opening is what hid a real
  // defect: `initDatabase` closes and reopens, so a fixture-owned handle made the tests pass while the
  // shipped command threw "Database not initialized" on the very first line of `flow list`.
  process.env = { ...ORIG_ENV, LOG_LEVEL: 'error', WIGOLO_DATA_DIR: dir };
  resetConfig();
});

afterEach(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
  process.env = ORIG_ENV;
  resetConfig();
});

describe('flow — command routing', () => {
  it('routes `flow` as a first-class subcommand, not an unknown', () => {
    // A routed-but-unparsed command fails only at runtime, which is the shape the studio tool
    // name-guards already taught this repo to test for.
    expect(parseCommand(['flow'])).toEqual({ command: 'flow', args: [] });
    expect(parseCommand(['flow', 'list'])).toEqual({ command: 'flow', args: ['list'] });
    expect(parseCommand(['flow', 'show', 'flw_x', '--json'])).toEqual({ command: 'flow', args: ['show', 'flw_x', '--json'] });
  });
});

describe('flow list', () => {
  it('lists each recorded flow with its session, step count and slots', async () => {
    seedFlow();
    const cap = capture();
    let code: number;
    try { code = await runFlowCommand(['list']); } finally { cap.restore(); }
    const out = cap.stdout.join('');
    expect(code).toBe(0);
    expect(out).toContain('flw_cli');
    expect(out).toContain('sess-cli');
    expect(out).toContain('3'); // three steps
    expect(out).toContain('search_orders'); // the slot a run would have to be given
  });

  it('emits exactly one JSON doc on stdout under --json', async () => {
    seedFlow();
    const cap = capture();
    let code: number;
    try { code = await runFlowCommand(['list', '--json']); } finally { cap.restore(); }
    expect(code).toBe(0);
    const doc = expectSingleJsonDoc(cap.stdout.join(''));
    expect(doc.flows).toEqual([
      { flow_id: 'flw_cli', session_id: 'sess-cli', steps: 3, required_slots: ['search_orders'], first_ts: 1000, last_ts: 1002 },
    ]);
  });

  it('exits 0 on an empty store — "no flows recorded" is an answer, not a failure', async () => {
    const cap = capture();
    let code: number;
    try { code = await runFlowCommand(['list']); } finally { cap.restore(); }
    expect(code).toBe(0);
    expect(cap.stdout.join('')).toMatch(/no flows/i);
  });

  it('reports an empty list as `flows: []` under --json, not as an absent key', async () => {
    // A scripted caller distinguishes "none" from "the field moved" only if the key is always there.
    const cap = capture();
    try { await runFlowCommand(['list', '--json']); } finally { cap.restore(); }
    expect(expectSingleJsonDoc(cap.stdout.join('')).flows).toEqual([]);
  });
});

describe('flow show', () => {
  it('prints the steps in seq order with their actions', async () => {
    seedFlow();
    const cap = capture();
    let code: number;
    try { code = await runFlowCommand(['show', 'flw_cli']); } finally { cap.restore(); }
    const out = cap.stdout.join('');
    expect(code).toBe(0);
    expect(out.indexOf('navigate')).toBeLessThan(out.indexOf('type'));
    expect(out.indexOf('type')).toBeLessThan(out.indexOf('click'));
  });

  it('names what a run would require, so the inspection answers the next question', async () => {
    seedFlow();
    const cap = capture();
    try { await runFlowCommand(['show', 'flw_cli', '--json']); } finally { cap.restore(); }
    const doc = expectSingleJsonDoc(cap.stdout.join(''));
    expect(doc.required_slots).toEqual(['search_orders']);
    expect(Array.isArray(doc.steps)).toBe(true);
    expect((doc.steps as unknown[]).length).toBe(3);
  });

  it('shows a step\'s TARGET without its live handles — a stored step has no backendNodeId', async () => {
    seedFlow();
    const cap = capture();
    try { await runFlowCommand(['show', 'flw_cli', '--json']); } finally { cap.restore(); }
    const raw = cap.stdout.join('');
    expect(raw).toContain('Search orders');
    expect(raw).not.toContain('backendNodeId');
    expect(raw).not.toContain('backend_node_id');
  });

  it('emits no value-bearing FIELD — asserted on the key set, not on a substring', async () => {
    // The command is the first surface that shows a recording to a human, so it is the first place a
    // value could reach a terminal or a scroll-back buffer. There is nothing to leak, and this is what
    // says so.
    //
    // Keyed on the field NAMES rather than on forbidden substrings, because the first version of this
    // test forbade a word that legitimately appears in a recorded page URL (`?q=boots`) — it failed on a
    // coincidence while proving nothing about the property. A key-set allow-list cannot be satisfied by
    // an accident and DOES fail the moment a value-bearing field is added.
    seedFlow();
    const cap = capture();
    try { await runFlowCommand(['show', 'flw_cli', '--json']); } finally { cap.restore(); }
    const doc = expectSingleJsonDoc(cap.stdout.join(''));
    const allowed = new Set(['seq', 'action', 'page_url', 'role', 'name', 'slot', 'direction', 'amount']);
    const seen = new Set<string>();
    for (const s of doc.steps as Array<Record<string, unknown>>) for (const k of Object.keys(s)) seen.add(k);
    expect(seen.size).toBeGreaterThan(3); // a step view that emitted nothing would pass vacuously
    expect([...seen].filter((k) => !allowed.has(k))).toEqual([]);
    for (const forbidden of ['text', 'value', 'input', 'content', 'secret']) {
      expect(seen.has(forbidden), `no step field may be named ${forbidden}`).toBe(false);
    }
  });

  it('fails with a usage message when no flow id is given', async () => {
    const cap = capture();
    let code: number;
    try { code = await runFlowCommand(['show']); } finally { cap.restore(); }
    expect(code).not.toBe(0);
    expect(cap.stderr.join('')).toMatch(/flow id/i);
  });

  it('fails clearly on an unknown flow id rather than printing an empty flow', async () => {
    seedFlow();
    const cap = capture();
    let code: number;
    try { code = await runFlowCommand(['show', 'flw_nope']); } finally { cap.restore(); }
    expect(code).not.toBe(0);
    expect(cap.stderr.join('')).toMatch(/not found/i);
  });
});

describe('flow — the surface it deliberately does NOT have', () => {
  it('rejects an unknown subcommand with a usage message', async () => {
    const cap = capture();
    let code: number;
    try { code = await runFlowCommand(['frobnicate']); } finally { cap.restore(); }
    expect(code).not.toBe(0);
    expect(cap.stderr.join('')).toMatch(/list|show/);
  });

  it('rejects `run` with the REASON, not a generic unknown-subcommand error', async () => {
    // A user who reasonably expects `flow run` deserves to learn why it is absent. "Unknown
    // subcommand" would read as a typo and send them looking for the right spelling.
    const cap = capture();
    let code: number;
    try { code = await runFlowCommand(['run', 'flw_cli']); } finally { cap.restore(); }
    expect(code).not.toBe(0);
    const err = cap.stderr.join('');
    expect(err).toMatch(/attended/i);
    expect(err).toMatch(/Studio app/i);
  });

  it('names no implementation dependency in any of its output (capability language)', async () => {
    seedFlow();
    const cap = capture();
    try {
      await runFlowCommand(['list']);
      await runFlowCommand(['show', 'flw_cli']);
      await runFlowCommand(['run', 'flw_cli']);
    } finally { cap.restore(); }
    const all = (cap.stdout.join('') + cap.stderr.join('')).toLowerCase();
    for (const dep of ['playwright', 'cdp', 'electron', 'chromium', 'sqlite', 'better-sqlite3']) {
      expect(all, `user-facing text must not name ${dep}`).not.toContain(dep);
    }
  });
});
