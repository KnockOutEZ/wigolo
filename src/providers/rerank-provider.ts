/**
 * Rerank provider interface.
 *
 * The default factory returns TransformersRerankProvider
 * (Transformers.js cross-encoder, in-process ONNX runtime). The legacy
 * Python FlashRank adapter still exists in `search/reranker/legacy-provider.ts`
 * but it is no longer wired in.
 */
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { createIdleUnload, withIdleTracking, type IdleUnload } from './idle-unload.js';

const log = createLogger('providers');
export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

export interface RerankProvider {
  rerank(
    query: string,
    candidates: RerankCandidate[],
    topK?: number,
  ): Promise<RerankResult[]>;
  /** Model identifier (for cache invalidation / provenance). */
  readonly modelId: string;
}

let cached: Promise<RerankProvider> | null = null;
/** The real provider behind `cached`. `cached` may hand out an idle wrapper. */
let instance: RerankProvider | null = null;
let idle: IdleUnload | null = null;

/**
 * True when an error looks like a transient network/fetch blip a retry can
 * recover — the field reranker "fetch failed" during model download, plus common
 * socket/DNS/gateway cousins. Deterministic errors (bad model, bad shape) must
 * NOT match, so they fail fast instead of retrying pointlessly.
 */
export function isTransientFetchError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|502|503|504|gateway time-?out|request timed? ?out/i.test(
    msg,
  );
}

export interface FetchRetryOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run an async op, retrying ONLY transient fetch failures with a linear backoff.
 * A deterministic error, or exhausting the attempt budget, throws immediately.
 * `sleep` is injectable so the retry is tested without real delays.
 */
export async function withFetchRetry<T>(
  op: () => Promise<T>,
  opts: FetchRetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 400;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (i === attempts || !isTransientFetchError(err)) throw err;
      await sleep(delayMs * i);
    }
  }
  throw lastErr;
}

/**
 * Wrap a provider so every call restarts the idle countdown.
 */
function withIdleUnload(provider: RerankProvider, clock: IdleUnload): RerankProvider {
  return withIdleTracking(provider, clock, 'rerank');
}

export function getRerankProvider(): Promise<RerankProvider> {
  if (cached) return cached;
  const config = getConfig();
  cached = (async () => {
    let provider: RerankProvider;
    if (config.reranker === 'remote') {
      const { RemoteRerankProvider } = await import('../search/reranker/remote-rerank-provider.js');
      provider = new RemoteRerankProvider(config);
    } else {
      const { TransformersRerankProvider } = await import('../search/reranker/transformers-rerank-provider.js');
      provider = new TransformersRerankProvider();
      await withFetchRetry(() => (provider as unknown as { warmup(): Promise<void> }).warmup());
      log.info('rerank provider ready', {
        provider: 'rerank',
        impl: 'transformers',
        modelId: provider.modelId,
      });
    }
    instance = provider;
    idle = createIdleUnload({
      timeoutMs: config.rerankerIdleTimeoutMs,
      label: 'rerank',
      onIdle: () => disposeRerankProvider(provider),
    });
    // The model is already loaded by the eager warmup above. Start the
    // countdown now, or it would wait for a rerank() call that may never come.
    idle.touch();
    return withIdleUnload(provider, idle);
  })().catch((err) => {
    cached = null;
    instance = null;
    throw err;
  });
  return cached;
}

export function _resetRerankProviderForTest(): void {
  idle?.cancel();
  idle = null;
  cached = null;
  instance = null;
}

// Best-effort disposal of the cached rerank provider's native resources.
// Called from CLI shutdown, and from the idle countdown, to release the ONNX
// session. `expected` binds the release to the provider that armed the clock,
// so a stale handle cannot dispose a newer provider.
export async function disposeRerankProvider(expected?: RerankProvider): Promise<void> {
  if (expected && instance !== expected) return;
  idle?.cancel();
  idle = null;
  const provider = instance;
  instance = null;
  cached = null;
  if (!provider) return;
  try {
    const disposable = provider as unknown as { dispose?: () => Promise<void> };
    if (typeof disposable.dispose === 'function') await disposable.dispose();
  } catch (err) {
    log.debug('rerank dispose failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
