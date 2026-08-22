import { publishRunEvent, type RunsStore } from 'wigolo/studio';
import type { RunStoreClient } from './run-view-model';

/**
 * SD1 mini-spec §6 (A-43-5) — this process is the ONE live run-store owner while the app is running,
 * so its embedded gateway has to be able to serve `/v1/runs*` rather than refuse.
 *
 * It could not, for a structural reason rather than an oversight: the REST surface reads the store
 * through a native SQLite handle, and this Electron main deliberately loads no native module — the
 * DB lives behind the broker child (§13.7). So `/v1/runs*` answered a structured `503
 * store_unavailable`, and once `wigolo-studio-run#70` made a standalone daemon defer to the live
 * owner, that 503 became the answer for the whole machine.
 *
 * The fix is to bind the store rather than to reimplement the surface. `RunsStore` is the async port
 * the shipped handlers speak; this module binds it to the broker, so the daemon and the app run the
 * SAME create validation, list paging, id normalization and resume semantics. A second REST
 * implementation here would be a second contract to keep in step, which is exactly the split law 1
 * forbids.
 */

/**
 * Fan the broker's committed events onto this process's in-process bus.
 *
 * This is what makes the ownership rule worth having. The bus (`run-bus.ts`) is what an SSE tail
 * subscribes to, and it is fed by the `onEvent` hook of a LOCAL store write — which never fires
 * here, because the write happens in the child. Without this bridge the gateway would serve runs
 * and replay history correctly and then sit silent on the live tail, which is a worse failure than
 * the 503 it replaces: it looks like a working stream on an idle run.
 *
 * Call once per client. Registering twice would publish every event twice, and the SSE emitter's
 * monotone guard would hide it on the tail while every other bus subscriber saw the duplicate.
 */
export function bridgeRunEventsToBus(client: RunStoreClient): void {
  client.onRunEvent((runId, event) => publishRunEvent(runId, event));
}

export function createBrokerRunsStore(client: RunStoreClient): RunsStore {
  return {
    create: (input) => client.createRun(input),
    list: (opts) => client.listRuns(opts),
    get: (runId) => client.getRun(runId),
    // `runExists` is a cheap key probe the broker does not expose, so existence costs a projection
    // here where it costs an index hit on the daemon. It is charged once per SSE connect, not per
    // replayed page, and the alternative was a broker method in another lane's territory.
    exists: async (runId) => (await client.getRun(runId)) !== undefined,
    eventsSince: (runId, since, limit) => client.eventsSince(runId, since, limit),
  };
}
