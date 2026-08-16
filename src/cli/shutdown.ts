import { closeDatabase } from '../cache/db.js';
import { resetEmbeddingService } from '../embedding/embed.js';
import { disposeRerankProvider } from '../providers/rerank-provider.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli');

// Release the long-lived native resources (inference sessions, embedding
// service, DB handle) so the event loop has nothing left holding it open. That
// is what this function is for: `exitCli` in index.ts exits by draining the
// loop rather than calling process.exit(), and the drain only terminates if
// every handle opened here has been given up.
//
// It is NOT what stops the `mutex lock failed: Invalid argument` SIGABRT on
// macOS, which is what this comment used to claim. Measured, plain Node on
// macOS/arm64, 10 reps per cell: releasing the inference session before exiting
// still aborts 10/10, and a process that touches only the DB never aborts at
// all, closed or not (10/10 clean). Neither of the two things this function
// does is the variable — the exit path is. See `exitCli` in index.ts, which is
// where the abort is actually avoided, and which records the measured
// precondition and the fact that the underlying cause is still OPEN.
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
