/**
 * The disk queue — one capped NDJSON file at `<dataDir>/telemetry/queue.ndjson`.
 *
 * `queue.ndjson` remains authoritative during a network drain. A drainer reads a snapshot
 * without moving it, then removes settled rows only if that snapshot is still the queue's
 * exact prefix. Concurrent eviction can therefore cause a duplicate, never data loss.
 *
 * Nothing here throws. Telemetry that can fail a host operation is worse than telemetry that
 * loses an event, so every filesystem error is swallowed and logged at debug.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../logger.js';
import { isValidEvent, type TelemetryEvent } from './events.js';

const log = createLogger('telemetry');

/** Hard cap on the live queue file. §5 pin 5. */
export const QUEUE_CAP_BYTES = 5 * 1024 * 1024;

/** Rewrites leave headroom so every append does not immediately rewrite again. */
export const QUEUE_EVICT_TARGET_BYTES = Math.floor(QUEUE_CAP_BYTES * 0.8);

const LEGACY_DAY_FILE = /^events-\d{8}\.ndjson$/;
const PENDING_FILE = /^queue\.pending-\d{13}-\d+-[0-9a-f]+\.ndjson$/;
const WRITE_LOCK_WAIT_MS = 250;
const INCOMPLETE_LOCK_GRACE_MS = 5_000;

/** A dictionary event plus the client-side timestamp it was queued at. */
export type QueuedEvent = TelemetryEvent & { ts: string };

export interface TelemetryDeliveryState {
  lastAttemptAtMs: number;
  lastBatchAtMs: number;
  retryNotBeforeMs: number;
}

const EMPTY_DELIVERY_STATE: Readonly<TelemetryDeliveryState> = Object.freeze({
  lastAttemptAtMs: 0,
  lastBatchAtMs: 0,
  retryNotBeforeMs: 0,
});

interface LockHandle {
  fd: number;
  raw: string;
}

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

function parseQueue(raw: string): QueuedEvent[] {
  const out: QueuedEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isQueuedEvent(parsed)) out.push(parsed);
    } catch {
      // A torn or hand-edited line is not representable on the wire.
    }
  }
  return out;
}

function serializedBytes(event: QueuedEvent): number {
  return Buffer.byteLength(`${JSON.stringify(event)}\n`);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One queue for one data directory. Every decision is made from disk. */
export class TelemetryQueue {
  readonly path: string;
  private readonly dir: string;
  private readonly legacyInFlightPath: string;
  private readonly writeLockPath: string;
  private readonly flushLockPath: string;
  private readonly deliveryStatePath: string;

  constructor(dataDir: string) {
    this.dir = telemetryDir(dataDir);
    this.path = queuePath(dataDir);
    this.legacyInFlightPath = join(this.dir, 'queue.inflight.ndjson');
    this.writeLockPath = join(this.dir, '.queue-write.lock');
    this.flushLockPath = join(this.dir, '.flush.lock');
    this.deliveryStatePath = join(this.dir, 'delivery-state.json');
  }

  /** Append without ever waiting on another process's rewrite lock. */
  append(event: QueuedEvent): boolean {
    const appended = this.withWriteLock(() => {
      this.reconcileTransientUnlocked();
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.reconcilePendingUnlocked();
      this.evictIfOverCapUnlocked();
      return true;
    }, false);
    if (appended === true) return true;
    return this.appendPending(event);
  }

  /** Byte size of the live queue file, or 0 when it does not exist. */
  sizeBytes(): number {
    try {
      const live = existsSync(this.path) ? statSync(this.path).size : 0;
      return live + this.pendingPaths().reduce((sum, path) => sum + statSync(path).size, 0);
    } catch {
      return 0;
    }
  }

  /** Every well-formed event in the live queue, oldest first. */
  readAll(): QueuedEvent[] {
    const reconciled = this.withWriteLock(() => {
      this.reconcileTransientUnlocked();
      this.evictIfOverCapUnlocked();
      return this.readPath(this.path);
    }, false);
    if (reconciled !== null) return reconciled;
    return this.capEvents([...this.readPath(this.path), ...this.readPending()]);
  }

  count(): number {
    return this.readAll().length;
  }

  /**
   * Read an immutable network snapshot while leaving the authoritative queue in place.
   * `null` means lock contention; `[]` means there was no valid work.
   */
  beginDrain(): QueuedEvent[] | null {
    return this.withWriteLock(() => {
      this.reconcileTransientUnlocked();
      this.evictIfOverCapUnlocked();
      return this.readPath(this.path);
    });
  }

  /**
   * Complete a drain without losing concurrent appends. If cap eviction changed the prefix,
   * leave the queue alone: duplicates are preferable to deleting a newer row.
   */
  finishDrain(snapshot: readonly QueuedEvent[], retained: readonly QueuedEvent[]): boolean {
    const result = this.withWriteLock(() => {
      this.reconcileTransientUnlocked();
      const current = this.readPath(this.path);
      const prefixStillPresent = current.length >= snapshot.length
        && snapshot.every((event, index) => JSON.stringify(current[index]) === JSON.stringify(event));
      if (prefixStillPresent) this.writeEventsUnlocked([...retained, ...current.slice(snapshot.length)]);
      this.reconcilePendingUnlocked();
      this.evictIfOverCapUnlocked();
      return true;
    });
    return result === true;
  }

  /** Legacy whole-file replacement. Serialized with appenders, primarily a test seam. */
  replace(events: readonly QueuedEvent[]): void {
    this.withWriteLock(() => this.writeEventsUnlocked(events));
  }

  /** Enforce the cap from raw physical bytes, including malformed bytes. */
  evictIfOverCap(): number {
    return this.withWriteLock(() => this.evictIfOverCapUnlocked()) ?? 0;
  }

  /** Only one process may own a network drain. A dead owner's PID makes the lease stale. */
  tryAcquireFlushLease(): (() => void) | null {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const handle = this.openLock(this.flushLockPath, false);
      if (handle === null) return null;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.releaseLock(this.flushLockPath, handle);
      };
    } catch (err) {
      log.debug('telemetry flush lease failed', { error: String(err) });
      return null;
    }
  }

  readDeliveryState(): TelemetryDeliveryState {
    try {
      if (!existsSync(this.deliveryStatePath)) return { ...EMPTY_DELIVERY_STATE };
      const parsed: unknown = JSON.parse(readFileSync(this.deliveryStatePath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') return { ...EMPTY_DELIVERY_STATE };
      const row = parsed as Record<string, unknown>;
      const number = (key: keyof TelemetryDeliveryState): number => {
        const value = row[key];
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
      };
      return {
        lastAttemptAtMs: number('lastAttemptAtMs'),
        lastBatchAtMs: number('lastBatchAtMs'),
        retryNotBeforeMs: number('retryNotBeforeMs'),
      };
    } catch {
      return { ...EMPTY_DELIVERY_STATE };
    }
  }

  updateDeliveryState(patch: Partial<TelemetryDeliveryState>): boolean {
    return this.withWriteLock(() => {
      const next = { ...this.readDeliveryState(), ...patch };
      const tmp = join(this.dir, `.delivery-state-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
      try {
        writeFileSync(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, this.deliveryStatePath);
        return true;
      } catch (err) {
        try { unlinkSync(tmp); } catch { /* best effort */ }
        throw err;
      }
    }) === true;
  }

  /** Remove retired day-files opportunistically on a flush path. */
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

  private readPath(path: string): QueuedEvent[] {
    try {
      if (!existsSync(path)) return [];
      return parseQueue(readFileSync(path, 'utf8'));
    } catch (err) {
      log.debug('telemetry queue read failed', { error: String(err) });
      return [];
    }
  }

  private appendPending(event: QueuedEvent): boolean {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const name = `queue.pending-${String(Date.now()).padStart(13, '0')}-${process.pid}-${randomBytes(6).toString('hex')}.ndjson`;
      writeFileSync(join(this.dir, name), `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.capPendingPhysicalBytes();
      return true;
    } catch (err) {
      log.debug('telemetry pending append failed', { error: String(err) });
      return false;
    }
  }

  private pendingPaths(): string[] {
    try {
      if (!existsSync(this.dir)) return [];
      return readdirSync(this.dir).filter((name) => PENDING_FILE.test(name)).sort().map((name) => join(this.dir, name));
    } catch {
      return [];
    }
  }

  private readPending(): QueuedEvent[] {
    return this.pendingPaths().flatMap((path) => this.readPath(path));
  }

  /**
   * Keep lock-contention fragments inside the queue's one physical budget.
   *
   * A fragment is only an atomic append fallback while another process owns the rewrite
   * lock; it is not a second queue. Normally the lock owner absorbs it immediately. If that
   * owner stalls, however, repeated one-shot processes must not be able to grow an uncapped
   * directory beside the capped live file. Cap eviction is the one permitted silent-drop
   * boundary, so discard the oldest transient fragments until live + fragments fits.
   * Reconciliation still orders every surviving fragment after the live queue.
   */
  private capPendingPhysicalBytes(): void {
    const paths = this.pendingPaths();
    let bytes = existsSync(this.path) ? statSync(this.path).size : 0;
    const sized = paths.map((path) => ({ path, bytes: statSync(path).size }));
    bytes += sized.reduce((sum, entry) => sum + entry.bytes, 0);
    let dropped = 0;
    for (const entry of sized) {
      if (bytes <= QUEUE_CAP_BYTES) break;
      rmSync(entry.path, { force: true });
      bytes -= entry.bytes;
      dropped += 1;
    }
    if (dropped > 0) log.debug('telemetry pending fragments compacted at physical cap', { dropped });
  }

  private reconcilePendingUnlocked(): void {
    const paths = this.pendingPaths();
    if (paths.length === 0) return;
    this.writeEventsUnlocked([...this.readPath(this.path), ...paths.flatMap((path) => this.readPath(path))]);
    for (const path of paths) rmSync(path, { force: true });
  }

  private reconcileTransientUnlocked(): void {
    // Recover a snapshot left by the previous implementation during an in-place upgrade.
    if (existsSync(this.legacyInFlightPath)) {
      this.writeEventsUnlocked([...this.readPath(this.legacyInFlightPath), ...this.readPath(this.path)]);
      rmSync(this.legacyInFlightPath, { force: true });
    }
    this.reconcilePendingUnlocked();
  }

  private capEvents(events: readonly QueuedEvent[]): QueuedEvent[] {
    let bytes = events.reduce((sum, event) => sum + serializedBytes(event), 0);
    if (bytes <= QUEUE_CAP_BYTES) return [...events];
    let firstKept = 0;
    while (firstKept < events.length && bytes > QUEUE_EVICT_TARGET_BYTES) {
      bytes -= serializedBytes(events[firstKept]!);
      firstKept += 1;
    }
    return events.slice(firstKept);
  }

  private writeEventsUnlocked(events: readonly QueuedEvent[]): void {
    const bytes = events.reduce((sum, event) => sum + serializedBytes(event), 0);
    const kept = bytes > QUEUE_CAP_BYTES ? this.capEvents(events) : [...events];
    if (kept.length === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    const tmp = join(this.dir, `.queue-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, kept.map((event) => JSON.stringify(event)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private evictIfOverCapUnlocked(): number {
    if (!existsSync(this.path) || statSync(this.path).size <= QUEUE_CAP_BYTES) return 0;
    const events = this.readPath(this.path);
    const before = events.length;
    this.writeEventsUnlocked(events);
    const after = this.readPath(this.path).length;
    const dropped = Math.max(0, before - after);
    log.debug('telemetry queue compacted at physical cap', { dropped });
    return dropped;
  }

  private withWriteLock<T>(fn: () => T, wait = true): T | null {
    let handle: LockHandle | null = null;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      handle = this.openLock(this.writeLockPath, wait);
      if (handle === null) {
        log.debug('telemetry queue write lock unavailable');
        return null;
      }
      return fn();
    } catch (err) {
      log.debug('telemetry queue mutation failed', { error: String(err) });
      return null;
    } finally {
      if (handle !== null) this.releaseLock(this.writeLockPath, handle);
    }
  }

  private openLock(path: string, wait: boolean): LockHandle | null {
    const deadline = Date.now() + (wait ? WRITE_LOCK_WAIT_MS : 0);
    while (true) {
      try {
        const fd = openSync(path, 'wx', 0o600);
        const raw = JSON.stringify({ pid: process.pid, token: randomBytes(12).toString('hex'), createdAtMs: Date.now() });
        try {
          writeFileSync(fd, raw);
          return { fd, raw };
        } catch (err) {
          try { closeSync(fd); } catch { /* best effort */ }
          this.unlinkIfOwned(path, raw);
          throw err;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          const raw = readFileSync(path, 'utf8');
          let parsed: unknown = null;
          try { parsed = JSON.parse(raw); } catch { /* incomplete publication */ }
          const row = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
          const owner = row !== null && Number.isInteger(row['pid']) ? row['pid'] as number : null;
          const ageMs = Date.now() - statSync(path).mtimeMs;
          // Empty/partial publication is live during a grace window; never interpret NaN as dead.
          if ((owner === null ? ageMs >= INCOMPLETE_LOCK_GRACE_MS : !processIsAlive(owner)) && this.unlinkIfOwned(path, raw)) {
            continue;
          }
        } catch {
          // The creator may not have written its PID yet. Treat it as live this round.
        }
        if (!wait || Date.now() >= deadline) return null;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
    }
  }

  private releaseLock(path: string, handle: LockHandle): void {
    try { closeSync(handle.fd); } catch { /* best effort */ }
    this.unlinkIfOwned(path, handle.raw);
  }

  private unlinkIfOwned(path: string, expectedRaw: string): boolean {
    try {
      const before = statSync(path);
      if (readFileSync(path, 'utf8') !== expectedRaw) return false;
      const after = statSync(path);
      if (before.dev !== after.dev || before.ino !== after.ino) return false;
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }
}
