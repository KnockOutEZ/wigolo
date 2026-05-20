import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PythonWorker, type PythonWorkerOptions } from '../python/subprocess-base.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('embedding');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'embedding_server.py');

export interface EmbeddingResponse {
  id: string;
  vector?: number[];
  error?: string;
}

interface EmbedRequest { text: string }
interface EmbedResult { vector: number[] }

export type SubprocessOptions = PythonWorkerOptions;

class EmbeddingWorker extends PythonWorker<EmbedRequest, EmbedResult> {
  private dims: number | null = null;
  private modelName: string | null = null;

  constructor(options?: SubprocessOptions) {
    const config = getConfig();
    super({
      readyTimeoutMs: options?.readyTimeoutMs ?? 60_000,
      requestTimeoutMs: options?.requestTimeoutMs ?? 30_000,
      idleTimeoutMs: options?.idleTimeoutMs ?? config.embeddingIdleTimeoutMs,
    });
  }

  protected scriptPath() { return SCRIPT_PATH; }

  protected spawnArgs() {
    const config = getConfig();
    return [config.embeddingModel, String(config.embeddingMaxTextLength)];
  }

  protected parseReadyLine(line: string): void {
    const modelMatch = line.match(/model=(\S+)/);
    const dimsMatch = line.match(/dims=(\d+)/);
    if (modelMatch) this.modelName = modelMatch[1];
    if (dimsMatch) this.dims = parseInt(dimsMatch[1], 10);
    log.info('embedding subprocess ready', { model: this.modelName, dims: this.dims });
  }

  protected serializeRequest(id: string, req: EmbedRequest): string {
    return JSON.stringify({ id, text: req.text }) + '\n';
  }

  protected parseResponse(line: string): { id: string; result?: EmbedResult; error?: string } {
    const obj = JSON.parse(line) as EmbeddingResponse;
    if (obj.error) return { id: obj.id, error: obj.error };
    return { id: obj.id, result: { vector: obj.vector ?? [] } };
  }

  protected killOnRequestTimeout(): boolean { return false; }

  getDims(): number | null { return this.dims; }
  getModel(): string | null { return this.modelName; }
}

export class EmbeddingSubprocess {
  private worker: EmbeddingWorker;
  constructor(options?: SubprocessOptions) {
    this.worker = new EmbeddingWorker(options);
  }
  isAvailable(): boolean { return this.worker.isAvailable(); }
  getDims(): number | null { return this.worker.getDims(); }
  getModel(): string | null { return this.worker.getModel(); }
  async embed(id: string, text: string): Promise<EmbeddingResponse> {
    try {
      const config = getConfig();
      const truncated = text.slice(0, config.embeddingMaxTextLength);
      const result = await this.worker.call({ text: truncated });
      return { id, vector: result.vector };
    } catch (err) {
      log.error('embed failed', { id, error: String(err) });
      throw err;
    }
  }
  shutdown(): void {
    this.worker.shutdown();
    log.info('embedding subprocess shut down');
  }
}
