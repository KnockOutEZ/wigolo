import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { spawn } from 'node:child_process';
import { PythonWorker } from '../../../src/python/subprocess-base.js';

interface FakeRes { value: number }
interface FakeReq { input: number }

class TestWorker extends PythonWorker<FakeReq, FakeRes> {
  public killOnTimeout = false;
  protected scriptPath() { return '/tmp/test.py'; }
  protected spawnArgs() { return ['arg1', 'arg2']; }
  protected parseReadyLine(line: string): void {
    const m = line.match(/READY value=(\d+)/);
    if (!m) throw new Error(`bad ready line: ${line}`);
  }
  protected serializeRequest(id: string, req: FakeReq): string {
    return JSON.stringify({ id, input: req.input }) + '\n';
  }
  protected parseResponse(line: string): { id: string; result?: FakeRes; error?: string } {
    const obj = JSON.parse(line);
    if (obj.error) return { id: obj.id, error: obj.error };
    return { id: obj.id, result: { value: obj.value } };
  }
  protected killOnRequestTimeout(): boolean { return this.killOnTimeout; }
}

function makeProc(): { proc: ChildProcess; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; killSpy: ReturnType<typeof vi.fn> } {
  const proc = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  (proc as any).stdin = stdin;
  (proc as any).stdout = stdout;
  (proc as any).stderr = stderr;
  const killSpy = vi.fn();
  (proc as any).kill = killSpy;
  return { proc, stdin, stdout, stderr, killSpy };
}

describe('PythonWorker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses READY line on stderr and resolves spawn', async () => {
    const { proc, stderr } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    const w = new TestWorker();
    const callPromise = w.call({ input: 1 });
    setTimeout(() => stderr.emit('data', Buffer.from('READY value=42\n')), 5);
    setTimeout(() => (proc as any).stdout.emit('data', Buffer.from(JSON.stringify({ id: '*', value: 99 }) + '\n')), 10);
    await new Promise(r => setTimeout(r, 30));
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['/tmp/test.py', 'arg1', 'arg2']), expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }));
  });

  it('handles READY line chunked across two data events (R10 regression)', async () => {
    const { proc, stderr } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    const w = new TestWorker();
    const p = w.call({ input: 1 }).catch(() => {});
    setTimeout(() => stderr.emit('data', Buffer.from('READY val')), 5);
    setTimeout(() => stderr.emit('data', Buffer.from('ue=42\n')), 10);
    await new Promise(r => setTimeout(r, 30));
    expect(w.isAvailable()).toBe(true);
    w.shutdown();
    await p;
  });

  it('rejects spawn on ERROR line', async () => {
    const { proc, stderr } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    const w = new TestWorker();
    const p = w.call({ input: 1 });
    setTimeout(() => stderr.emit('data', Buffer.from('ERROR import failed\n')), 5);
    setTimeout(() => proc.emit('close', 1), 10);
    await expect(p).rejects.toThrow(/import failed/);
  });

  it('rejects spawn on READY timeout and kills proc', async () => {
    const { proc, killSpy } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    const w = new TestWorker({ readyTimeoutMs: 20 });
    await expect(w.call({ input: 1 })).rejects.toThrow(/READY timeout/i);
    expect(killSpy).toHaveBeenCalled();
  });

  it('dispatches request/response by UUID', async () => {
    const { proc, stdout, stderr, stdin } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    const w = new TestWorker();
    const writes: string[] = [];
    stdin.on('data', (chunk) => writes.push(chunk.toString()));
    setTimeout(() => stderr.emit('data', Buffer.from('READY value=1\n')), 5);
    const p = w.call({ input: 7 });
    await new Promise(r => setTimeout(r, 20));
    const sent = JSON.parse(writes.join('').trim());
    stdout.emit('data', Buffer.from(JSON.stringify({ id: sent.id, value: 13 }) + '\n'));
    await expect(p).resolves.toEqual({ value: 13 });
  });

  it('routes out-of-order responses to correct pending requests', async () => {
    const { proc, stdout, stderr, stdin } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    const w = new TestWorker();
    const writes: string[] = [];
    stdin.on('data', (chunk) => writes.push(chunk.toString()));
    setTimeout(() => stderr.emit('data', Buffer.from('READY value=1\n')), 5);
    const p1 = w.call({ input: 1 });
    const p2 = w.call({ input: 2 });
    await new Promise(r => setTimeout(r, 20));
    const lines = writes.join('').trim().split('\n');
    const id1 = JSON.parse(lines[0]).id;
    const id2 = JSON.parse(lines[1]).id;
    stdout.emit('data', Buffer.from(JSON.stringify({ id: id2, value: 200 }) + '\n'));
    stdout.emit('data', Buffer.from(JSON.stringify({ id: id1, value: 100 }) + '\n'));
    await expect(p1).resolves.toEqual({ value: 100 });
    await expect(p2).resolves.toEqual({ value: 200 });
  });

  it('request timeout: rejects without killing when killOnRequestTimeout=false (default)', async () => {
    const { proc, stderr, killSpy } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    const w = new TestWorker({ requestTimeoutMs: 20 });
    setTimeout(() => stderr.emit('data', Buffer.from('READY value=1\n')), 5);
    await expect(w.call({ input: 1 })).rejects.toThrow(/timed out/i);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('request timeout: kills proc when killOnRequestTimeout=true', async () => {
    const { proc, stderr, killSpy } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    const w = new TestWorker({ requestTimeoutMs: 20 });
    w.killOnTimeout = true;
    setTimeout(() => stderr.emit('data', Buffer.from('READY value=1\n')), 5);
    await expect(w.call({ input: 1 })).rejects.toThrow(/timed out/i);
    expect(killSpy).toHaveBeenCalled();
  });

  it('crash mid-request rejects ALL pending', async () => {
    const { proc, stderr } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    const w = new TestWorker();
    setTimeout(() => stderr.emit('data', Buffer.from('READY value=1\n')), 5);
    const p1 = w.call({ input: 1 });
    const p2 = w.call({ input: 2 });
    await new Promise(r => setTimeout(r, 20));
    proc.emit('close', 137);
    await expect(p1).rejects.toThrow(/exited with code 137/);
    await expect(p2).rejects.toThrow(/exited with code 137/);
  });

  it('shutdown clears timers, rejects pending, closes streams', () => {
    const { proc } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    const w = new TestWorker();
    w.shutdown();
    expect(w.isAvailable()).toBe(false);
  });

  it('strips PYTHONHOME/PYTHONPATH/PYTHONSTARTUP from child env by default', async () => {
    const { proc, stderr } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    process.env.PYTHONHOME = '/some/path';
    process.env.PYTHONPATH = '/another/path';
    process.env.PYTHONSTARTUP = '/yet/another';
    const w = new TestWorker();
    const p = w.call({ input: 1 }).catch(() => {});
    setTimeout(() => stderr.emit('data', Buffer.from('READY value=1\n')), 5);
    await new Promise(r => setTimeout(r, 20));
    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const env = (spawnCall[2] as { env: NodeJS.ProcessEnv }).env;
    expect(env.PYTHONHOME).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.PYTHONSTARTUP).toBeUndefined();
    w.shutdown();
    await p;
    delete process.env.PYTHONHOME;
    delete process.env.PYTHONPATH;
    delete process.env.PYTHONSTARTUP;
  });

  it('preserves PYTHON* env vars when WIGOLO_RERANKER_INHERIT_PYTHON_ENV=1', async () => {
    const { proc, stderr } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    process.env.PYTHONPATH = '/keep/this';
    process.env.WIGOLO_RERANKER_INHERIT_PYTHON_ENV = '1';
    const w = new TestWorker();
    const p = w.call({ input: 1 }).catch(() => {});
    setTimeout(() => stderr.emit('data', Buffer.from('READY value=1\n')), 5);
    await new Promise(r => setTimeout(r, 20));
    const env = (vi.mocked(spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
    expect(env.PYTHONPATH).toBe('/keep/this');
    w.shutdown();
    await p;
    delete process.env.PYTHONPATH;
    delete process.env.WIGOLO_RERANKER_INHERIT_PYTHON_ENV;
  });

  it('idle timer triggers shutdown after idleTimeoutMs', async () => {
    vi.useFakeTimers();
    const { proc, stderr } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    const w = new TestWorker({ idleTimeoutMs: 100 });
    setTimeout(() => stderr.emit('data', Buffer.from('READY value=1\n')), 5);
    const p = w.call({ input: 1 }).catch(() => {});
    await vi.advanceTimersByTimeAsync(150);
    expect(w.isAvailable()).toBe(false);
    vi.useRealTimers();
    await p;
  });

  it('idleTimeoutMs=0 disables idle shutdown', async () => {
    vi.useFakeTimers();
    const { proc, stderr } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    const w = new TestWorker({ idleTimeoutMs: 0 });
    setTimeout(() => stderr.emit('data', Buffer.from('READY value=1\n')), 5);
    const p = w.call({ input: 1 }).catch(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.isAvailable()).toBe(true);
    vi.useRealTimers();
    w.shutdown();
    await p;
  });

  it('spawn-arg with spaces passes through unmangled (Windows path safety)', async () => {
    const { proc, stderr } = makeProc();
    vi.mocked(spawn).mockReturnValue(proc);
    class SpacePathWorker extends TestWorker {
      protected scriptPath() { return 'C:\\Some Path\\test.py'; }
      protected spawnArgs() { return ['C:\\Another Dir\\model']; }
    }
    const w = new SpacePathWorker();
    const p = w.call({ input: 1 }).catch(() => {});
    setTimeout(() => stderr.emit('data', Buffer.from('READY value=1\n')), 5);
    await new Promise(r => setTimeout(r, 20));
    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('C:\\Some Path\\test.py');
    expect(spawnArgs).toContain('C:\\Another Dir\\model');
    w.shutdown();
    await p;
  });
});
