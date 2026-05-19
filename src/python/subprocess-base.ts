import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getPythonBin } from '../python-env.js';
import { createLogger } from '../logger.js';

const log = createLogger('python-worker');

export interface PythonWorkerOptions {
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const SCRUBBED_ENV_VARS = ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP'] as const;

export abstract class PythonWorker<Req, Res> {
  protected proc: ChildProcess | null = null;
  protected pending = new Map<string, PendingRequest>();
  protected stdoutBuffer = '';
  protected stderrBuffer = '';
  protected available: boolean | null = null;
  protected idleTimer: ReturnType<typeof setTimeout> | null = null;
  protected spawnPromise: Promise<void> | null = null;
  protected readyTimeoutMs: number;
  protected requestTimeoutMs: number;
  protected idleTimeoutMs: number;

  constructor(options: PythonWorkerOptions = {}) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
  }

  protected abstract scriptPath(): string;
  protected abstract spawnArgs(): string[];
  protected abstract parseReadyLine(line: string): void;
  protected abstract serializeRequest(id: string, req: Req): string;
  protected abstract parseResponse(line: string): { id: string; result?: Res; error?: string };
  protected killOnRequestTimeout(): boolean { return false; }

  isAvailable(): boolean { return this.available === true; }

  /** @internal — test-only accessor. Returns the underlying ChildProcess or null. */
  _getProcessForTest(): ChildProcess | null { return this.proc; }

  protected childEnv(): NodeJS.ProcessEnv {
    const inherit = process.env.WIGOLO_RERANKER_INHERIT_PYTHON_ENV === '1';
    if (inherit) return { ...process.env };
    const env = { ...process.env };
    for (const k of SCRUBBED_ENV_VARS) delete env[k];
    return env;
  }

  // call() lazily spawns the subprocess on first invocation, awaits the READY handshake,
  // then writes the JSON-line request and awaits a matching id on stdout. Mirrors
  // EmbeddingSubprocess.embed() at src/embedding/subprocess.ts:61-87.
  async call(req: Req): Promise<Res> {
    if (!this.proc && !this.spawnPromise) {
      this.spawnPromise = this.spawnProcess();
    }
    if (this.spawnPromise) {
      try {
        await this.spawnPromise;
      } catch (err) {
        this.spawnPromise = null;
        throw err;
      }
    }
    if (!this.proc || this.available !== true) {
      throw new Error('Python subprocess not available');
    }
    this.resetIdleTimer();

    const id = randomId();
    return new Promise<Res>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        if (this.killOnRequestTimeout()) {
          try { this.proc?.kill(); } catch { /* ignore */ }
          this.available = false;
          this.proc = null;
          this.spawnPromise = null;
        }
        reject(new Error(`Python subprocess request ${id} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutHandle,
      });

      const line = this.serializeRequest(id, req);
      this.proc!.stdin!.write(line);
    });
  }

  shutdown(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error('Subprocess shutting down'));
      this.pending.delete(id);
    }
    if (this.proc) {
      try { this.proc.stdin?.end(); } catch { /* ignore */ }
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
    this.spawnPromise = null;
    this.available = false;
  }

  private async spawnProcess(): Promise<void> {
    const py = getPythonBin();
    const args = [this.scriptPath(), ...this.spawnArgs()];
    const env = this.childEnv();
    log.info('spawning python subprocess', { script: this.scriptPath() });

    const proc = spawn(py, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.proc = proc;

    await new Promise<void>((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        reject(new Error(`Python subprocess READY timeout after ${this.readyTimeoutMs}ms`));
        try { proc.kill(); } catch { /* ignore */ }
      }, this.readyTimeoutMs);

      proc.stderr!.on('data', (data: Buffer) => {
        this.stderrBuffer += data.toString();
        const lines = this.stderrBuffer.split('\n');
        this.stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('READY')) {
            clearTimeout(readyTimeout);
            try {
              this.parseReadyLine(line);
              this.available = true;
              resolve();
            } catch (err) {
              this.available = false;
              reject(err instanceof Error ? err : new Error(String(err)));
            }
            return;
          }
          if (line.startsWith('ERROR')) {
            clearTimeout(readyTimeout);
            this.available = false;
            reject(new Error(`Python subprocess: ${line}`));
            return;
          }
        }
      });

      proc.on('error', (err) => {
        clearTimeout(readyTimeout);
        this.available = false;
        this.proc = null;
        this.spawnPromise = null;
        reject(err);
      });

      proc.on('close', (code) => {
        clearTimeout(readyTimeout);
        this.available = false;
        const exitErr = new Error(`Python subprocess exited with code ${code}`);
        for (const [id, pending] of this.pending.entries()) {
          clearTimeout(pending.timeoutHandle);
          pending.reject(exitErr);
          this.pending.delete(id);
        }
        this.proc = null;
        this.spawnPromise = null;
        if (code !== 0 && code !== null) reject(exitErr);
      });
    });

    proc.stdout!.on('data', (data: Buffer) => {
      this.handleStdoutData(data.toString());
    });

    this.resetIdleTimer();
  }

  private handleStdoutData(data: string): void {
    this.stdoutBuffer += data;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = this.parseResponse(trimmed);
        const pending = this.pending.get(parsed.id);
        if (!pending) {
          log.warn('received response for unknown request', { id: parsed.id });
          continue;
        }
        this.pending.delete(parsed.id);
        clearTimeout(pending.timeoutHandle);
        if (parsed.error) {
          pending.reject(new Error(parsed.error));
        } else if (parsed.result !== undefined) {
          pending.resolve(parsed.result);
        } else {
          pending.reject(new Error('Response missing both result and error'));
        }
      } catch (err) {
        log.warn('failed to parse subprocess stdout line', {
          line: trimmed.slice(0, 200),
          error: String(err),
        });
      }
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      log.info('python subprocess idle timeout, shutting down');
      this.shutdown();
    }, this.idleTimeoutMs);
  }
}

function randomId(): string {
  return randomUUID();
}
