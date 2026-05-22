import { closeDatabase } from '../cache/db.js';
import { resetEmbeddingService } from '../embedding/embed.js';
import { disposeRerankProvider } from '../providers/rerank-provider.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli');

// Release native resources (ONNX sessions, sqlite-vec, embedding subprocess)
// before the process exits. Without explicit teardown, libc++ destructors
// race during shutdown and surface as `mutex lock failed: Invalid argument`
// on macOS — the cosmetic-but-loud SIGABRT noted in v0.1.1 bench.
//
// Best-effort: every step swallows its own errors so a partial failure
// doesn't block subsequent cleanup steps.
export async function shutdownCli(): Promise<void> {
  try {
    await disposeRerankProvider();
  } catch (err) {
    log.debug('rerank dispose failed', { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    resetEmbeddingService();
  } catch (err) {
    log.debug('embedding reset failed', { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    closeDatabase();
  } catch (err) {
    log.debug('database close failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
