/**
 * Edge-safe entry point: the client, types, errors, and manifest. This module
 * graph imports NO `node:*` builtin — it runs on browsers, edge runtimes, Deno,
 * and Node. Local-daemon spawning is a node-only concern and lives at the
 * "@wigolo/sdk/local" subpath; it is deliberately NOT re-exported here.
 */
export { WigoloClient } from './client.js';
export type { WigoloClientOptions, FetchLike } from './client.js';
export { WigoloError, WigoloApiError, WigoloConnectionError } from './errors.js';
export { manifest, defaultTimeoutFor } from './manifest.js';
export type { ToolName } from './manifest.js';
export type * from './types.js';
