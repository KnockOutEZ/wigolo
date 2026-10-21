import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cdpDirectConnect,
  loadCRI,
  _setCriForTests,
  type CdpSend,
  type CdpTransport,
} from '../../../src/fetch/cdp-direct.js';

// A recording CDP transport: captures every send(method, params) so a test can
// assert the leak-free invariant — that the connect/eval sequence issues ZERO
// `Runtime.enable` and ZERO `Target.setAutoAttach`.
function makeRecordingTransport(overrides?: {
  onSend?: (method: string, params?: Record<string, unknown>) => unknown;
}): {
  transport: CdpTransport;
  calls: Array<{ method: string; params?: Record<string, unknown> }>;
  closed: () => boolean;
} {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let closedFlag = false;
  const send: CdpSend = async (method, params) => {
    calls.push({ method, params });
    if (overrides?.onSend) {
      const r = overrides.onSend(method, params);
      if (r !== undefined) return r;
    }
    // Default happy-path responses for the commands the handle issues.
    switch (method) {
      case 'Page.createIsolatedWorld':
        return { executionContextId: 42 };
      case 'Runtime.evaluate':
        return { result: { type: 'string', value: '<html><body>hello</body></html>' } };
      case 'Page.navigate':
        return { frameId: 'frame-1' };
      default:
        return {};
    }
  };
  const transport: CdpTransport = {
    send,
    close: async () => {
      closedFlag = true;
    },
  };
  return { transport, calls, closed: () => closedFlag };
}

describe('cdp-direct — leak-free raw-CDP connect', () => {
  beforeEach(() => {
    _setCriForTests(undefined);
  });
  afterEach(() => {
    _setCriForTests(undefined);
    vi.restoreAllMocks();
  });

  it('connect + navigate + getContentHtml issues NO Runtime.enable and NO Target.setAutoAttach', async () => {
    const { transport, calls } = makeRecordingTransport();
    const handle = await cdpDirectConnect({ transport });
    expect(handle).not.toBeNull();

    await handle!.navigate('https://example.com');
    const html = await handle!.getContentHtml();
    expect(html).toContain('hello');

    const methods = calls.map((c) => c.method);
    // The whole point: these fingerprinted handshake commands must never appear.
    expect(methods).not.toContain('Runtime.enable');
    expect(methods).not.toContain('Target.setAutoAttach');
  });

  it('evaluates through an isolated world, never the default auto-enabled Runtime path', async () => {
    const { transport, calls } = makeRecordingTransport();
    const handle = await cdpDirectConnect({ transport });
    await handle!.navigate('https://example.com');
    await handle!.getContentHtml();

    const methods = calls.map((c) => c.method);
    // Isolated world must be created before evaluation.
    expect(methods).toContain('Page.createIsolatedWorld');

    const isoIdx = methods.indexOf('Page.createIsolatedWorld');
    const evalIdx = methods.indexOf('Runtime.evaluate');
    expect(evalIdx).toBeGreaterThan(isoIdx);

    // Runtime.evaluate must be scoped to the isolated world's contextId.
    const evalCall = calls.find((c) => c.method === 'Runtime.evaluate');
    expect(evalCall?.params?.contextId).toBe(42);
  });

  it('getContentHtml returns the isolated-world eval string', async () => {
    const { transport } = makeRecordingTransport({
      onSend: (method) =>
        method === 'Runtime.evaluate'
          ? { result: { type: 'string', value: '<html>ISO</html>' } }
          : undefined,
    });
    const handle = await cdpDirectConnect({ transport });
    await handle!.navigate('https://x.test');
    expect(await handle!.getContentHtml()).toBe('<html>ISO</html>');
  });

  it('close() detaches the transport and is idempotent', async () => {
    const { transport, closed } = makeRecordingTransport();
    const handle = await cdpDirectConnect({ transport });
    expect(closed()).toBe(false);
    await handle!.close();
    expect(closed()).toBe(true);
    // Idempotent — second close does not throw.
    await expect(handle!.close()).resolves.toBeUndefined();
  });

  it('honors an already-aborted signal by returning null (no connect)', async () => {
    const { transport, calls } = makeRecordingTransport();
    const controller = new AbortController();
    controller.abort();
    const handle = await cdpDirectConnect({ transport, signal: controller.signal });
    expect(handle).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('operations after close reject safely (abort-safe teardown)', async () => {
    const { transport } = makeRecordingTransport();
    const handle = await cdpDirectConnect({ transport });
    await handle!.close();
    await expect(handle!.getContentHtml()).rejects.toThrow();
  });
});

describe('cdp-direct — graceful optional-dependency fallback', () => {
  beforeEach(() => {
    _setCriForTests(undefined);
  });
  afterEach(() => {
    _setCriForTests(undefined);
  });

  it('loadCRI returns null when the optional dep is absent', async () => {
    // Simulate an unavailable dep by installing an explicit null override.
    _setCriForTests(null);
    const cri = await loadCRI();
    expect(cri).toBeNull();
  });

  it('cdpDirectConnect returns null (no throw) when neither transport nor CRI is available', async () => {
    _setCriForTests(null);
    const handle = await cdpDirectConnect({
      cdpUrl: 'http://127.0.0.1:9222',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
    });
    expect(handle).toBeNull();
  });

  it('cdpDirectConnect uses CRI to build a transport when the dep is present', async () => {
    const calls: string[] = [];
    // Minimal CRI factory stub: returns a client with send + close.
    const criFactory = vi.fn(async () => ({
      send: async (method: string, params?: Record<string, unknown>) => {
        calls.push(method);
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        if (method === 'Runtime.evaluate') return { result: { type: 'string', value: '<html/>' } };
        return {};
      },
      close: async () => {},
    }));
    _setCriForTests(criFactory);

    const handle = await cdpDirectConnect({
      cdpUrl: 'http://127.0.0.1:9222',
      // Provide the page target directly so we don't need a live /json endpoint.
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
    });
    expect(handle).not.toBeNull();
    expect(criFactory).toHaveBeenCalledTimes(1);

    await handle!.navigate('https://example.com');
    await handle!.getContentHtml();
    expect(calls).not.toContain('Runtime.enable');
    expect(calls).not.toContain('Target.setAutoAttach');
    await handle!.close();
  });
});
