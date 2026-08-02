import { createLogger } from '../logger.js';
import { getEmbeddingService } from '../embedding/embed.js';

const log = createLogger('server');

interface MaybeWarmable {
  warmup?: () => Promise<void>;
}

let pending: Promise<void> | null = null;
let enginePending: Promise<void> | null = null;

export function isEagerWarmupEnabled(): boolean {
  return process.env.WIGOLO_EAGER_WARMUP === '1';
}

// Primary general-web engine origins. A cold first search drops engines whose
// DNS+TLS handshake doesn't finish inside the merge deadline — the pool
// self-heals only by query #2 (OS DNS + TLS session caches warm across the
// gap). Priming these origins on server start (the long-running process an
// agent connects to) means the FIRST tool call already has warm sockets and the
// full pool. Kept to the weight-1 primaries + the two niche secondaries; Brave
// needs a key and isn't included. Enabled by default; set WIGOLO_WARM_ENGINES=0
// to disable.
const ENGINE_WARM_ORIGINS = [
  'https://www.bing.com',
  'https://lite.duckduckgo.com',
  'https://en.wikipedia.org',
  'https://www.mojeek.com',
  'https://api2.marginalia-search.com',
] as const;

const ENGINE_WARM_TIMEOUT_MS = 4000;

export function isEngineWarmEnabled(): boolean {
  return process.env.WIGOLO_WARM_ENGINES !== '0';
}

/**
 * Fire-and-forget pre-warm of the search engine origins' connection pools
 * (DNS + TLS + keep-alive). Never blocks startup, never throws. A same-origin
 * search request issued later reuses the warm socket, so the first real query
 * gets the full engine pool instead of a cold-handshake-truncated subset.
 */
export function warmEngines(): void {
  if (!isEngineWarmEnabled()) return;
  const start = Date.now();
  enginePending = Promise.allSettled(
    ENGINE_WARM_ORIGINS.map((origin) =>
      fetch(origin, { signal: AbortSignal.timeout(ENGINE_WARM_TIMEOUT_MS) })
        // Consume/discard the body so undici returns the socket to the pool.
        .then((r) => r.body?.cancel?.())
        .catch(() => {}),
    ),
  )
    .then((settled) => {
      const ok = settled.filter((s) => s.status === 'fulfilled').length;
      log.info('engine warm complete', { ms: Date.now() - start, warmed: ok, total: ENGINE_WARM_ORIGINS.length });
    })
    .finally(() => {
      enginePending = null;
    });
}

/** Test-only: returns the in-flight engine-warm promise (or null). */
export function _getEngineWarmPendingForTest(): Promise<void> | null {
  return enginePending;
}

/**
 * Fire-and-forget pre-warm of embed + rerank providers. No-op when env unset.
 * Errors logged at warn, never thrown.
 */
export function maybeEagerWarmup(): void {
  if (!isEagerWarmupEnabled()) return;

  pending = (async () => {
    await Promise.all([warmEmbed(), warmRerank()]);
  })().finally(() => {
    pending = null;
  });
}

async function warmEmbed(): Promise<void> {
  const start = Date.now();
  try {
    // Prime the lazy provider load through the service (D2) so the first real
    // embed/find_similar does not pay the model-load cost.
    await getEmbeddingService().ensureProviderReady();
    log.info('eager warmup: embed ready', { ms: Date.now() - start });
  } catch (err) {
    log.warn('eager warmup: embed failed', {
      ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function warmRerank(): Promise<void> {
  const start = Date.now();
  try {
    const mod = await import('../providers/rerank-provider.js');
    const provider = (await mod.getRerankProvider()) as MaybeWarmable;
    if (typeof provider.warmup === 'function') {
      await provider.warmup();
    }
    log.info('eager warmup: rerank ready', { ms: Date.now() - start });
  } catch (err) {
    log.warn('eager warmup: rerank failed', {
      ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test-only: returns the in-flight warmup promise (or null). */
export function _getWarmupPendingForTest(): Promise<void> | null {
  return pending;
}
