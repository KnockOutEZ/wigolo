import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WigoloMcpClient, WigoloClientError } from '../src/client.js';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';

function makeJsonRpcResponse(id: number, result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

function makeInitResponse(): string {
  return makeJsonRpcResponse(1, {
    protocolVersion: '2025-03-26',
    serverInfo: { name: 'wigolo', version: '0.4.0' },
    capabilities: { tools: {} },
  });
}

function makeSearchResponse(id: number = 3): string {
  return makeJsonRpcResponse(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          results: [
            {
              title: 'Test Result',
              url: 'https://example.com',
              snippet: 'A test snippet',
              markdown_content: '# Test\nContent here.',
              relevance_score: 0.95,
            },
          ],
          query: 'test',
          engines_used: ['duckduckgo'],
          total_time_ms: 500,
        }),
      },
    ],
    isError: false,
  });
}

function makeFetchResponse(id: number = 3): string {
  return makeJsonRpcResponse(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          url: 'https://example.com',
          title: 'Example Page',
          markdown: '# Example\nPage content.',
          metadata: { description: 'An example' },
          links: [],
          images: [],
          cached: false,
        }),
      },
    ],
    isError: false,
  });
}

function makeErrorResponse(id: number = 3): string {
  return makeJsonRpcResponse(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: 'No results found',
          results: [],
          query: 'empty',
          engines_used: [],
          total_time_ms: 0,
        }),
      },
    ],
    isError: true,
  });
}

interface MockProcess extends EventEmitter {
  stdin: Writable & { written: string[] };
  stdout: Readable;
  stderr: Readable;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
}

function createMockProcess(responses: string[]): MockProcess {
  const stdinData: string[] = [];
  const proc = new EventEmitter() as MockProcess;

  const stdout = new Readable({
    read() {
      // Responses are pushed by stdin writes, not auto-read
    },
  });

  let responseIndex = 0;

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const data = chunk.toString();
      stdinData.push(data);
      try {
        const msg = JSON.parse(data);
        if ('id' in msg && responseIndex < responses.length) {
          process.nextTick(() => {
            stdout.push(responses[responseIndex++]);
          });
        }
      } catch {
        // not JSON
      }
      callback();
    },
  }) as MockProcess['stdin'];
  stdin.written = stdinData;

  const stderr = new Readable({
    read() {
      // Empty stderr
    },
  });

  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.pid = 12345;
  proc.kill = vi.fn();

  return proc;
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

describe('WigoloMcpClient', () => {
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import('node:child_process');
    spawnMock = cp.spawn as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('uses default command and args', () => {
      const client = new WigoloMcpClient();
      expect(client.command).toBe('npx');
      expect(client.args).toEqual(['@staticn0va/wigolo']);
    });

    it('accepts custom command and args', () => {
      const client = new WigoloMcpClient({
        command: 'node',
        args: ['./dist/index.js'],
      });
      expect(client.command).toBe('node');
      expect(client.args).toEqual(['./dist/index.js']);
    });

    it('defaults timeoutMs to 30000', () => {
      const client = new WigoloMcpClient();
      expect(client.timeoutMs).toBe(30000);
    });

    it('accepts custom timeoutMs', () => {
      const client = new WigoloMcpClient({ timeoutMs: 60000 });
      expect(client.timeoutMs).toBe(60000);
    });

    it('is not connected initially', () => {
      const client = new WigoloMcpClient();
      expect(client.isConnected).toBe(false);
    });
  });

  describe('connect', () => {
    it('spawns the subprocess', async () => {
      const mockProc = createMockProcess([makeInitResponse()]);
      spawnMock.mockReturnValue(mockProc);

      const client = new WigoloMcpClient();
      await client.connect();
      expect(spawnMock).toHaveBeenCalledWith(
        'npx',
        ['@staticn0va/wigolo'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
      expect(client.isConnected).toBe(true);
      await client.disconnect();
    });

    it('sends initialize request', async () => {
      const mockProc = createMockProcess([makeInitResponse()]);
      spawnMock.mockReturnValue(mockProc);

      const client = new WigoloMcpClient();
      await client.connect();

      const written = mockProc.stdin.written;
      expect(written.length).toBeGreaterThanOrEqual(1);
      const initMsg = JSON.parse(written[0]);
      expect(initMsg.method).toBe('initialize');
      expect(initMsg.params.protocolVersion).toBe('2025-03-26');
      await client.disconnect();
    });

    it('sends initialized notification after init response', async () => {
      const mockProc = createMockProcess([makeInitResponse()]);
      spawnMock.mockReturnValue(mockProc);

      const client = new WigoloMcpClient();
      await client.connect();

      const written = mockProc.stdin.written;
      expect(written.length).toBeGreaterThanOrEqual(2);
      const notification = JSON.parse(written[1]);
      expect(notification.method).toBe('notifications/initialized');
      expect(notification.id).toBeUndefined();
      await client.disconnect();
    });
  });

  describe('disconnect', () => {
    it('kills the subprocess', async () => {
      const mockProc = createMockProcess([makeInitResponse()]);
      spawnMock.mockReturnValue(mockProc);

      const client = new WigoloMcpClient();
      await client.connect();
      await client.disconnect();
      expect(mockProc.kill).toHaveBeenCalled();
      expect(client.isConnected).toBe(false);
    });

    it('is safe to call when not connected', async () => {
      const client = new WigoloMcpClient();
      await client.disconnect();
    });
  });

  describe('callTool', () => {
    it('calls search tool and returns parsed result', async () => {
      const mockProc = createMockProcess([makeInitResponse(), makeSearchResponse(2)]);
      spawnMock.mockReturnValue(mockProc);

      const client = new WigoloMcpClient();
      await client.connect();

      const result = await client.callTool('search', { query: 'test' });
      expect(result.results).toBeDefined();
      expect(result.results.length).toBe(1);
      expect(result.results[0].title).toBe('Test Result');
      await client.disconnect();
    });

    it('calls fetch tool and returns parsed result', async () => {
      const mockProc = createMockProcess([makeInitResponse(), makeFetchResponse(2)]);
      spawnMock.mockReturnValue(mockProc);

      const client = new WigoloMcpClient();
      await client.connect();

      const result = await client.callTool('fetch', { url: 'https://example.com' });
      expect(result.title).toBe('Example Page');
      expect(result.markdown).toContain('# Example');
      await client.disconnect();
    });

    it('throws when not connected', async () => {
      const client = new WigoloMcpClient();
      await expect(client.callTool('search', { query: 'test' })).rejects.toThrow(
        WigoloClientError,
      );
    });

    it('sends correct JSON-RPC structure', async () => {
      const mockProc = createMockProcess([makeInitResponse(), makeSearchResponse(2)]);
      spawnMock.mockReturnValue(mockProc);

      const client = new WigoloMcpClient();
      await client.connect();
      await client.callTool('search', { query: 'test', max_results: 3 });

      const written = mockProc.stdin.written;
      const toolCallMsgs = written
        .map((w) => JSON.parse(w))
        .filter((m: Record<string, unknown>) => m.method === 'tools/call');
      expect(toolCallMsgs.length).toBe(1);
      expect(toolCallMsgs[0].params.name).toBe('search');
      expect(toolCallMsgs[0].params.arguments.query).toBe('test');
      expect(toolCallMsgs[0].params.arguments.max_results).toBe(3);
      await client.disconnect();
    });

    it('increments request IDs', async () => {
      const mockProc = createMockProcess([
        makeInitResponse(),
        makeSearchResponse(2),
        makeSearchResponse(3),
      ]);
      spawnMock.mockReturnValue(mockProc);

      const client = new WigoloMcpClient();
      await client.connect();
      await client.callTool('search', { query: 'first' });
      await client.callTool('search', { query: 'second' });

      const written = mockProc.stdin.written;
      const ids = new Set(
        written.map((w) => JSON.parse(w)).filter((m: any) => m.id).map((m: any) => m.id),
      );
      expect(ids.size).toBeGreaterThanOrEqual(3);
      await client.disconnect();
    });

    it('returns parsed data from error response', async () => {
      const mockProc = createMockProcess([makeInitResponse(), makeErrorResponse(2)]);
      spawnMock.mockReturnValue(mockProc);

      const client = new WigoloMcpClient();
      await client.connect();

      const result = await client.callTool('search', { query: 'empty' });
      expect(result.error).toBe('No results found');
      await client.disconnect();
    });
  });
});
