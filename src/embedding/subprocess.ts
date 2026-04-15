import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { getPythonBin } from '../python-env.js';

const log = createLogger('embedding');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'embedding_server.py');

export interface EmbeddingResponse {
  id: string;
  vector?: number[];
  error?: string;
}

interface PendingRequest {
  resolve: (value: EmbeddingResponse) => void;
  reject: (reason: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export interface SubprocessOptions {
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class EmbeddingSubprocess {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private available: boolean | null = null;
  private dims: number | null = null;
  private modelName: string | null = null;
  private spawnPromise: Promise<void> | null = null;
  private stdoutBuffer = '';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimeoutMs: number;
  private requestTimeoutMs: number;

  constructor(options?: SubprocessOptions) {
    this.readyTimeoutMs = options?.readyTimeoutMs ?? 60000;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30000;
  }

  isAvailable(): boolean {
    return this.available === true;
  }

  getDims(): number | null {
    return this.dims;
  }

  getModel(): string | null {
    return this.modelName;
  }

  async embed(id: string, text: string): Promise<EmbeddingResponse> {
    try {
      if (!this.proc && !this.spawnPromise) {
        this.spawnPromise = this.spawnProcess();
      }
      if (this.spawnPromise) {
        await this.spawnPromise;
      }

      if (!this.proc || this.available === false) {
        throw new Error('Embedding subprocess not available');
      }

      this.resetIdleTimer();

      const config = getConfig();
      const truncatedText = text.slice(0, config.embeddingMaxTextLength);

      return await new Promise<EmbeddingResponse>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Embedding request ${id} timed out after ${this.requestTimeoutMs}ms`));
        }, this.requestTimeoutMs);

        this.pending.set(id, { resolve, reject, timeoutHandle });

        const request = JSON.stringify({ id, text: truncatedText }) + '\n';
        this.proc!.stdin!.write(request);
      });
    } catch (err) {
      log.error('embed failed', { id, error: String(err) });
      throw err;
    }
  }

  shutdown(): void {
    try {
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
        this.proc.stdin?.end();
        this.proc.kill();
        this.proc = null;
      }

      this.spawnPromise = null;
      log.info('embedding subprocess shut down');
    } catch (err) {
      log.error('shutdown error', { error: String(err) });
    }
  }

  private async spawnProcess(): Promise<void> {
    const config = getConfig();

    try {
      log.info('spawning embedding subprocess', { model: config.embeddingModel });

      const proc = spawn(getPythonBin(), [
        SCRIPT_PATH,
        config.embeddingModel,
        String(config.embeddingMaxTextLength),
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.proc = proc;

      await new Promise<void>((resolve, reject) => {
        const readyTimeout = setTimeout(() => {
          reject(new Error(`Embedding subprocess READY timeout after ${this.readyTimeoutMs}ms`));
          proc.kill();
        }, this.readyTimeoutMs);

        let stderrBuf = '';

        proc.stderr!.on('data', (data: Buffer) => {
          stderrBuf += data.toString();
          const lines = stderrBuf.split('\n');

          for (const line of lines) {
            if (line.startsWith('READY')) {
              clearTimeout(readyTimeout);
              const modelMatch = line.match(/model=(\S+)/);
              const dimsMatch = line.match(/dims=(\d+)/);
              if (modelMatch) this.modelName = modelMatch[1];
              if (dimsMatch) this.dims = parseInt(dimsMatch[1], 10);

              this.available = true;
              log.info('embedding subprocess ready', {
                model: this.modelName,
                dims: this.dims,
              });
              resolve();
              return;
            }
            if (line.startsWith('ERROR')) {
              clearTimeout(readyTimeout);
              this.available = false;
              reject(new Error(`Embedding subprocess: ${line}`));
              return;
            }
          }
        });

        proc.on('error', (err) => {
          clearTimeout(readyTimeout);
          this.available = false;
          this.proc = null;
          this.spawnPromise = null;
          log.error('embedding subprocess error', { error: String(err) });
          reject(err);
        });

        proc.on('close', (code) => {
          clearTimeout(readyTimeout);
          this.available = false;
          this.proc = null;
          this.spawnPromise = null;

          for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timeoutHandle);
            pending.reject(new Error(`Embedding subprocess exited with code ${code}`));
            this.pending.delete(id);
          }

          if (code !== 0 && code !== null) {
            log.warn('embedding subprocess exited', { code });
            reject(new Error(`Embedding subprocess exited with code ${code}`));
          }
        });
      });

      proc.stdout!.on('data', (data: Buffer) => {
        this.handleStdoutData(data.toString());
      });

      this.resetIdleTimer();

    } catch (err) {
      this.available = false;
      this.proc = null;
      this.spawnPromise = null;
      log.error('failed to spawn embedding subprocess', { error: String(err) });
      throw err;
    }
  }

  private handleStdoutData(data: string): void {
    this.stdoutBuffer += data;

    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const response = JSON.parse(trimmed) as EmbeddingResponse;
        const id = response.id;

        if (id && this.pending.has(id)) {
          const pending = this.pending.get(id)!;
          this.pending.delete(id);
          clearTimeout(pending.timeoutHandle);

          if (response.error) {
            pending.reject(new Error(response.error));
          } else {
            pending.resolve(response);
          }
        } else {
          log.warn('received response for unknown request', { id });
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
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    const config = getConfig();
    this.idleTimer = setTimeout(() => {
      log.info('embedding subprocess idle timeout, shutting down');
      this.shutdown();
    }, config.embeddingIdleTimeoutMs);
  }
}
