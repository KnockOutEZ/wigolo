import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QUEUE_CAP_BYTES,
  QUEUE_EVICT_TARGET_BYTES,
  TelemetryQueue,
  queuePath,
  telemetryDir,
  type QueuedEvent,
} from '../../../src/telemetry/queue.js';
import type { ToolName } from '../../../src/telemetry/events.js';

let dataDir: string;

function event(n: number): QueuedEvent {
  return {
    name: 'tool.run',
    props: { tool: 'search', surface: 'mcp', ok: true, duration_bucket: 'lt_2s' },
    ts: new Date(Date.UTC(2026, 8, 2, 0, 0, n % 60)).toISOString(),
  };
}

/** A marker that survives a round trip, so eviction order is checkable. */
function marked(tool: ToolName, ts: string): QueuedEvent {
  return { name: 'tool.run', props: { tool, surface: 'mcp', ok: true, duration_bucket: 'lt_2s' }, ts };
}

describe('TelemetryQueue', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-telemetry-queue-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes one NDJSON line per event at <dataDir>/telemetry/queue.ndjson', () => {
    const q = new TelemetryQueue(dataDir);
    expect(q.path).toBe(join(dataDir, 'telemetry', 'queue.ndjson'));
    q.append(event(1));
    q.append(event(2));
    const lines = readFileSync(q.path, 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ name: 'tool.run' });
    expect(q.count()).toBe(2);
  });

  it('reads back nothing when the queue file does not exist', () => {
    const q = new TelemetryQueue(dataDir);
    expect(q.readAll()).toEqual([]);
    expect(q.sizeBytes()).toBe(0);
  });

  it('drops a malformed or non-dictionary line instead of putting it on the wire', () => {
    const q = new TelemetryQueue(dataDir);
    mkdirSync(telemetryDir(dataDir), { recursive: true });
    writeFileSync(
      q.path,
      [
        JSON.stringify(event(1)),
        '{ this is not json',
        // Well-formed JSON, but the props are not the declared shape.
        JSON.stringify({ name: 'tool.run', props: { query: 'leak me' }, ts: '2026-09-02T00:00:00.000Z' }),
        // Declared shape, but no timestamp.
        JSON.stringify({ name: 'daemon.uptime', props: { bucket: 'lt_1h' } }),
        JSON.stringify(event(2)),
      ].join('\n') + '\n',
    );
    expect(q.readAll()).toHaveLength(2);
  });

  it('enforces the physical 5 MiB cap even when every byte is malformed', () => {
    const q = new TelemetryQueue(dataDir);
    mkdirSync(telemetryDir(dataDir), { recursive: true });
    writeFileSync(q.path, 'x'.repeat(QUEUE_CAP_BYTES + 1));
    expect(statSync(q.path).size).toBeGreaterThan(QUEUE_CAP_BYTES);

    q.evictIfOverCap();

    expect(q.sizeBytes()).toBeLessThanOrEqual(QUEUE_CAP_BYTES);
    expect(q.readAll()).toEqual([]);
  });

  it('evicts oldest-first when an append pushes the file past the cap', () => {
    const q = new TelemetryQueue(dataDir);
    mkdirSync(telemetryDir(dataDir), { recursive: true });

    // Fill just past the cap by writing the file directly — appending ~47k events one at a
    // time would measure the loop, not the eviction.
    const filler = marked('crawl', '2026-01-01T00:00:00.000Z');
    const line = JSON.stringify(filler) + '\n';
    const needed = Math.ceil((QUEUE_CAP_BYTES + 1024) / Buffer.byteLength(line));
    writeFileSync(q.path, line.repeat(needed));
    expect(statSync(q.path).size).toBeGreaterThan(QUEUE_CAP_BYTES);

    const newest = marked('watch', '2026-12-31T23:59:59.000Z');
    q.append(newest);

    const after = q.readAll();
    expect(statSync(q.path).size).toBeLessThanOrEqual(QUEUE_EVICT_TARGET_BYTES);
    expect(after.length).toBeLessThan(needed);
    // The newest event survived and is still last; the drop came off the front.
    expect(after.at(-1)).toMatchObject({ props: { tool: 'watch' } });
    expect(after.every((e, i) => i === after.length - 1 || (e.name === 'tool.run' && e.props.tool === 'crawl'))).toBe(true);
  });

  it('leaves a queue under the cap completely alone', () => {
    const q = new TelemetryQueue(dataDir);
    q.append(event(1));
    const before = readFileSync(q.path, 'utf-8');
    expect(q.evictIfOverCap()).toBe(0);
    expect(readFileSync(q.path, 'utf-8')).toBe(before);
  });

  it('replaces the queue atomically and removes the file when nothing is left', () => {
    const q = new TelemetryQueue(dataDir);
    q.append(event(1));
    q.append(event(2));
    q.replace([event(3)]);
    expect(q.readAll()).toHaveLength(1);
    expect(existsSync(`${q.path}.tmp`)).toBe(false);
    q.replace([]);
    expect(existsSync(q.path)).toBe(false);
    expect(q.readAll()).toEqual([]);
  });

  it('merges appends from another instance made while a drain snapshot is in flight', () => {
    const drainer = new TelemetryQueue(dataDir);
    const appender = new TelemetryQueue(dataDir);
    drainer.append(marked('search', '2026-01-01T00:00:00.000Z'));

    const snapshot = drainer.beginDrain();
    expect(snapshot).toMatchObject([{ props: { tool: 'search' } }]);
    appender.append(marked('fetch', '2026-01-02T00:00:00.000Z'));
    expect(drainer.finishDrain(snapshot ?? [], [])).toBe(true);

    expect(drainer.readAll()).toMatchObject([{ props: { tool: 'fetch' } }]);
  });

  it('does not block or drop an append while another process owns the write lock', () => {
    const q = new TelemetryQueue(dataDir);
    const dir = telemetryDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, '.queue-write.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live-owner', createdAtMs: Date.now() }));

    const started = performance.now();
    expect(q.append(event(1))).toBe(true);
    expect(performance.now() - started).toBeLessThan(100);
    expect(existsSync(lock)).toBe(true);

    unlinkSync(lock);
    expect(q.readAll()).toEqual([event(1)]);
  });

  it('treats an incompletely published live lock as owned instead of unlinking it', () => {
    const q = new TelemetryQueue(dataDir);
    const dir = telemetryDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, '.queue-write.lock');
    writeFileSync(lock, '');

    expect(q.append(event(1))).toBe(true);
    expect(existsSync(lock)).toBe(true);
    unlinkSync(lock);
    expect(q.readAll()).toEqual([event(1)]);
  });

  it('keeps one global oldest-first cap while a network snapshot is in flight', () => {
    const q = new TelemetryQueue(dataDir);
    mkdirSync(telemetryDir(dataDir), { recursive: true });
    const oldest = marked('crawl', '2026-01-01T00:00:00.000Z');
    const oldestLine = `${JSON.stringify(oldest)}\n`;
    writeFileSync(q.path, oldestLine.repeat(Math.ceil(QUEUE_CAP_BYTES / Buffer.byteLength(oldestLine))));
    q.evictIfOverCap();
    const snapshot = q.beginDrain();
    expect(snapshot).not.toBeNull();

    const newest = marked('watch', '2026-12-31T23:59:59.000Z');
    const newestLine = `${JSON.stringify(newest)}\n`;
    appendFileSync(q.path, newestLine.repeat(Math.ceil(QUEUE_CAP_BYTES / Buffer.byteLength(newestLine))));
    q.evictIfOverCap();
    const beforeFinish = q.readAll();

    expect(q.finishDrain(snapshot ?? [], snapshot ?? [])).toBe(true);
    expect(q.sizeBytes()).toBeLessThanOrEqual(QUEUE_EVICT_TARGET_BYTES);
    expect(q.readAll()).toEqual(beforeFinish);
    expect(q.readAll().at(-1)).toEqual(newest);
    expect(existsSync(join(telemetryDir(dataDir), 'queue.inflight.ndjson'))).toBe(false);
  });

  it('recovers a snapshot left behind by a crashed drainer before the next drain', () => {
    const first = new TelemetryQueue(dataDir);
    first.append(marked('search', '2026-01-01T00:00:00.000Z'));
    expect(first.beginDrain()).toHaveLength(1);
    new TelemetryQueue(dataDir).append(marked('fetch', '2026-01-02T00:00:00.000Z'));

    const recovered = new TelemetryQueue(dataDir).beginDrain();
    expect(recovered).toMatchObject([
      { props: { tool: 'search' } },
      { props: { tool: 'fetch' } },
    ]);
  });

  it('cleans the retired day-files and touches nothing else', () => {
    const q = new TelemetryQueue(dataDir);
    const dir = telemetryDir(dataDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events-20260101.ndjson'), '{"legacy":true}\n');
    writeFileSync(join(dir, 'events-20260102.ndjson'), '{"legacy":true}\n');
    writeFileSync(join(dir, 'events-notadate.ndjson'), 'keep me\n');
    q.append(event(1));

    expect(q.cleanLegacyDayFiles()).toBe(2);
    expect(existsSync(join(dir, 'events-20260101.ndjson'))).toBe(false);
    expect(existsSync(join(dir, 'events-notadate.ndjson'))).toBe(true);
    expect(existsSync(q.path)).toBe(true);
    expect(q.readAll()).toHaveLength(1);
  });

  it('never throws when the data directory cannot be written', () => {
    // A path whose parent is a FILE — mkdir and append both fail, and neither may escape.
    const blocker = join(dataDir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const q = new TelemetryQueue(join(blocker, 'nested'));
    expect(() => q.append(event(1))).not.toThrow();
    expect(q.readAll()).toEqual([]);
    expect(q.sizeBytes()).toBe(0);
    expect(() => q.replace([event(1)])).not.toThrow();
    expect(q.cleanLegacyDayFiles()).toBe(0);
  });

  it('pins the cap and its eviction low-water mark', () => {
    expect(QUEUE_CAP_BYTES).toBe(5 * 1024 * 1024);
    expect(QUEUE_EVICT_TARGET_BYTES).toBeLessThan(QUEUE_CAP_BYTES);
  });

  it('exposes the queue path helper the rest of the module builds on', () => {
    expect(queuePath('/tmp/x')).toBe(join('/tmp/x', 'telemetry', 'queue.ndjson'));
  });
});
