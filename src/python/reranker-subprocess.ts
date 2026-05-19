import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PythonWorker, type PythonWorkerOptions } from './subprocess-base.js';
import { getConfig } from '../config.js';
import { resolveModelId } from '../search/reranker/models.js';
import { createLogger } from '../logger.js';

const log = createLogger('reranker');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'reranker_server.py');

interface RerankRequest { query: string; docs: string[] }
interface RerankResult { scores: number[] }

class RerankWorker extends PythonWorker<RerankRequest, RerankResult> {
  private modelDir: string;
  private maxLength: number;
  private inputNames: string[] = [];

  constructor(modelId: string, maxLength: number, options?: PythonWorkerOptions) {
    const config = getConfig();
    super({
      readyTimeoutMs: options?.readyTimeoutMs ?? envInt('WIGOLO_RERANKER_READY_TIMEOUT_MS', 60_000),
      requestTimeoutMs: options?.requestTimeoutMs ?? envInt('WIGOLO_RERANKER_REQUEST_TIMEOUT_MS', 30_000),
      idleTimeoutMs: options?.idleTimeoutMs ?? envInt('WIGOLO_RERANKER_IDLE_TIMEOUT_MS', 300_000),
    });
    this.modelDir = join(config.dataDir, 'models', resolveModelId(modelId));
    this.maxLength = maxLength;
  }

  protected scriptPath() { return SCRIPT_PATH; }
  protected spawnArgs() { return [this.modelDir, String(this.maxLength)]; }

  protected parseReadyLine(line: string): void {
    const inputsMatch = line.match(/input_names=([^\s]+)/);
    if (inputsMatch) this.inputNames = inputsMatch[1].split(',');
    log.info('reranker subprocess ready', {
      modelDir: this.modelDir,
      maxLength: this.maxLength,
      inputNames: this.inputNames,
    });
  }

  protected serializeRequest(id: string, req: RerankRequest): string {
    return JSON.stringify({ id, query: req.query, docs: req.docs }) + '\n';
  }

  protected parseResponse(line: string): { id: string; result?: RerankResult; error?: string } {
    const obj = JSON.parse(line) as { id: string; scores?: number[]; error?: string };
    if (obj.error) return { id: obj.id, error: obj.error };
    return { id: obj.id, result: { scores: obj.scores ?? [] } };
  }

  protected killOnRequestTimeout(): boolean { return true; }
}

const registry = new Map<string, RerankSubprocess>();

export class RerankSubprocess {
  /** Exposed (not private) so tests can override timeouts on the underlying worker. */
  public worker: RerankWorker;
  private registryKey: string;

  constructor(modelId: string, maxLength: number, registryKey: string) {
    this.worker = new RerankWorker(modelId, maxLength);
    this.registryKey = registryKey;
  }

  async score(query: string, docs: string[]): Promise<number[]> {
    const result = await this.worker.call({ query, docs });
    return result.scores;
  }

  isAvailable(): boolean { return this.worker.isAvailable(); }

  shutdown(): void {
    this.worker.shutdown();
    // Proactively evict from the registry so getRerankSubprocess() with the same
    // key produces a fresh wrapper next time. Without this, the cached wrapper
    // still self-heals via the base class's lazy re-spawn — but evicting on
    // shutdown keeps the registry tidy and surfaces broken-process state
    // faster to callers that probe isAvailable().
    //
    // Note: idle-timer-driven shutdown goes through PythonWorker.shutdown()
    // directly (base class), not through this method, so the registry entry
    // is not evicted in that path. Acceptable trade-off — the cached wrapper
    // still self-heals via lazy re-spawn on the next call().
    if (registry.get(this.registryKey) === this) {
      registry.delete(this.registryKey);
    }
  }
}

export function getRerankSubprocess(modelId: string, maxLength: number): RerankSubprocess {
  const key = `${resolveModelId(modelId)}::${maxLength}`;
  let proc = registry.get(key);
  if (!proc) {
    proc = new RerankSubprocess(modelId, maxLength, key);
    registry.set(key, proc);
  }
  return proc;
}

export function resetAllRerankSubprocesses(): void {
  // Snapshot the values before iterating because RerankSubprocess.shutdown()
  // mutates the registry (deletes the entry).
  for (const proc of [...registry.values()]) proc.shutdown();
  registry.clear();
}

function envInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (!v) return defaultValue;
  const parsed = parseInt(v, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
