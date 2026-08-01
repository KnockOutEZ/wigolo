import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const initSubsystemsMock = vi.hoisted(() => vi.fn());
const dispatchToolMock = vi.hoisted(() => vi.fn());
const startRuntimeBackgroundWorkMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/server.js', () => ({
  initSubsystems: initSubsystemsMock,
  dispatchTool: dispatchToolMock,
  startRuntimeBackgroundWork: startRuntimeBackgroundWorkMock,
}));
import { createLazyMcpServer, createMcpServer } from '../../../src/server/control.js';

async function connectLazyServer() {
  const lazy = createLazyMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lazy-test', version: '1.0' });
  await Promise.all([lazy.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await lazy.server.close();
      await lazy.shutdownRuntime();
    },
  };
}

describe('lazy MCP control plane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initSubsystemsMock.mockResolvedValue({ shutdown: vi.fn().mockResolvedValue(undefined) });
    dispatchToolMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      isError: false,
    });
  });

  it('lists the fixed tool catalog without initializing the runtime', async () => {
    const { client, close } = await connectLazyServer();
    try {
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name)).toEqual([
        'fetch', 'search', 'crawl', 'cache', 'extract',
        'find_similar', 'research', 'agent', 'diff', 'watch',
      ]);
      expect(initSubsystemsMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('shares one runtime initialization across concurrent first calls', async () => {
    let release!: (value: unknown) => void;
    initSubsystemsMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const { client, close } = await connectLazyServer();
    try {
      const calls = Array.from({ length: 32 }, (_, index) => client.callTool({
        name: index % 2 === 0 ? 'cache' : 'diff',
        arguments: index % 2 === 0
          ? { stats: true }
          : { old: { markdown: 'a' }, new: { markdown: 'b' } },
      }));
      await vi.waitFor(() => expect(initSubsystemsMock).toHaveBeenCalledTimes(1));
      release({ shutdown: vi.fn().mockResolvedValue(undefined) });
      const results = await Promise.all(calls);
      expect(results.every((result) => result.isError !== true)).toBe(true);
      expect(initSubsystemsMock).toHaveBeenCalledTimes(1);
      expect(dispatchToolMock).toHaveBeenCalledTimes(32);
      expect(startRuntimeBackgroundWorkMock).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it('latches initialization failure while keeping protocol discovery available', async () => {
    initSubsystemsMock.mockRejectedValueOnce(new Error('fixture failure'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { client, close } = await connectLazyServer();
    try {
      const first = await client.callTool({ name: 'cache', arguments: { stats: true } });
      const second = await client.callTool({ name: 'cache', arguments: { stats: true } });
      for (const result of [first, second]) {
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(JSON.parse(text)).toMatchObject({
          error_reason: 'runtime_initialization_failed',
          retryable: false,
        });
      }
      expect(initSubsystemsMock).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledTimes(1);
      await expect(client.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
    } finally {
      await close();
    }
  });

  it('does not initialize the runtime during shutdown when unused', async () => {
    const { close } = await connectLazyServer();
    await close();
    expect(initSubsystemsMock).not.toHaveBeenCalled();
  });

  it('does not shut down a runtime injected by the daemon', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const controlled = createMcpServer({ shutdown } as never);
    await controlled.shutdownRuntime();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('keeps per-session server and request context isolated over one injected runtime', async () => {
    const shared = { shutdown: vi.fn().mockResolvedValue(undefined) };
    const first = createMcpServer(shared as never);
    const second = createMcpServer(shared as never);
    const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
    const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
    const clientA = new Client({ name: 'daemon-session-a', version: '1.0' });
    const clientB = new Client({ name: 'daemon-session-b', version: '1.0' });
    try {
      await Promise.all([first.server.connect(serverTransportA), clientA.connect(clientTransportA)]);
      await clientA.callTool({ name: 'cache', arguments: { stats: true } });
      await Promise.all([second.server.connect(serverTransportB), clientB.connect(clientTransportB)]);
      await clientB.callTool({ name: 'cache', arguments: { stats: true } });
      expect(dispatchToolMock).toHaveBeenCalledTimes(2);
      const [callA, callB] = dispatchToolMock.mock.calls;
      expect(callA[0]).toBe(shared);
      expect(callB[0]).toBe(shared);
      expect(callA[1]).not.toBe(callB[1]);
      expect(callA[3]).not.toBe(callB[3]);
    } finally {
      await Promise.allSettled([clientA.close(), clientB.close(), first.server.close(), second.server.close()]);
    }
  }, 60000);

  it('waits for in-flight initialization before shutdown completes', async () => {
    let release!: (value: unknown) => void;
    const shutdown = vi.fn().mockResolvedValue(undefined);
    initSubsystemsMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const lazy = createLazyMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'shutdown-test', version: '1.0' });
    await Promise.all([lazy.server.connect(serverTransport), client.connect(clientTransport)]);
    const call = client.callTool({ name: 'cache', arguments: { stats: true } });
    await vi.waitFor(() => expect(initSubsystemsMock).toHaveBeenCalledTimes(1));
    let settled = false;
    const stopping = lazy.shutdownRuntime().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release({ shutdown });
    await Promise.all([call, stopping]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    await client.close();
    await lazy.server.close();
  });
});
