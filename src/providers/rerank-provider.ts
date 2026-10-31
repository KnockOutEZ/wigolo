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
/** The handle `cached` returned when idle tracking wrapped the provider. */
let handle: RerankProvider | null = null;
let idle: IdleUnload | null = null;

/**
 * Bumped whenever the factory state is thrown away: a full dispose, or the test
 * reset. A factory call remembers the value at entry, so a completion from an
 * older generation belongs to a lookup that was dropped and cannot publish over
 * the one that replaced it.
 */
let generation = 0;

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
  const startedAt = generation;
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
    if (generation !== startedAt) {
      // A full dispose landed while this warmup was in flight. The factory
      // state belongs to a newer generation now, so this provider can only be
      // released — never published — and the lookup that waited on it fails.
      await releaseRerankProvider(provider);
      throw new Error('rerank provider disposed during initialization');
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
    const wrapped = withIdleUnload(provider, idle);
    handle = wrapped;
    return wrapped;
  })().catch((err) => {
    // Clear the cache only while this generation still owns it, so a newer
    // lookup is never clobbered by an older lookup's failure.
    if (generation === startedAt) {
      cached = null;
      instance = null;
    }
    throw err;
  });
  return cached;
}

export function _resetRerankProviderForTest(): void {
  generation += 1;
  idle?.cancel();
  idle = null;
  cached = null;
  instance = null;
  handle = null;
}

/** Release a specific provider. Errors stay inside this best-effort helper. */
async function releaseRerankProvider(provider: RerankProvider): Promise<void> {
  try {
    const disposable = provider as unknown as { dispose?: () => Promise<void> };
    if (typeof disposable.dispose === 'function') await disposable.dispose();
  } catch (err) {
    log.debug('rerank dispose failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// Best-effort disposal of the cached rerank provider's native resources.
// Called from CLI shutdown, and from the idle countdown, to release the ONNX
// session. `expected` binds the release to the provider that armed the clock,
// so a stale handle cannot dispose a newer provider. The stale handle still
// releases its own provider, which may have reloaded its model meanwhile.
// A full dispose also invalidates an initialization still in flight, so its
// completion can no longer publish itself: it releases only what it built, and
// it waits for that load instead of returning while the ONNX session is still
// being created. Exiting early is what surfaces the macOS `mutex lock failed`
// abort during process teardown.
export async function disposeRerankProvider(expected?: RerankProvider): Promise<void> {
  if (expected && instance !== expected && expected !== handle) {
    // Stale handle: release only the provider it belongs to. The current
    // factory state and countdown stay as they are, and the generation is not
    // bumped — this handle belongs to a lookup that was already replaced.
    await releaseRerankProvider(expected);
    return;
  }
  const pending = cached;
  generation += 1;
  idle?.cancel();
  idle = null;
  const provider = instance;
  instance = null;
  handle = null;
  cached = null;
  if (provider) {
    await releaseRerankProvider(provider);
    return;
  }
  if (!pending) return;
  // No published provider yet, so the only thing to release is what the load
  // produces. Its stale-generation branch releases the provider it built and
  // rejects for the dropped lookup; that rejection is not ours, and the
  // release already happened there, so the two paths cannot double-release.
  // A success path hands out the idle-wrapped handle; that is released here.
  // `TransformersRerankProvider.dispose()` is idempotent, so a second call
  // through this helper is safe even if the provider was already released.
  try {
    const produced = await pending;
    await releaseRerankProvider(produced);
  } catch {
    // Rejected by the factory's stale branch, which released what it built.
  }
}
