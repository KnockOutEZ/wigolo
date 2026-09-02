/**
 * DEPRECATED — this module has been absorbed into `src/telemetry/` (A-212-7).
 *
 * What used to live here was an opt-in local logger: `WIGOLO_TELEMETRY=1` wrote
 * `events-YYYYMMDD.ndjson` day-files under the data directory and, if
 * `WIGOLO_TELEMETRY_ENDPOINT` was set, fire-and-forget POSTed each event to an arbitrary
 * URL. None of that survives 0.3.0. Telemetry is opt-OUT, batched through a single capped
 * queue, and goes to the account service or nowhere.
 *
 * The implementation is gone rather than duplicated: this file re-exports the one
 * definition so a deep importer gets one release of grace instead of a broken build, and
 * it will be removed in the release after. `emit` and `configureRemote` had no production
 * consumer and are not re-exported — the new `emit` takes a closed dictionary event, so
 * silently re-pointing the old free-form signature at it would be a lie about its type.
 *
 * New code imports from `../telemetry/index.js` directly.
 *
 * @deprecated Import `isTelemetryEnabled` from `../telemetry/index.js`.
 */
export { isTelemetryEnabled, telemetryStatus, type TelemetryStatus } from '../telemetry/index.js';
