/**
 * Opt-in telemetry.
 *
 * Off by default. Enabled when `WIGOLO_TELEMETRY=1`. Writes one NDJSON line
 * per event to `${dataDir}/telemetry/events-YYYYMMDD.ndjson`. Optionally
 * fire-and-forget POSTs to a remote endpoint when configured.
 *
 * Telemetry must NEVER throw or block the host — all errors are swallowed.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';

export interface TelemetryEvent {
  ts: string;
  event: string;
  props?: Record<string, unknown>;
}

let _endpoint: string | undefined;

export function isTelemetryEnabled(): boolean {
  return process.env.WIGOLO_TELEMETRY === '1';
}

export function configureRemote(endpoint: string | undefined): void {
  _endpoint = endpoint;
}

function utcDateStamp(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
}

function writeLocal(event: TelemetryEvent): void {
  try {
    const dir = join(getConfig().dataDir, 'telemetry');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `events-${utcDateStamp(new Date(event.ts))}.ndjson`);
    appendFileSync(file, JSON.stringify(event) + '\n');
  } catch {
    // Telemetry must never throw.
  }
}

function postRemote(endpoint: string, event: TelemetryEvent): void {
  try {
    const result = fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'Content-Type': 'application/json' },
    });
    // Fire-and-forget: swallow rejections so callers never see them.
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(() => { /* ignore */ });
    }
  } catch {
    // Sync throw from fetch — also swallowed.
  }
}

export function emit(event: string, props?: Record<string, unknown>): void {
  if (!isTelemetryEnabled()) return;
  const evt: TelemetryEvent = props !== undefined
    ? { ts: new Date().toISOString(), event, props }
    : { ts: new Date().toISOString(), event };
  writeLocal(evt);
  const endpoint = _endpoint ?? process.env.WIGOLO_TELEMETRY_ENDPOINT;
  if (endpoint) postRemote(endpoint, evt);
}

export function _resetTelemetryForTest(): void {
  _endpoint = undefined;
}
