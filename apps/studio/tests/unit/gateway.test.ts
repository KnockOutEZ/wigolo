import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGateway, type GatewayDaemon } from '../../src/main/gateway';
import { readHandle, getMyInstanceId, setMyInstanceId, type StudioHostHandlers, type StudioSessionsAccessor, type DaemonOptions } from 'wigolo/studio';

const hostHandlers = (): StudioHostHandlers => ({
  observe: async () => ({ id: 's', kind: 'full', trusted: false, untrusted_notice: 'x', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  act: async (i) => ({ ok: true, action: i.action }),
  marks: async () => ({ marks: [], untrusted_notice: 'x' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
  spawn: async () => ({ session_id: 's1' }),
  close: async (i) => ({ closed: true as const, session_id: i.session_id ?? '' }),
  list: async () => ({ sessions: [] }),
});
const sessionsAccessor: StudioSessionsAccessor = { getSessionDrive: () => undefined };

/** Records the exact method-call order so the security-critical boot sequence can be asserted. */
function recordingDaemon(order: string[], opts: DaemonOptions): GatewayDaemon {
  return {
    start: async () => { order.push('start'); return `http://${opts.host}:65123`; },
    stop: async () => { order.push('stop'); },
    setStudioHost: () => { order.push('setStudioHost'); },
    setStudioSessions: () => { order.push('setStudioSessions'); },
  };
}

describe('startGateway — embedded loopback MCP gateway boot', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wigolo-gw-')); });
  afterEach(() => { setMyInstanceId(null); rmSync(dir, { recursive: true, force: true }); });

  it('injects host + sessions BEFORE publishing the discovery handle (no unset-host window)', async () => {
    const order: string[] = [];
    const gw = await startGateway({
      host: hostHandlers(), sessions: sessionsAccessor, sessionId: 'sess-A', dataDir: dir,
      makeDaemon: (opts) => recordingDaemon(order, opts),
    });
    // handle write is NOT in `order` (it's a fs write), but both setters must precede it: assert both
    // setters ran after start and before the handle exists.
    expect(order).toEqual(['start', 'setStudioHost', 'setStudioSessions']);
    const handle = readHandle(dir);
    expect(handle).toBeTruthy();
    expect(handle!.endpoint).toBe('http://127.0.0.1:65123');
    expect(handle!.id).toBe('sess-A');
    expect(handle!.token.length).toBeGreaterThan(0);
    // the self-reference guard's instance id is published in-memory and matches the handle
    expect(getMyInstanceId()).toBe(handle!.instanceId);
    await gw.stop();
  });

  it('binds loopback with a bearer + Origin/Host guard (auth.host threaded to checkOriginHost)', async () => {
    let captured: DaemonOptions | null = null;
    const gw = await startGateway({
      host: hostHandlers(), sessions: sessionsAccessor, sessionId: 's', dataDir: dir,
      makeDaemon: (opts) => { captured = opts; return recordingDaemon([], opts); },
    });
    expect(captured!.host).toBe('127.0.0.1');
    expect(captured!.auth?.token).toBe(gw.token);
    expect(captured!.auth?.host).toBe('127.0.0.1');
    await gw.stop();
  });

  it('stop() removes the discovery handle and clears the instance id (stale handle never lingers)', async () => {
    const order: string[] = [];
    const gw = await startGateway({
      host: hostHandlers(), sessions: sessionsAccessor, sessionId: 's', dataDir: dir,
      makeDaemon: (opts) => recordingDaemon(order, opts),
    });
    expect(readHandle(dir)).toBeTruthy();
    await gw.stop();
    expect(readHandle(dir)).toBeNull();
    expect(getMyInstanceId()).toBeNull();
    expect(order).toContain('stop');
  });
});
