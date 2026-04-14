import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    embeddingModel: 'BAAI/bge-small-en-v1.5',
    embeddingIdleTimeoutMs: 120000,
    embeddingMaxTextLength: 8000,
  }),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { spawn } from 'node:child_process';
import { getConfig } from '../../../src/config.js';

function createMockProcess(): {
  proc: ChildProcess;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  emitter: EventEmitter;
} {
  const emitter = new EventEmitter();
  const stdin = { write: vi.fn(), end: vi.fn() };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const proc = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    kill: vi.fn().mockReturnValue(true),
    killed: false,
    connected: true,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: '',
    ref: vi.fn(),
    unref: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    channel: undefined,
    stdio: [stdin, stdout, stderr, null, null] as any,
    [Symbol.dispose]: vi.fn(),
  }) as unknown as ChildProcess;

  return { proc, stdin, stdout, stderr, emitter };
}

/** Emit READY on stderr, wait a tick for Promise resolution */
async function emitReady(stderr: EventEmitter, model = 'bge-small-en-v1.5', dims = 384): Promise<void> {
  stderr.emit('data', Buffer.from(`READY model=${model} dims=${dims}\n`));
  await new Promise(r => setTimeout(r, 10));
}

/** Emit a JSON response on stdout, wait a tick */
async function emitResponse(stdout: EventEmitter, response: object): Promise<void> {
  stdout.emit('data', Buffer.from(JSON.stringify(response) + '\n'));
  await new Promise(r => setTimeout(r, 10));
}

describe('EmbeddingSubprocess', () => {
  let EmbeddingSubprocess: any;
  let instance: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    const mod = await import('../../../src/embedding/subprocess.js');
    EmbeddingSubprocess = mod.EmbeddingSubprocess;
  });

  afterEach(() => {
    if (instance) {
      instance.shutdown();
      instance = null;
    }
    vi.restoreAllMocks();
  });

  it('spawns Python process on first embed call', async () => {
    const { proc, stdout, stderr } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();
    const embedPromise = instance.embed('test-id', 'Hello world');

    await emitReady(stderr);
    await emitResponse(stdout, { id: 'test-id', vector: [0.1, 0.2, 0.3] });

    const result = await embedPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: 'test-id', vector: [0.1, 0.2, 0.3] });
  });

  it('reuses existing process for subsequent calls', async () => {
    const { proc, stdout, stderr } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();

    const p1 = instance.embed('id-1', 'First');
    await emitReady(stderr);
    await emitResponse(stdout, { id: 'id-1', vector: [0.1] });
    await p1;

    const p2 = instance.embed('id-2', 'Second');
    // Tick to let embed's `await this.spawnPromise` microtask settle
    // before the pending map entry is created
    await new Promise(r => setTimeout(r, 10));
    await emitResponse(stdout, { id: 'id-2', vector: [0.2] });
    await p2;

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('handles process spawn failure', async () => {
    const { proc, emitter } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();
    const embedPromise = instance.embed('fail-id', 'Test');

    emitter.emit('error', new Error('spawn failed'));

    await expect(embedPromise).rejects.toThrow('spawn failed');
  });

  it('handles error response from Python', async () => {
    const { proc, stdout, stderr } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();
    // Attach rejects handler immediately to prevent unhandled rejection warning
    const assertion = expect(instance.embed('err-id', 'Test')).rejects.toThrow('encoding failed');

    await emitReady(stderr, 'bge');
    await emitResponse(stdout, { id: 'err-id', error: 'encoding failed' });

    await assertion;
  });

  it('matches responses to requests by id', async () => {
    const { proc, stdout, stderr } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();

    const p1 = instance.embed('first', 'Text 1');
    const p2 = instance.embed('second', 'Text 2');

    await emitReady(stderr, 'bge');

    // Respond out of order
    await emitResponse(stdout, { id: 'second', vector: [0.2] });
    await emitResponse(stdout, { id: 'first', vector: [0.1] });

    const r1 = await p1;
    const r2 = await p2;

    expect(r1.vector).toEqual([0.1]);
    expect(r2.vector).toEqual([0.2]);
  });

  it('reports availability as false after spawn failure', async () => {
    const { proc, emitter } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();

    const embedPromise = instance.embed('test', 'Text');
    emitter.emit('error', new Error('python3 not found'));

    await embedPromise.catch(() => {});

    expect(instance.isAvailable()).toBe(false);
  });

  it('reports availability as true after successful spawn', async () => {
    const { proc, stdout, stderr } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();
    const p = instance.embed('test', 'Text');

    await emitReady(stderr, 'bge');
    await emitResponse(stdout, { id: 'test', vector: [0.1] });

    await p;

    expect(instance.isAvailable()).toBe(true);
  });

  it('returns model dimensions from READY message', async () => {
    const { proc, stdout, stderr } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();
    const p = instance.embed('test', 'Text');

    await emitReady(stderr, 'bge-small-en-v1.5', 384);
    await emitResponse(stdout, { id: 'test', vector: new Array(384).fill(0.1) });

    await p;

    expect(instance.getDims()).toBe(384);
    expect(instance.getModel()).toBe('bge-small-en-v1.5');
  });

  it('kills process on shutdown', async () => {
    const { proc, stdout, stderr } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();
    const p = instance.embed('test', 'Text');

    await emitReady(stderr, 'bge');
    await emitResponse(stdout, { id: 'test', vector: [0.1] });
    await p;

    instance.shutdown();

    expect(proc.kill).toHaveBeenCalled();
    instance = null; // already shut down
  });

  it('handles READY timeout', async () => {
    vi.useFakeTimers();

    const { proc } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess({ readyTimeoutMs: 5000 });
    const embedPromise = instance.embed('test', 'Text');

    vi.advanceTimersByTime(6000);

    vi.useRealTimers();
    await expect(embedPromise).rejects.toThrow();
  });

  it('handles process exit during embed', async () => {
    const { proc, stderr, emitter } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();
    const embedPromise = instance.embed('test', 'Text');

    await emitReady(stderr, 'bge');
    emitter.emit('close', 1, null);

    await expect(embedPromise).rejects.toThrow();
  });

  it('truncates text to maxTextLength', async () => {
    vi.mocked(getConfig).mockReturnValue({
      embeddingModel: 'bge',
      embeddingIdleTimeoutMs: 120000,
      embeddingMaxTextLength: 10,
    } as any);

    const { proc, stdin, stdout, stderr } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();
    const p = instance.embed('trunc', 'a'.repeat(100));

    await emitReady(stderr, 'bge');

    const written = stdin.write.mock.calls[0]?.[0] as string;
    if (written) {
      const parsed = JSON.parse(written);
      expect(parsed.text.length).toBeLessThanOrEqual(10);
    }

    await emitResponse(stdout, { id: 'trunc', vector: [0.1] });
    await p;
  });

  it('handles multiple JSON lines in a single data chunk', async () => {
    const { proc, stdout, stderr } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();
    const p1 = instance.embed('a', 'Text A');
    const p2 = instance.embed('b', 'Text B');

    await emitReady(stderr, 'bge');

    // Both responses arrive in one chunk
    const combined =
      JSON.stringify({ id: 'a', vector: [0.1] }) + '\n' +
      JSON.stringify({ id: 'b', vector: [0.2] }) + '\n';
    stdout.emit('data', Buffer.from(combined));
    await new Promise(r => setTimeout(r, 10));

    const r1 = await p1;
    const r2 = await p2;

    expect(r1.vector).toEqual([0.1]);
    expect(r2.vector).toEqual([0.2]);
  });

  it('handles partial JSON lines across data chunks', async () => {
    const { proc, stdout, stderr } = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc);

    instance = new EmbeddingSubprocess();
    const p = instance.embed('split', 'Text');

    await emitReady(stderr, 'bge');

    const fullLine = JSON.stringify({ id: 'split', vector: [0.5] }) + '\n';
    const half1 = fullLine.substring(0, 10);
    const half2 = fullLine.substring(10);

    stdout.emit('data', Buffer.from(half1));
    stdout.emit('data', Buffer.from(half2));
    await new Promise(r => setTimeout(r, 10));

    const result = await p;
    expect(result.vector).toEqual([0.5]);
  });
});
