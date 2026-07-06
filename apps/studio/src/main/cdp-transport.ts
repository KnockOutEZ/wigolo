// Thin CDP transport over Electron's native `webContents.debugger`. This is the
// in-process drive surface the P0 spike proved (same CDP surface as external
// connectOverCDP, zero runtime Playwright dependency). It satisfies the salvaged
// NavCdp and PerceptionCdp seams (both need `send`; NavCdp also needs `on`/`off`)
// and backs the agent input sink.

/** The slice of Electron's WebContents.debugger this transport wraps (fake in tests). */
export interface DebuggerLike {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): void;
  removeListener(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): void;
}

export interface CdpTransport {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to a CDP event by method name (payload is the raw CDP params). */
  on(event: string, cb: (payload: unknown) => void): void;
  off(event: string, cb: (payload: unknown) => void): void;
  attach(): void;
  detach(): void;
}

export function webContentsDebuggerTransport(dbg: DebuggerLike): CdpTransport {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let attached = false;

  const onMessage = (_event: unknown, method: string, params: unknown): void => {
    const set = listeners.get(method);
    if (!set) return;
    for (const cb of set) cb(params);
  };

  return {
    attach(): void {
      if (attached) return;
      dbg.attach('1.3');
      dbg.on('message', onMessage);
      attached = true;
    },
    detach(): void {
      if (!attached) return;
      dbg.removeListener('message', onMessage);
      dbg.detach();
      listeners.clear();
      attached = false;
    },
    async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
      if (!attached) throw new Error(`CDP transport detached: cannot send ${method}`);
      return dbg.sendCommand(method, params);
    },
    on(event: string, cb: (payload: unknown) => void): void {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
    },
    off(event: string, cb: (payload: unknown) => void): void {
      listeners.get(event)?.delete(cb);
    },
  };
}
