import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import {
  nodeRuntimeCandidates,
  probeNodeRuntime,
  resolveBrokerNodeRuntime,
  createBrokerClient,
  MAX_NODE_RUNTIME_CANDIDATES,
} from '../../src/main/broker-client';

/**
 * X1-2 — the broker's Node runtime is RESOLVED AND PROVEN, never guessed.
 *
 * The old code picked `WIGOLO_STUDIO_BROKER_NODE || npm_node_execpath || 'node'` and spawned it. A bare
 * `'node'` resolves against PATH, so the service could start on whatever Node the machine happened to
 * carry — a different major, a different ABI — and the damage surfaced much later as a native-module
 * error with no route back to the cause.
 *
 * The trap these tests exist to hold shut: `require()` of an ABI-mismatched native build SUCCEEDS and
 * hands back a callable constructor. Only `new Database()` throws. So a probe that stops at
 * `typeof Database === 'function'` reports a FALSE PASS on precisely the runtime we must reject, which
 * is why `stubs.falsePass` below exists and why it must be rejected.
 */

let dir: string;
const stubs = { good: '', falsePass: '' };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-node-'));
  stubs.good = join(dir, 'good.cjs');
  stubs.falsePass = join(dir, 'false-pass.cjs');
  writeFileSync(stubs.good, 'module.exports = class { close() {} };\n');
  // The exact shape of an ABI-mismatched better-sqlite3: loading is fine, opening is not.
  writeFileSync(
    stubs.falsePass,
    'module.exports = class { constructor() { throw new Error("The module \'/x/better_sqlite3.node\' was ' +
      'compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js ' +
      'requires NODE_MODULE_VERSION 115."); } };\n',
  );
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** A fake `execFileSync` that answers like a healthy runtime, so no real process is spawned. */
function passingExec(abi = '127') {
  return vi.fn((_cmd: string, _args: string[], _opts: object): string => `__wigolo_broker_abi_ok__${abi}`);
}
/** A fake `execFileSync` that fails the way a real ABI mismatch does — non-zero exit carrying stderr. */
function failingExec(stderr: string) {
  return vi.fn((_cmd: string, _args: string[], _opts: object): string => {
    throw Object.assign(new Error('Command failed'), { status: 1, stderr });
  });
}
/** A fake `spawn`, typed so its recorded calls stay inspectable. */
function fakeSpawn() {
  return vi.fn((_cmd: string, _args: string[], _opts: object): ChildProcess => makeInertChild());
}

describe('probeNodeRuntime — the probe must OPEN a database', () => {
  it('rejects a runtime whose engine loads but cannot open a database', () => {
    // Real child process, real `require` success, real constructor failure. If the probe is ever
    // weakened to a load-only check ("typeof Database"), this stub passes and this test goes red.
    const r = probeNodeRuntime(process.execPath, stubs.falsePass);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/NODE_MODULE_VERSION 127/);
  });

  it('accepts a runtime that opens a database, and reports its ABI', () => {
    const r = probeNodeRuntime(process.execPath, stubs.good);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.abi).toBe(process.versions.modules);
  });

  it('the real database engine opens on the runtime this suite runs under', () => {
    // Outside signal: the actual better-sqlite3 build shipped by core, not a stub. Proves the probe
    // script itself is runnable against the real module rather than only against fixtures.
    const real = createRequire(import.meta.url).resolve('better-sqlite3');
    expect(probeNodeRuntime(process.execPath, real).ok).toBe(true);
  });

  it('reports a missing binary as not-found, not as an engine refusal', () => {
    const r = probeNodeRuntime(join(dir, 'no-such-node'), stubs.good);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/not found/i);
  });

  it('bounds the probe: a timeout is always passed to the child', () => {
    const exec = passingExec();
    probeNodeRuntime('node', stubs.good, { execFileSyncFn: exec, timeoutMs: 1234 });
    expect((exec.mock.calls[0][2] as { timeout: number }).timeout).toBe(1234);
    const dflt = passingExec();
    probeNodeRuntime('node', stubs.good, { execFileSyncFn: dflt });
    expect((dflt.mock.calls[0][2] as { timeout: number }).timeout).toBeGreaterThan(0);
  });

  it('a timed-out probe is a rejection, not a hang', () => {
    const exec = vi.fn(() => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    const r = probeNodeRuntime('node', stubs.good, { execFileSyncFn: exec });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/in time/);
  });
});

describe('nodeRuntimeCandidates — bounded, and the override is exclusive', () => {
  it('the override is the ONLY candidate: a named binary is never quietly replaced', () => {
    const c = nodeRuntimeCandidates({ WIGOLO_STUDIO_BROKER_NODE: '/opt/n', npm_node_execpath: '/usr/bin/node' });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ path: '/opt/n', source: 'WIGOLO_STUDIO_BROKER_NODE' });
  });

  it('never walks more candidates than the declared bound', () => {
    expect(nodeRuntimeCandidates({ npm_node_execpath: '/usr/bin/node' }).length)
      .toBeLessThanOrEqual(MAX_NODE_RUNTIME_CANDIDATES);
    expect(nodeRuntimeCandidates({}).length).toBeLessThanOrEqual(MAX_NODE_RUNTIME_CANDIDATES);
  });

  it('falls back to PATH `node` last', () => {
    const c = nodeRuntimeCandidates({ npm_node_execpath: '/usr/bin/node' });
    expect(c[0].source).toBe('npm_node_execpath');
    expect(c[c.length - 1]).toMatchObject({ path: 'node', source: 'PATH' });
  });

  it('deduplicates: the same binary is never probed twice', () => {
    const c = nodeRuntimeCandidates({ npm_node_execpath: process.execPath });
    expect(c.filter((x) => x.path === process.execPath)).toHaveLength(1);
  });
});

describe('resolveBrokerNodeRuntime', () => {
  const brokerPath = createRequire(import.meta.url).resolve('better-sqlite3'); // any file the engine resolves from

  it('a failing override does NOT fall through to another runtime', () => {
    const exec = failingExec('Error: NODE_MODULE_VERSION 127 vs 115');
    const r = resolveBrokerNodeRuntime({ brokerPath, execFileSyncFn: exec, env: { WIGOLO_STUDIO_BROKER_NODE: '/opt/wrong-node' } });
    expect(r.ok).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1); // exactly one candidate was tried
  });

  it('names the runtime tried, the real cause, and the remedy', () => {
    const exec = failingExec(
      "Error: The module '/x/better_sqlite3.node' was compiled against a different Node.js version using " +
        'NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 115.',
    );
    const r = resolveBrokerNodeRuntime({ brokerPath, execFileSyncFn: exec, env: { WIGOLO_STUDIO_BROKER_NODE: '/opt/wrong-node' } });
    expect(r.ok).toBe(false);
    const msg = r.ok === false ? r.message : '';
    expect(msg).toContain('/opt/wrong-node');            // which Node was tried
    expect(msg).toContain('NODE_MODULE_VERSION 127');    // why it was rejected
    expect(msg).toContain('WIGOLO_STUDIO_BROKER_NODE');  // what to set
  });

  it('drops the loader stack so the cause stays readable', () => {
    const exec = failingExec(
      '/p/bindings.js:121\n        throw e;\n        ^\n\nError: mismatch detail\n    at Module._extensions..node (node:internal/modules/cjs/loader:1)\n    at require (node:internal/x:2)',
    );
    const r = resolveBrokerNodeRuntime({ brokerPath, execFileSyncFn: exec, env: { WIGOLO_STUDIO_BROKER_NODE: '/n' } });
    const msg = r.ok === false ? r.message : '';
    expect(msg).toContain('Error: mismatch detail');
    expect(msg).not.toContain('bindings.js:121');
    expect(msg).not.toContain('at Module._extensions');
  });

  it('probes at most the declared bound even when every env source is set', () => {
    const exec = failingExec('nope');
    resolveBrokerNodeRuntime({ brokerPath, execFileSyncFn: exec, env: { npm_node_execpath: '/a/node' } });
    expect(exec.mock.calls.length).toBeLessThanOrEqual(MAX_NODE_RUNTIME_CANDIDATES);
  });

  it('returns the first runtime that proves itself', () => {
    const r = resolveBrokerNodeRuntime({ brokerPath, execFileSyncFn: passingExec('148'), env: { WIGOLO_STUDIO_BROKER_NODE: '/good/node' } });
    expect(r).toMatchObject({ ok: true, path: '/good/node', source: 'WIGOLO_STUDIO_BROKER_NODE', abi: '148' });
  });
});

describe('createBrokerClient — refuses loudly, and stays quiet when healthy', () => {
  const brokerPath = createRequire(import.meta.url).resolve('better-sqlite3');

  it('spawns nothing and rejects with the diagnostic when no runtime proves out', async () => {
    const spawnFn = fakeSpawn();
    const warn = vi.fn();
    const client = createBrokerClient({
      brokerPath,
      spawnFn,
      execFileSyncFn: failingExec('Error: NODE_MODULE_VERSION 127 ... requires NODE_MODULE_VERSION 115.'),
      warn,
    });
    expect(spawnFn).not.toHaveBeenCalled(); // a runtime that cannot open the DB is never started
    await expect(client.ready()).rejects.toThrow(/no usable Node runtime/);
    await expect(client.call('ping')).rejects.toThrow(/WIGOLO_STUDIO_BROKER_NODE/);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('MUST NOT fire on a healthy environment: it starts on the proven path with no warning', () => {
    const spawnFn = fakeSpawn();
    const warn = vi.fn();
    createBrokerClient({ brokerPath, spawnFn, execFileSyncFn: passingExec(), warn });
    expect(warn).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0][0]).toBe(process.execPath); // the candidate that proved out
  });

  it('MUST NOT fire when a caller injects nodePath: the probe is skipped entirely', () => {
    const exec = passingExec();
    const spawnFn = fakeSpawn();
    createBrokerClient({ brokerPath, nodePath: '/injected/node', spawnFn, execFileSyncFn: exec });
    expect(exec).not.toHaveBeenCalled();
    expect(spawnFn.mock.calls[0][0]).toBe('/injected/node');
  });
});

/** A child that never speaks — enough to keep the client alive without a real process. */
function makeInertChild(): ChildProcess {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  return {
    stdout: { setEncoding() { /* noop */ }, on() { /* noop */ } },
    stdin: { write: () => true },
    exitCode: null,
    kill() { /* noop */ },
    on(ev: string, cb: (...a: unknown[]) => void) { handlers.set(ev, cb); return this; },
  } as unknown as ChildProcess;
}
