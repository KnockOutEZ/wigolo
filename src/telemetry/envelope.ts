/**
 * The wire envelope and its chunking, pinned to PX1 §7.
 *
 * ```
 * { client: { version, os, arch }, events: [ { name, ts, props } ] }   // 1..500 events
 * ```
 *
 * The service stamps `account_id` from the Bearer token and `received_at` from its own
 * clock, so neither appears here — the client does not get to name the account it is
 * reporting as.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QueuedEvent } from './queue.js';

/** Server cap on events per batch (PX1 §3). Exceeding it is a 400, not a 413. */
export const MAX_EVENTS_PER_BATCH = 500;

/** Server body limit (PX1 §3). Fastify rejects past this BEFORE parsing, with a 413. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface TelemetryClientInfo {
  version: string;
  os: string;
  arch: string;
}

export interface TelemetryEnvelope {
  client: TelemetryClientInfo;
  events: QueuedEvent[];
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/telemetry/envelope.ts in dev, dist/telemetry/envelope.js in build — package.json
    // is two levels up from both.
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Version, OS and arch ride the envelope, not the per-event props — one copy per batch
 * rather than one per event, and no event schema has to admit a version string.
 */
export function clientInfo(platform: string = process.platform, arch: string = process.arch): TelemetryClientInfo {
  return { version: readPackageVersion(), os: platform, arch };
}

export function buildEnvelope(events: QueuedEvent[], client: TelemetryClientInfo = clientInfo()): TelemetryEnvelope {
  return { client, events };
}

/**
 * Split a drained queue into batches the server will accept.
 *
 * Both caps are enforced here rather than left to the server, because PX1 §7 notes the
 * per-field caps can compose past the 1 MiB body limit: satisfying the event count alone is
 * not enough. A single event too large to send alone is still emitted as its own chunk —
 * the send path's 413 bisect terminates on it and drops exactly that one.
 */
export function chunkEvents(
  events: readonly QueuedEvent[],
  client: TelemetryClientInfo = clientInfo(),
): QueuedEvent[][] {
  const overhead = Buffer.byteLength(JSON.stringify(buildEnvelope([], client)));
  const chunks: QueuedEvent[][] = [];
  let current: QueuedEvent[] = [];
  let currentBytes = overhead;
  for (const event of events) {
    // +1 for the comma that joins this event to the previous one in the array.
    const cost = Buffer.byteLength(JSON.stringify(event)) + 1;
    const wouldOverflow = current.length > 0 && (current.length >= MAX_EVENTS_PER_BATCH || currentBytes + cost > MAX_BODY_BYTES);
    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      currentBytes = overhead;
    }
    current.push(event);
    currentBytes += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
