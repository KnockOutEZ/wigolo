import { describe, it, expect } from 'vitest';
import {
  MAX_BODY_BYTES,
  MAX_EVENTS_PER_BATCH,
  buildEnvelope,
  chunkEvents,
  clientInfo,
} from '../../../src/telemetry/envelope.js';
import type { QueuedEvent } from '../../../src/telemetry/queue.js';

const CLIENT = { version: '0.3.0', os: 'darwin', arch: 'arm64' };

function event(i: number): QueuedEvent {
  return {
    name: 'tool.run',
    props: { tool: 'search', surface: 'mcp', ok: true, duration_bucket: 'lt_2s' },
    ts: new Date(Date.UTC(2026, 8, 2, 0, 0, 0, i % 1000)).toISOString(),
  };
}

describe('envelope', () => {
  it('carries version, os and arch once per batch, never per event', () => {
    const envelope = buildEnvelope([event(1), event(2)], CLIENT);
    expect(envelope.client).toEqual(CLIENT);
    for (const e of envelope.events) {
      expect(Object.keys(e.props)).not.toContain('version');
      expect(Object.keys(e.props)).not.toContain('os');
    }
  });

  it('stamps no account id — the server derives it from the Bearer token', () => {
    const envelope = buildEnvelope([event(1)], CLIENT);
    expect(Object.keys(envelope)).toEqual(['client', 'events']);
    expect(JSON.stringify(envelope)).not.toContain('account');
  });

  it('reports a real platform and arch by default', () => {
    const info = clientInfo();
    expect(info.os).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('chunkEvents', () => {
  it('returns nothing for an empty drain', () => {
    expect(chunkEvents([], CLIENT)).toEqual([]);
  });

  it('keeps a small drain in one batch', () => {
    expect(chunkEvents([event(1), event(2)], CLIENT)).toHaveLength(1);
  });

  it('never exceeds the server event cap', () => {
    const events = Array.from({ length: 1_201 }, (_, i) => event(i));
    const chunks = chunkEvents(events, CLIENT);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_EVENTS_PER_BATCH);
    expect(chunks.flat()).toHaveLength(events.length);
  });

  it('never exceeds the server body cap, even when the event cap alone would allow it', () => {
    // 500 events of this size compose well past 1 MiB — the exact case PX1 §7 flags, and the
    // reason counting events is not enough.
    const fat: QueuedEvent = {
      name: 'fetch.blocked',
      props: { domain: `${'a'.repeat(200)}.example.com`, signal: 'challenge' },
      ts: '2026-09-02T00:00:00.000Z',
    };
    const events = Array.from({ length: 20_000 }, () => fat);
    const chunks = chunkEvents(events, CLIENT);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_EVENTS_PER_BATCH);
      expect(Buffer.byteLength(JSON.stringify(buildEnvelope(chunk, CLIENT)))).toBeLessThanOrEqual(MAX_BODY_BYTES);
    }
    expect(chunks.flat()).toHaveLength(events.length);
  });

  it('preserves order across chunks', () => {
    const events = Array.from({ length: 1_100 }, (_, i) => ({ ...event(i), ts: `2026-09-02T00:00:00.${String(i).padStart(3, '0')}Z` }));
    expect(chunkEvents(events, CLIENT).flat().map((e) => e.ts)).toEqual(events.map((e) => e.ts));
  });

  it('emits an oversized single event as its own chunk rather than dropping it here', () => {
    // Dropping belongs to the send path's 413 bisect, which can tell "too big" from
    // "server is down". Chunking must not decide that on its own.
    const huge: QueuedEvent = {
      name: 'fetch.blocked',
      props: { domain: `${'b'.repeat(2 * 1024 * 1024)}.example.com`, signal: 'challenge' },
      ts: '2026-09-02T00:00:00.000Z',
    };
    const chunks = chunkEvents([huge, event(1)], CLIENT);
    expect(chunks[0]).toEqual([huge]);
    expect(chunks[1]).toEqual([event(1)]);
  });
});
