/**
 * The disk queue — one capped NDJSON file at `<dataDir>/telemetry/queue.ndjson`.
 *
 * A single file, not the retired `events-YYYYMMDD.ndjson` day-file rotation: rotation was
 * built for a local log nobody drained, and a queue that IS drained needs a bounded total
 * rather than a bounded day. Pre-existing day-files are ignored and cleaned opportunistically.
 *
 * Nothing here throws. Telemetry that can fail a host operation is worse than telemetry that
 * loses an event, so every filesystem error is swallowed and logged at debug.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../logger.js';
import { isValidEvent, type TelemetryEvent } from './events.js';

const log = createLogger('telemetry');

/** Hard cap on the queue file. §5 pin 5. */
export const QUEUE_CAP_BYTES = 5 * 1024 * 1024;

/**
 * Eviction low-water mark. Evicting down to exactly the cap would rewrite the whole file on
 * every subsequent append; evicting to 80% amortises the rewrite over the headroom it just
 * created.
 */
export const QUEUE_EVICT_TARGET_BYTES = Math.floor(QUEUE_CAP_BYTES * 0.8);

/** Retired day-file name shape, matched only so it can be cleaned. */
const LEGACY_DAY_FILE = /^events-\d{8}\.ndjson$/;

/** A dictionary event plus the client-side timestamp it was queued at. */
export type QueuedEvent = TelemetryEvent & { ts: string };

export function telemetryDir(dataDir: string): string {
  return join(dataDir, 'telemetry');
}

export function queuePath(dataDir: string): string {
  return join(telemetryDir(dataDir), 'queue.ndjson');
}

function isQueuedEvent(candidate: unknown): candidate is QueuedEvent {
  if (!isValidEvent(candidate)) return false;
  const ts = (candidate as { ts?: unknown }).ts;
  return typeof ts === 'string' && ts.length > 0;
}

/**
 * The append-only queue.
 *
 * Instances are cheap and hold no file handle — several processes append to the same file
 * concurrently, which `appendFileSync`'s O_APPEND makes safe for whole short lines. The
 * rewrite paths (eviction, post-flush truncation) are last-writer-wins across processes;
 * that can cost a duplicate or a lost event under a genuine race, which is the acceptable
 * failure for analytics and is why the server tolerates duplicates.
 */
export class TelemetryQueue {
  readonly path: string;
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = telemetryDir(dataDir);
    this.path = queuePath(dataDir);
  }

  /** Append one event. Evicts oldest-first if the append pushed the file past the cap. */
  append(event: QueuedEvent): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`);
    } catch (err) {
      log.debug('telemetry queue append failed', { error: String(err) });
      return;
    }
    this.evictIfOverCap();
  }

  /** Byte size of the queue file, or 0 when it does not exist. */
  sizeBytes(): number {
    try {
      return existsSync(this.path) ? statSync(this.path).size : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Every well-formed event on disk, oldest first.
   *
   * Malformed lines are dropped rather than repaired — a line that does not satisfy the
   * closed dictionary is a line we must not put on the wire, whatever wrote it.
   */
  readAll(): QueuedEvent[] {
    let raw: string;
    try {
      if (!existsSync(this.path)) return [];
      raw = readFileSync(this.path, 'utf-8');
    } catch (err) {
      log.debug('telemetry queue read failed', { error: String(err) });
      return [];
    }
    const out: QueuedEvent[] = [];
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isQueuedEvent(parsed)) out.push(parsed);
      } catch {
        // A torn or hand-edited line. Drop it and keep draining the rest.
      }
    }
    return out;
  }

  count(): number {
    return this.readAll().length;
  }

  /**
   * Replace the queue contents wholesale — used after a flush to keep exactly what was not
   * accepted. Written to a sibling temp file and renamed so a crash mid-write cannot leave a
   * half-line that the next read would silently drop.
   */
  replace(events: readonly QueuedEvent[]): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      if (events.length === 0) {
        if (existsSync(this.path)) rmSync(this.path, { force: true });
        return;
      }
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      renameSync(tmp, this.path);
    } catch (err) {
      log.debug('telemetry queue rewrite failed', { error: String(err) });
    }
  }

  /**
   * Drop oldest events until the file is under {@link QUEUE_EVICT_TARGET_BYTES}.
   *
   * @returns how many events were dropped. Cap eviction is one of the two sanctioned silent
   * drops (the other is a terminal send failure) — it is logged at debug and never surfaced.
   */
  evictIfOverCap(): number {
    if (this.sizeBytes() <= QUEUE_CAP_BYTES) return 0;
    const events = this.readAll();
    let bytes = events.reduce((n, e) => n + Buffer.byteLength(`${JSON.stringify(e)}\n`), 0);
    let firstKept = 0;
    while (firstKept < events.length && bytes > QUEUE_EVICT_TARGET_BYTES) {
      const entry = events[firstKept];
      if (entry === undefined) break;
      bytes -= Buffer.byteLength(`${JSON.stringify(entry)}\n`);
      firstKept += 1;
    }
    if (firstKept === 0) return 0;
    this.replace(events.slice(firstKept));
    log.debug('telemetry queue evicted oldest events at cap', { dropped: firstKept });
    return firstKept;
  }

  /**
   * Remove the retired day-files. Opportunistic: called on the flush path, never on append,
   * so a directory full of them costs nothing per event.
   */
  cleanLegacyDayFiles(): number {
    let removed = 0;
    try {
      if (!existsSync(this.dir)) return 0;
      for (const name of readdirSync(this.dir)) {
        if (!LEGACY_DAY_FILE.test(name)) continue;
        rmSync(join(this.dir, name), { force: true });
        removed += 1;
      }
    } catch (err) {
      log.debug('telemetry legacy day-file cleanup failed', { error: String(err) });
    }
    if (removed > 0) log.debug('removed retired telemetry day-files', { removed });
    return removed;
  }
}
