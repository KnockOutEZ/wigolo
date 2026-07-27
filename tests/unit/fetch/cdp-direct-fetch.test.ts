import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  cdpDirectFetch,
  _setCriForTests,
  _setCdpDirectFetchDepsForTests,
  _setProcessKillForTests,
  type CdpDirectFetchDeps,
  type CdpTransport,
  type CdpSend,
} from '../../../src/fetch/cdp-direct.js';
import { resetConfig } from '../../../src/config.js';
import type { LookupAll } from '../../../src/watch/ssrf.js';

// Records group-kill signals so the process-group teardown path is assertable
// without ever signalling a REAL process group. Routes the fallback (child.kill)
// through by throwing on the group send when asked (see makeGroupKill).
const groupKills: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
function makeGroupKill(opts: { throwOnGroup?: boolean } = {}) {
  return (pid: number, signal: NodeJS.Signals | number): void => {
    groupKills.push({ pid, signal });
    if (opts.throwOnGroup) throw new Error('ESRCH');
  };
}

// A lookup that resolves the host to a fixed set of addresses (drives the
// pre-navigation resolved-host SSRF re-check deterministically).
function lookupTo(addresses: Array<{ address: string; family: number }>): LookupAll {
  return ((_hostname, _options, callback) => {
    callback(null, addresses);
  }) as LookupAll;
}

// Resolves any host to a public IP — keeps the pre-navigation SSRF guard happy
// (and off the real network) for the non-SSRF tests.
const PUBLIC_LOOKUP: LookupAll = lookupTo([{ address: '93.184.216.34', family: 4 }]);

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
// Default mock body is a REALISTIC page (title + real paragraph text) so the
// block-detection classifier reads it as `none`; a pathologically tiny body
// (e.g. "<body>hardcore</body>") trips the near-empty-skeleton heuristic and is
// correctly treated as a challenge shell.
function makeRecordingTransport(
  html = '<html><head><title>hardcore</title></head><body><h1>hardcore</h1>' +
    ('<p>hardcore content paragraph with real words describing an ordinary web article at ordinary length. </p>'.repeat(10)) +
    '</body></html>',
): {
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
    groupKills.length = 0;
    // Default: group kill throws (like a real ESRCH on a fake pid) so teardown
    // falls back to child.kill — keeps existing kill-signal assertions valid AND
    // never signals a real process group.
    _setProcessKillForTests(makeGroupKill({ throwOnGroup: true }));
  });
  afterEach(() => {
    resetConfig();
    _setCriForTests(undefined);
    _setCdpDirectFetchDepsForTests(undefined);
    _setProcessKillForTests(undefined);
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
    const result = await cdpDirectFetch('https://example.com', { lookup: PUBLIC_LOOKUP });
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
    await cdpDirectFetch('https://example.com', { lookup: PUBLIC_LOOKUP });
    expect(h.calls).not.toContain('Runtime.enable');
    expect(h.calls).not.toContain('Target.setAutoAttach');
    expect(h.calls).toContain('Page.createIsolatedWorld');
  });

  it('teardown ALWAYS on success: kills the child and removes the temp dir', async () => {
    const h = makeHarness();
    _setCdpDirectFetchDepsForTests(h.deps);
    await cdpDirectFetch('https://example.com', { lookup: PUBLIC_LOOKUP });
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

  it('SSRF: a DNS-rebind to metadata IP must NOT egress — returns null, NEVER navigates, still tears down', async () => {
    const h = makeHarness();
    _setCdpDirectFetchDepsForTests(h.deps);
    // Public hostname whose DNS record points at the cloud-metadata IP — the
    // upstream literal guard cannot catch this; the resolved-host guard must.
    const rebind = lookupTo([{ address: '169.254.169.254', family: 4 }]);
    const result = await cdpDirectFetch('https://internal.evil.example', { lookup: rebind });
    expect(result).toBeNull();
    // The core invariant: NO egress. Page.navigate is never sent.
    expect(h.calls).not.toContain('Page.navigate');
    // Teardown still fires: child killed, transport closed, temp dir removed.
    expect(h.child.killed).toBe(true);
    expect(h.transportClosed()).toBe(true);
    expect(h.rmCalls.length).toBe(1);
    expect(h.rmCalls[0]).toBe(h.mkdtempDirs[0]);
  });

  it('SSRF: a DNS-rebind to an RFC-1918 IP is also refused (no egress)', async () => {
    const h = makeHarness();
    _setCdpDirectFetchDepsForTests(h.deps);
    const rebind = lookupTo([{ address: '10.1.2.3', family: 4 }]);
    const result = await cdpDirectFetch('https://looks-public.example', { lookup: rebind });
    expect(result).toBeNull();
    expect(h.calls).not.toContain('Page.navigate');
    expect(h.rmCalls.length).toBe(1);
  });

  it('empty-content null path: a transport yielding "" returns null AND tears down', async () => {
    const h = makeHarness();
    // Override the transport so Runtime.evaluate yields an empty string.
    const calls: string[] = [];
    let closedFlag = false;
    const emptyTransport: CdpTransport = {
      send: (async (method: string) => {
        calls.push(method);
        switch (method) {
          case 'Page.createIsolatedWorld':
            return { executionContextId: 7 };
          case 'Runtime.evaluate':
            return { result: { type: 'string', value: '' } };
          case 'Page.navigate':
            return { frameId: 'f1' };
          default:
            return {};
        }
      }) as CdpSend,
      close: async () => { closedFlag = true; },
    };
    h.deps.connectTransport = async () => emptyTransport;
    _setCdpDirectFetchDepsForTests(h.deps);
    const result = await cdpDirectFetch('https://example.com', { lookup: PUBLIC_LOOKUP, timeoutMs: 1500 });
    expect(result).toBeNull();
    expect(calls).toContain('Page.navigate');
    // Shared finally: child killed, transport closed, temp dir removed.
    expect(h.child.killed).toBe(true);
    expect(closedFlag).toBe(true);
    expect(h.rmCalls.length).toBe(1);
  });

  it('block-detection: a challenge/block body (served at 200) returns null + tears down (honest fallback)', async () => {
    // WHY: cdp-direct navigates + reads the DOM; it has no real HTTP status, so
    // a bot wall serving its denial/challenge page at 200 would otherwise be
    // returned as successful content. It must classify the body and fall back.
    // (Live-found 2026-07-28: cdp-direct served "Access to this page has been
    // denied" as a 200.)
    const challengeHtml =
      '<html><head><title>Just a moment...</title>' +
      '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></head>' +
      '<body><div class="cf-browser-verification"></div></body></html>';
    const rec = makeRecordingTransport(challengeHtml);
    const h = makeHarness({ transport: rec.transport });
    _setCdpDirectFetchDepsForTests(h.deps);
    const result = await cdpDirectFetch('https://example.com', { lookup: PUBLIC_LOOKUP, timeoutMs: 1500 });
    expect(result).toBeNull(); // block detected → fall back, do NOT serve the wall
    expect(rec.calls).toContain('Page.navigate'); // it did fetch, then rejected the body
    expect(h.child.killed).toBe(true);
    expect(h.rmCalls.length).toBe(1);
  });

  it('empty-content null path: a non-string Runtime.evaluate result also returns null + tears down', async () => {
    const h = makeHarness();
    const nonStringTransport: CdpTransport = {
      send: (async (method: string) => {
        switch (method) {
          case 'Page.createIsolatedWorld':
            return { executionContextId: 7 };
          case 'Runtime.evaluate':
            return { result: { type: 'undefined', value: undefined } };
          case 'Page.navigate':
            return { frameId: 'f1' };
          default:
            return {};
        }
      }) as CdpSend,
      close: async () => {},
    };
    h.deps.connectTransport = async () => nonStringTransport;
    _setCdpDirectFetchDepsForTests(h.deps);
    const result = await cdpDirectFetch('https://example.com', { lookup: PUBLIC_LOOKUP, timeoutMs: 1500 });
    expect(result).toBeNull();
    expect(h.child.killed).toBe(true);
    expect(h.rmCalls.length).toBe(1);
  });

  it('process-group kill: teardown signals the process group (kill(-pid)), or falls back on throw', async () => {
    const h = makeHarness();
    // Group kill SUCCEEDS this time (does not throw) so the group path is taken
    // and the child.kill fallback is NOT needed.
    _setProcessKillForTests(makeGroupKill({ throwOnGroup: false }));
    _setCdpDirectFetchDepsForTests(h.deps);
    await cdpDirectFetch('https://example.com', { lookup: PUBLIC_LOOKUP });
    // The group was signalled with a NEGATIVE pid (the process-group id).
    expect(groupKills.length).toBeGreaterThanOrEqual(1);
    expect(groupKills[0].pid).toBe(-h.child.pid);
    expect(groupKills[0].signal).toBe('SIGTERM');
    // Group kill succeeded → the parent-only child.kill fallback was NOT used.
    expect(h.child.killSignals).not.toContain('SIGTERM');
  });

  it('process-group kill: spawns the child detached so a group kill is possible', async () => {
    const h = makeHarness();
    _setCdpDirectFetchDepsForTests(h.deps);
    await cdpDirectFetch('https://example.com', { lookup: PUBLIC_LOOKUP });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const opts = h.spawn.mock.calls[0][2] as { detached?: boolean };
    expect(opts.detached).toBe(true);
  });
});
