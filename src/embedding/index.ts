/**
 * Public surface of `src/embedding/` for the companion split (`wigolo/embedding-queue`).
 *
 * The background index queue only: the extracted layer enqueues captured content for
 * indexing, and owns no embedding model of its own.
 *
 * Widened at A7 2026-09-02: the process singleton alone is not enough for the extracted
 * layer's specs. `getBackgroundIndexQueue` hard-codes `dbPath` from config, `syncMode` from
 * an env var and `maxAttempts` to 3, and takes no provider — so a constructor-injected
 * failing `embedProvider`, a lowered `maxAttempts` and an isolated per-test `dbPath` are all
 * unreachable through it.
 */
export { getBackgroundIndexQueue, BackgroundIndexQueue } from './background-queue.js';

/**
 * TEST SUPPORT, deliberately published. The singleton above is process-wide and holds an
 * open handle on one db file; without a reset hook two specs in the extracted layer share
 * that instance, and the `afterEach` that stops `jobs.db` leaking on Windows has nothing to
 * call. Publishing it is a decision on the record, not an accident: it is the only way the
 * private package can drop the singleton it did not create.
 */
export { _resetBackgroundIndexQueueForTest } from './background-queue.js';

export type { IndexJobInput } from './background-queue.js';
