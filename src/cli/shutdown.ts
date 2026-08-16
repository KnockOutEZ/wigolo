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
// macOS/arm64, 10 reps per cell: a process that has run a real inference
// session aborts on process.exit() whether or not the session is released
// first (10/10 either way), and a process that touches only the DB never
// aborts (10/10 clean, closed or not). Explicit teardown is not the variable —
// the exit path is, so the abort is avoided in `exitCli`, not here.
//
// Why the exit path decides it is still unexplained and is deliberately not
// guessed at again: a named-but-wrong cause in this comment is what sent the
// last people who hit the abort looking at teardown order.
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
