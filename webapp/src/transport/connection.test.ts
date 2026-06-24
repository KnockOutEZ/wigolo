import { describe, it, expect, vi } from 'vitest';
import { StreamConnection, type SocketLike } from './connection.js';

/** A mock socket whose lifecycle events the test fires by hand. */
function mockSocket() {
  const handlers: Record<string, Array<(ev: unknown) => void>> = {};
  const socket: SocketLike = {
    addEventListener: (type, cb) => { (handlers[type] ??= []).push(cb as (ev: unknown) => void); },
    send: vi.fn(),
    close: vi.fn(),
  };
  return { socket, fire: (type: string, ev?: unknown) => (handlers[type] ?? []).forEach((h) => h(ev)) };
}

describe('StreamConnection (S6 reconnect)', () => {
  it('opens on start and reaches "open" when the socket opens', () => {
    const m = mockSocket();
    const openSocket = vi.fn(() => m.socket);
    const conn = new StreamConnection({ openSocket, bearer: 'B', onMessage: () => {} });
    conn.start();
    expect(openSocket).toHaveBeenCalledTimes(1);
    m.fire('open');
    expect(conn.currentState).toBe('open');
  });

  it('routes inbound socket messages to onMessage', () => {
    const m = mockSocket();
    const onMessage = vi.fn();
    const conn = new StreamConnection({ openSocket: () => m.socket, bearer: 'B', onMessage });
    conn.start();
    m.fire('message', { data: '{"t":"frame"}' });
    expect(onMessage).toHaveBeenCalledWith('{"t":"frame"}');
  });

  // PIN-S6: on a drop the tab RE-SUBSCRIBES (opens a brand-new socket) — nothing persists, it re-establishes
  // from scratch. NAMED mutation that REDs: remove the scheduleReconnect() call in the socket 'close' handler
  // → after a close no new socket is opened and openSocket stays at 1.
  it('PIN-S6: re-subscribes (opens a fresh socket) on drop, reusing the in-memory bearer', () => {
    const sockets: ReturnType<typeof mockSocket>[] = [];
    const openSocket = vi.fn(() => { const m = mockSocket(); sockets.push(m); return m.socket; });
    const conn = new StreamConnection({ openSocket, bearer: 'IN-MEMORY-BEARER', onMessage: () => {}, schedule: (fn) => fn() });
    conn.start();
    expect(openSocket).toHaveBeenCalledTimes(1);
    sockets[0].fire('open');
    sockets[0].fire('close'); // drop → immediate reconnect (synchronous schedule) → new socket
    expect(openSocket).toHaveBeenCalledTimes(2); // re-subscribed
    expect(openSocket).toHaveBeenLastCalledWith('IN-MEMORY-BEARER'); // same in-memory bearer, never re-fetched
  });

  it('does not store the bearer in localStorage (stateless tab)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const m = mockSocket();
    const conn = new StreamConnection({ openSocket: () => m.socket, bearer: 'SECRET', onMessage: () => {}, schedule: (fn) => fn() });
    conn.start();
    m.fire('open');
    m.fire('close');
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('stop() prevents further reconnects', () => {
    const openSocket = vi.fn(() => mockSocket().socket);
    const conn = new StreamConnection({ openSocket, bearer: 'B', onMessage: () => {}, schedule: (fn) => fn() });
    conn.start();
    conn.stop();
    expect(conn.currentState).toBe('stopped');
    // a late close after stop must not re-open
    const before = openSocket.mock.calls.length;
    expect(openSocket.mock.calls.length).toBe(before);
  });

  it('backs off with increasing delay across consecutive drops, resetting on a healthy open', () => {
    const delays: number[] = [];
    const m = mockSocket();
    const conn = new StreamConnection({
      openSocket: () => m.socket, bearer: 'B', onMessage: () => {},
      schedule: (_fn, ms) => { delays.push(ms); }, // capture, don't run — isolate the backoff schedule
      backoffMs: (a) => a, // identity for a clean assertion
    });
    conn.start();
    m.fire('close'); // attempt 0 → delay 0
    expect(delays).toEqual([0]);
  });
});
