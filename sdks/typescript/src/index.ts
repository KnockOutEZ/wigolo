/**
 * Edge-safe entry point: the client, types, errors, and manifest. This module
 * graph imports NO `node:*` builtin — it runs on browsers, edge runtimes, Deno,
 * and Node. Local-daemon spawning is a node-only concern and lives at the
 * "wigolo-sdk/local" subpath; it is deliberately NOT re-exported here.
 */
export { WigoloClient } from './client.js';
export type { WigoloClientOptions, FetchLike, StreamBody } from './client.js';
export { Runs, parseRunEvent } from './runs.js';
export type {
  Driver,
  DriverGestureKind,
  DriverGestureRequest,
  DriverGestureResponse,
  DriverKind,
  CreateRunRequest,
  EventsOptions,
  ListRunsRequest,
  ListRunsResponse,
  PendingDecision,
  Run,
  RunActor,
  RunCost,
  RunEvent,
  RunMessage,
  RunStatus,
  RunWatch,
  RunsTransport,
  SendMessageRequest,
  SendMessageResponse,
  WatchRunCallbacks,
} from './runs.js';
export { SseParser, LAST_EVENT_ID_HEADER } from './sse.js';
export type { SseMessage } from './sse.js';
export { WigoloError, WigoloApiError, WigoloConnectionError } from './errors.js';
export {
  fenceUntrusted,
  fenceWithEnvelope,
  untrustedContentOf,
  UNTRUSTED_CONTENT_HEADER,
} from './untrusted.js';
export type { UntrustedContent, UntrustedContentMode, WithUntrustedContent } from './untrusted.js';
export { manifest, defaultTimeoutFor } from './manifest.js';
export type { ToolName } from './manifest.js';
export type * from './types.js';
