import { describe, it, expect, vi } from 'vitest';
import type { DebuggerLike } from '../../src/main/cdp-transport';
import { createDriveEngine } from '../../src/main/drive-engine';

/** A fake WebContents.debugger that records commands and can push CDP events by method. */
function fakeDebugger(): DebuggerLike & {
  emitMessage: (method: string, params: unknown) => void;
  commands: Array<{ method: string; params?: Record<string, unknown> }>;
} {
  let attached = false;
  let messageCb: ((event: unknown, method: string, params: unknown) => void) | null = null;
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    commands,
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    isAttached: () => attached,
    sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      commands.push({ method, params });
      return {};
    }),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'message') messageCb = cb as typeof messageCb;
    }),
    removeListener: vi.fn(),
    emitMessage: (method: string, params: unknown) => messageCb?.({}, method, params),
  };
}

const viewport = () => ({ width: 800, height: 600 });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createDriveEngine.attachTab', () => {
  it('arms the nav interceptor (Fetch.enable on Document) BEFORE returning the drive — a tab is never drivable with the SSRF fence disarmed', async () => {
    const dbg = fakeDebugger();
    const engine = createDriveEngine();
    // attachTab resolves ONLY after Fetch.enable is acked — the drive is not drivable until then.
    await engine.attachTab('t1', { debugger: dbg, viewport, grant: { humanAllowPrivate: true, agentAllowPrivate: false } });
    expect(dbg.attach).toHaveBeenCalledWith('1.3');
    const enable = dbg.commands.find((c) => c.method === 'Fetch.enable');
    expect(enable).toBeTruthy();
  });

  it('getDrive returns the per-tab record (token, fsm, navEpoch, agent input channel); default holder is human', async () => {
    const dbg = fakeDebugger();
    const engine = createDriveEngine();
    await engine.attachTab('t1', { debugger: dbg, viewport, grant: { humanAllowPrivate: true, agentAllowPrivate: false } });
    const drive = engine.getDrive('t1');
    expect(drive).toBeTruthy();
    expect(drive!.fsm.state()).toBe('human');
    expect(drive!.controlToken.holder).toBe('human');
    expect(drive!.navEpoch.current).toBe(0);
    expect(drive!.channel.viewportCenter()).toEqual({ x: 400, y: 300 });
  });

  it('an agent-spawned tab starts under agent control (background-lane drive with no human attached)', async () => {
    const dbg = fakeDebugger();
    const engine = createDriveEngine();
    await engine.attachTab('bg', {
      debugger: dbg,
      viewport,
      grant: { humanAllowPrivate: true, agentAllowPrivate: false },
      initialHolder: 'agent',
    });
    expect(engine.getDrive('bg')!.fsm.state()).toBe('agent');
  });

  it('allowed Document hop is continued AND bumps the nav epoch; blocked cloud-metadata hop is failed and does NOT bump', async () => {
    const dbg = fakeDebugger();
    const engine = createDriveEngine();
    await engine.attachTab('t1', { debugger: dbg, viewport, grant: { humanAllowPrivate: true, agentAllowPrivate: false } });
    const drive = engine.getDrive('t1')!;

    dbg.emitMessage('Fetch.requestPaused', { requestId: 'r1', request: { url: 'https://example.com/' }, resourceType: 'Document' });
    await flush();
    expect(dbg.commands.some((c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'r1')).toBe(true);
    expect(drive.navEpoch.current).toBe(1);

    dbg.emitMessage('Fetch.requestPaused', {
      requestId: 'r2',
      request: { url: 'http://169.254.169.254/latest/meta-data' },
      resourceType: 'Document',
    });
    await flush();
    expect(dbg.commands.some((c) => c.method === 'Fetch.failRequest' && c.params?.requestId === 'r2')).toBe(true);
    expect(drive.navEpoch.current).toBe(1); // a blocked hop never bumps — else a capture false-aborts
  });

  it('the FSM and the agent input channel share ONE control token: a human preempt fences the in-flight agent unit', async () => {
    const dbg = fakeDebugger();
    const engine = createDriveEngine();
    await engine.attachTab('t1', { debugger: dbg, viewport, grant: { humanAllowPrivate: true, agentAllowPrivate: false } });
    const drive = engine.getDrive('t1')!;
    const epoch = drive.fsm.agentAcquire();
    drive.fsm.onHumanInput(); // native human input preempts
    // The unit stamped at the pre-preempt epoch must be dropped by the shared token's fence.
    const landed = await drive.channel.dispatchAgentUnit(epoch, [
      { kind: 'mouse', type: 'mousePressed', x: 1, y: 1, button: 'left', buttons: 1, clickCount: 1 },
    ]);
    expect(landed).toBe(false);
    expect(drive.fsm.state()).toBe('paused');
  });

  it('detachTab disarms the interceptor (Fetch.disable) and detaches the debugger; getDrive returns undefined', async () => {
    const dbg = fakeDebugger();
    const engine = createDriveEngine();
    await engine.attachTab('t1', { debugger: dbg, viewport, grant: { humanAllowPrivate: true, agentAllowPrivate: false } });
    await engine.detachTab('t1');
    expect(dbg.commands.some((c) => c.method === 'Fetch.disable')).toBe(true);
    expect(dbg.detach).toHaveBeenCalled();
    expect(engine.getDrive('t1')).toBeUndefined();
  });
});
