import { describe, it, expect, vi } from 'vitest';
import { webContentsDebuggerTransport, type DebuggerLike } from '../../src/main/cdp-transport';

/** A fake of Electron's WebContents.debugger: records sendCommand, drives 'message' demux. */
function fakeDebugger(): DebuggerLike & { emitMessage: (method: string, params: unknown) => void; attached: boolean } {
  let attached = false;
  let messageCb: ((event: unknown, method: string, params: unknown) => void) | null = null;
  return {
    get attached() {
      return attached;
    },
    set attached(v: boolean) {
      attached = v;
    },
    attach: vi.fn((_v?: string) => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    isAttached: () => attached,
    sendCommand: vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({ ok: true })),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'message') messageCb = cb as typeof messageCb;
    }),
    removeListener: vi.fn(),
    emitMessage: (method: string, params: unknown) => messageCb?.({}, method, params),
  };
}

describe('webContentsDebuggerTransport', () => {
  it('attach() attaches the debugger at CDP 1.3', () => {
    const dbg = fakeDebugger();
    const t = webContentsDebuggerTransport(dbg);
    t.attach();
    expect(dbg.attach).toHaveBeenCalledWith('1.3');
  });

  it('send() proxies to sendCommand and returns its result (satisfies NavCdp/PerceptionCdp send)', async () => {
    const dbg = fakeDebugger();
    const t = webContentsDebuggerTransport(dbg);
    t.attach();
    const res = await t.send('DOM.enable', {});
    expect(dbg.sendCommand).toHaveBeenCalledWith('DOM.enable', {});
    expect(res).toEqual({ ok: true });
  });

  it('demuxes incoming CDP events by method to per-event listeners (3-arg message signature)', () => {
    const dbg = fakeDebugger();
    const t = webContentsDebuggerTransport(dbg);
    t.attach();
    const paused = vi.fn();
    const other = vi.fn();
    t.on('Fetch.requestPaused', paused);
    t.on('Page.frameNavigated', other);
    dbg.emitMessage('Fetch.requestPaused', { requestId: 'r1' });
    expect(paused).toHaveBeenCalledWith({ requestId: 'r1' });
    expect(other).not.toHaveBeenCalled();
  });

  it('off() unsubscribes a listener', () => {
    const dbg = fakeDebugger();
    const t = webContentsDebuggerTransport(dbg);
    t.attach();
    const cb = vi.fn();
    t.on('Fetch.requestPaused', cb);
    t.off('Fetch.requestPaused', cb);
    dbg.emitMessage('Fetch.requestPaused', { requestId: 'r2' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('detach() detaches and further send() rejects (fail loud, not silent)', async () => {
    const dbg = fakeDebugger();
    const t = webContentsDebuggerTransport(dbg);
    t.attach();
    t.detach();
    expect(dbg.detach).toHaveBeenCalled();
    await expect(t.send('DOM.enable')).rejects.toThrow(/detached/i);
  });
});
