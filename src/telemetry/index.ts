/**
 * Public surface of the telemetry client.
 *
 * This module owns the API that `src/cli/telemetry.ts` used to own (A-212-7). Call sites
 * use `emit`; long-lived surfaces additionally call `startTelemetry` once.
 */
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { TelemetryClient, type FlushResult } from './client.js';
import type { TelemetryEvent } from './events.js';
import { TELEMETRY_ENDPOINT_ENV } from './off-switch.js';

const log = createLogger('telemetry');

let singleton: TelemetryClient | null = null;
let endpointWarned = false;

/**
 * `WIGOLO_TELEMETRY_ENDPOINT` used to point the old fire-and-forget POST at an arbitrary
 * URL. 0.3.0 sends batches to the account service and nowhere else, so the variable is
 * inert — warned about for one release, then removed. Warned once per process: it is read
 * on paths that run per tool call.
 */
export function warnDeprecatedEndpointEnv(): void {
  if (endpointWarned) return;
  if (process.env[TELEMETRY_ENDPOINT_ENV] === undefined) return;
  endpointWarned = true;
  log.warn(
    `${TELEMETRY_ENDPOINT_ENV} is deprecated and ignored — telemetry batches now go to your account service only. Remove it; it will stop being recognised in the next release.`,
  );
}

function client(): TelemetryClient {
  if (singleton === null) {
    const config = getConfig();
    warnDeprecatedEndpointEnv();
    singleton = new TelemetryClient({
      dataDir: config.dataDir,
      accountsUrl: config.accountsUrl,
      enabled: config.telemetryEnabled,
    });
  }
  return singleton;
}

/** What a user-facing surface should say about telemetry on this install. */
export type TelemetryStatus = 'enabled' | 'disabled' | 'not_activated';

export function telemetryStatus(): TelemetryStatus {
  const c = client();
  if (!c.enabled) return 'disabled';
  return c.isActivated() ? 'enabled' : 'not_activated';
}

/**
 * Is telemetry actually collecting?
 *
 * State-aware, not a pure env comparison: both off switches AND activation have to hold.
 * `doctor` reads this.
 */
export function isTelemetryEnabled(): boolean {
  return telemetryStatus() === 'enabled';
}

/** Queue one event. Never throws, never blocks. Returns whether it was queued. */
export function emit(event: TelemetryEvent): boolean {
  return client().emit(event);
}

/** Arm the 15-minute flush timer. Long-lived surfaces only. */
export function startTelemetry(): void {
  client().start();
}

export function stopTelemetry(): void {
  singleton?.stop();
}

/** Drain the queue now. Awaited only by tests and by explicit verbs — never by a tool path. */
export function flushTelemetry(): Promise<FlushResult> {
  return client().flush();
}

/** Test hook: drop the process singleton so the next call re-reads config. */
export function _resetTelemetryForTest(): void {
  singleton?.stop();
  singleton = null;
  endpointWarned = false;
}

export { TelemetryClient } from './client.js';
export type { FlushResult, FlushStatus, TelemetryClientOpts } from './client.js';
export { TelemetryQueue, queuePath, telemetryDir, QUEUE_CAP_BYTES, type QueuedEvent } from './queue.js';
export {
  EVENT_SCHEMA,
  EVENT_NAMES,
  durationBucket,
  uptimeBucket,
  isValidEvent,
  type TelemetryEvent,
  type TelemetryEventName,
} from './events.js';
export { registrableDomain, isRegistrableDomain, type RegistrableDomain } from './domain.js';
export {
  TELEMETRY_ENV,
  TELEMETRY_ENDPOINT_ENV,
  TELEMETRY_OFF_VALUES,
  TELEMETRY_SETTINGS_KEY,
  parseTelemetryEnv,
  resolveTelemetryEnabled,
} from './off-switch.js';
