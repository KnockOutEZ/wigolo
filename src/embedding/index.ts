/**
 * Public surface of `src/embedding/` for the companion split (`wigolo/embedding-queue`).
 *
 * The background index queue only: the extracted layer enqueues captured content for
 * indexing, and owns no embedding model of its own.
 */
export { getBackgroundIndexQueue } from './background-queue.js';
export type { IndexJobInput } from './background-queue.js';
