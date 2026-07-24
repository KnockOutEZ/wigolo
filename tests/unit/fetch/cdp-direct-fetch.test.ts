import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  cdpDirectFetch,
  _setCriForTests,
  _setCdpDirectFetchDepsForTests,
  type CdpDirectFetchDeps,
  type CdpTransport,
  type CdpSend,
} from '../../../src/fetch/cdp-direct.js';
import { resetConfig } from '../../../src/config.js';

// A fake spawned child: an EventEmitter with the .kill()/.pid surface the
// orchestrator drives. Records kill signals so a test can assert teardown.
class FakeChild extends EventEmitter {
  pid = 4242;
  killSignals: Array<string | number> = [];
  killed = false;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal ?? 'SIGTERM');
    this.killed = true;
    // Emit exit on the next tick so an awaiter of the exit event resolves.
    setImmediate(() => this.emit('exit', 0, signal ?? null));
    return true;
  }
}

// A recording CDP transport: captures every send so the leak-free invariant is
// asserted end-to-end through cdpDirectFetch (not just cdpDirectConnect).
function makeRecordingTransport(html = '<html><body>hardcore</body></html>'): {
  transport: CdpTransport;
  calls: string[];
  closed: () => boolean;
} {
  const calls: string[] = [];
  let closedFlag = false;
  const send: CdpSend = async (method) => {
    calls.push(method);
    switch (method) {
      case 'Page.createIsolatedWorld':
        return { executionContextId: 99 };
      case 'Runtime.evaluate':
        return { result: { type: 'string', value: html } };
      case 'Page.navigate':
        return { frameId: 'frame-x' };
      default:
        return {};
    }
  };
  return {
    transport: { send, close: async () => { closedFlag = true; } },
    calls,
    closed: () => closedFlag,
  };
}

interface Harness {
  child: FakeChild;
  spawn: ReturnType<typeof vi.fn>;
  rmCalls: string[];
  mkdtempDirs: string[];
  reachable: ReturnType<typeof vi.fn>;
  transport: CdpTransport;
  calls: string[];
  transportClosed: () => boolean;
  deps: CdpDirectFetchDeps;
}

function makeHarness(overrides?: {
  chromePath?: string | null;
  reachable?: boolean;
  transport?: CdpTransport | null;
}): Harness {
  const child = new FakeChild();
  const spawn = vi.fn(() => child);
  const rmCalls: string[] = [];
  const mkdtempDirs: string[] = [];
  const reachable = vi.fn(async () => overrides?.reachable ?? true);
  const rec = makeRecordingTransport();
  const transport = overrides?.transport === undefined ? rec.transport : overrides.transport;

  const deps: CdpDirectFetchDeps = {
    resolveChrome: () => (overrides?.chromePath === undefined ? '/usr/bin/google-chrome' : overrides.chromePath),
    spawn: spawn as unknown as CdpDirectFetchDeps['spawn'],
    isReachable: reachable as unknown as CdpDirectFetchDeps['isReachable'],
    mkdtemp: async (prefix: string) => {
      const dir = `${prefix}fake-XYZ`;
      mkdtempDirs.push(dir);
      return dir;
    },
    rm: async (dir: string) => { rmCalls.push(dir); },
    // The transport seam: when non-null, cdpDirectConnect uses it directly and
    // never touches CRI or a real WS.
    connectTransport: transport ? async () => transport : async () => null,
  };

  return {
    child,
    spawn,
    rmCalls,
    mkdtempDirs,
    reachable,
    transport: transport as CdpTransport,
    calls: rec.calls,
    transportClosed: rec.closed,
    deps,
  };
}

describe('cdpDirectFetch — spawn + orchestrate the raw-CDP content rung', () => {
  beforeEach(() => {
    resetConfig();
    _setCriForTests(undefined);
    _setCdpDirectFetchDepsForTests(undefined);
  });
  afterEach(() => {
    resetConfig();
    _setCriForTests(undefined);
    _setCdpDirectFetchDepsForTests(undefined);
    vi.restoreAllMocks();
  });

  it('returns null when no real Chrome executable is resolvable (→ caller falls back)', async () => {
    const h = makeHarness({ chromePath: null });
    _setCdpDirectFetchDepsForTests(h.deps);
    const result = await cdpDirectFetch('https://example.com', {});
    expect(result).toBeNull();
    // No Chrome → never spawned.
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('returns null when the optional CDP dep / transport is absent (→ fallback)', async () => {
    const h = makeHarness({ transport: null });
    _setCdpDirectFetchDepsForTests(h.deps);
    const result = await cdpDirectFetch('https://example.com', {});
    expect(result).toBeNull();
    // Chrome was spawned then torn down; the temp dir was removed.
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.child.killed).toBe(true);
    expect(h.rmCalls.length).toBe(1);
  });

  it('happy path: spawns raw Chrome, navigates, extracts HTML, returns a browser RawFetchResult', async () => {
    const h = makeHarness();
    _setCdpDirectFetchDepsForTests(h.deps);
    const result = await cdpDirectFetch('https://example.com', {});
    expect(result).not.toBeNull();
    expect(result!.method).toBe('browser');
    expect(result!.html).toContain('hardcore');
    expect(result!.url).toBe('https://example.com');
    expect(result!.statusCode).toBe(200);

    // Raw child process, NOT playwright.launch: the resolved chrome path is the
    // spawned executable, with a --remote-debugging-port and a throwaway profile.
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const [exe, args] = h.spawn.mock.calls[0];
    expect(exe).toBe('/usr/bin/google-chrome');
    const argStr = (args as string[]).join(' ');
    expect(argStr).toMatch(/--remote-debugging-port=/);
    expect(argStr).toMatch(/--user-data-dir=/);
  });

  it('preserves the leak-free invariant end-to-end (NO Runtime.enable / Target.setAutoAttach)', async () => {
    const h = makeHarness();
    _setCdpDirectFetchDepsForTests(h.deps);
    await cdpDirectFetch('https://example.com', {});
    expect(h.calls).not.toContain('Runtime.enable');
    expect(h.calls).not.toContain('Target.setAutoAttach');
    expect(h.calls).toContain('Page.createIsolatedWorld');
  });

  it('teardown ALWAYS on success: kills the child and removes the temp dir', async () => {
    const h = makeHarness();
    _setCdpDirectFetchDepsForTests(h.deps);
    await cdpDirectFetch('https://example.com', {});
    expect(h.child.killed).toBe(true);
    expect(h.child.killSignals).toContain('SIGTERM');
    expect(h.rmCalls.length).toBe(1);
    expect(h.rmCalls[0]).toBe(h.mkdtempDirs[0]);
    // The CDP transport was closed too.
    expect(h.transportClosed()).toBe(true);
  });

  it('teardown ALWAYS on failure: debug endpoint never becomes reachable → null + child killed + dir removed', async () => {
    const h = makeHarness({ reachable: false });
    _setCdpDirectFetchDepsForTests(h.deps);
    // Small budget so the unreachable-poll deadline lands quickly.
    const result = await cdpDirectFetch('https://example.com', { timeoutMs: 300 });
    expect(result).toBeNull();
    expect(h.child.killed).toBe(true);
    expect(h.rmCalls.length).toBe(1);
  });

  it('honors an already-aborted signal: returns null without spawning', async () => {
    const h = makeHarness();
    _setCdpDirectFetchDepsForTests(h.deps);
    const controller = new AbortController();
    controller.abort();
    const result = await cdpDirectFetch('https://example.com', { signal: controller.signal });
    expect(result).toBeNull();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('honors abort raised mid-wait: returns null + tears down', async () => {
    const controller = new AbortController();
    const h = makeHarness();
    // Make reachability abort during the wait, then report not-reachable.
    h.deps.isReachable = (async () => {
      controller.abort();
      return false;
    }) as unknown as CdpDirectFetchDeps['isReachable'];
    _setCdpDirectFetchDepsForTests(h.deps);
    const result = await cdpDirectFetch('https://example.com', { signal: controller.signal });
    expect(result).toBeNull();
    expect(h.child.killed).toBe(true);
    expect(h.rmCalls.length).toBe(1);
  });

  it('never throws to the caller — a spawn error resolves to null', async () => {
    const h = makeHarness();
    h.deps.spawn = (() => { throw new Error('spawn EACCES'); }) as unknown as CdpDirectFetchDeps['spawn'];
    _setCdpDirectFetchDepsForTests(h.deps);
    await expect(cdpDirectFetch('https://example.com', {})).resolves.toBeNull();
  });
});
