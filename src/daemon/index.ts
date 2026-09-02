/**
 * Public surface of `src/daemon/` for the companion split (`wigolo/daemon`).
 *
 * The embedded loopback gateway the app boots in-process, and the bearer-authed client
 * that drives it. Both stay in core; the app reaches them through the `wigolo/studio`
 * barrel today, which the split deletes.
 */
export { DaemonHttpServer } from './http-server.js';
export type { DaemonOptions } from './http-server.js';
export { DaemonProxy } from './proxy.js';
