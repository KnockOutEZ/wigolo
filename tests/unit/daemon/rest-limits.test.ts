import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  bodyCapFor,
  deadlineFor,
  maxConcurrency,
  CLAMP_TABLE,
  findClampViolation,
  readJsonBodyCapped,
  BodyTooLargeError,
  ConcurrencySlots,
} from '../../../src/daemon/rest/limits.js';

const origEnv = { ...process.env };
afterEach(() => {
  process.env = { ...origEnv };
  delete process.env.WIGOLO_SERVE_MAX_BODY_BYTES;
  delete process.env.WIGOLO_SERVE_TIMEOUT_SCALE;
  delete process.env.WIGOLO_SERVE_MAX_CONCURRENCY;
});

describe('bodyCapFor', () => {
  it('default 1 MiB', () => {
    expect(bodyCapFor('search')).toBe(1024 * 1024);
  });
  it('diff + extract get 5 MiB', () => {
    expect(bodyCapFor('diff')).toBe(5 * 1024 * 1024);
    expect(bodyCapFor('extract')).toBe(5 * 1024 * 1024);
  });
  it('WIGOLO_SERVE_MAX_BODY_BYTES overrides the default cap', () => {
    process.env.WIGOLO_SERVE_MAX_BODY_BYTES = '2048';
    expect(bodyCapFor('search')).toBe(2048);
  });
});

describe('deadlineFor', () => {
  it('fast tools = 60s', () => {
    expect(deadlineFor('search')).toBe(60_000);
    expect(deadlineFor('cache')).toBe(60_000);
    expect(deadlineFor('diff')).toBe(60_000);
    expect(deadlineFor('find_similar')).toBe(60_000);
  });
  it('medium tools = 120s', () => {
    expect(deadlineFor('fetch')).toBe(120_000);
    expect(deadlineFor('extract')).toBe(120_000);
    expect(deadlineFor('watch')).toBe(120_000);
  });
  it('slow tools = 300s', () => {
    expect(deadlineFor('crawl')).toBe(300_000);
    expect(deadlineFor('research')).toBe(300_000);
    expect(deadlineFor('agent')).toBe(300_000);
  });
  it('WIGOLO_SERVE_TIMEOUT_SCALE multiplies', () => {
    process.env.WIGOLO_SERVE_TIMEOUT_SCALE = '2';
    expect(deadlineFor('search')).toBe(120_000);
  });
});

describe('maxConcurrency', () => {
  it('defaults to 16', () => {
    expect(maxConcurrency()).toBe(16);
  });
  it('WIGOLO_SERVE_MAX_CONCURRENCY overrides', () => {
    process.env.WIGOLO_SERVE_MAX_CONCURRENCY = '4';
    expect(maxConcurrency()).toBe(4);
  });
});

describe('CLAMP_TABLE + findClampViolation', () => {
  it('has the documented clamps', () => {
    const byField = new Map(CLAMP_TABLE.map((c) => [`${c.tool}.${c.field}`, c.max]));
    expect(byField.get('crawl.max_pages')).toBe(200);
    expect(byField.get('crawl.max_depth')).toBe(5);
    expect(byField.get('agent.max_time_ms')).toBe(240_000);
    expect(byField.get('search.query')).toBe(10);
  });

  it('over-cap scalar → violation with cap in hint', () => {
    const v = findClampViolation('crawl', { url: 'https://x.com', max_pages: 500 });
    expect(v).not.toBeNull();
    expect(v!.field).toBe('max_pages');
    expect(v!.max).toBe(200);
  });

  it('boundary value passes', () => {
    expect(findClampViolation('crawl', { url: 'https://x.com', max_pages: 200 })).toBeNull();
  });

  it('search query array over 10 → violation (maxItems semantics)', () => {
    const v = findClampViolation('search', { query: Array(11).fill('q') });
    expect(v).not.toBeNull();
    expect(v!.field).toBe('query');
  });

  it('search query array of 10 passes; string query passes', () => {
    expect(findClampViolation('search', { query: Array(10).fill('q') })).toBeNull();
    expect(findClampViolation('search', { query: 'single' })).toBeNull();
  });

  it('unrelated tool with no clamps → null', () => {
    expect(findClampViolation('cache', { query: 'x' })).toBeNull();
  });
});

function mkReq(chunks: Buffer[]): IncomingMessage {
  const pt = new PassThrough();
  const req = pt as unknown as IncomingMessage;
  process.nextTick(() => {
    for (const c of chunks) pt.write(c);
    pt.end();
  });
  return req;
}

describe('readJsonBodyCapped', () => {
  it('parses JSON under the cap', async () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const parsed = await readJsonBodyCapped(mkReq([body]), 1024);
    expect(parsed).toEqual({ a: 1 });
  });

  it('throws BodyTooLargeError when the stream exceeds the cap', async () => {
    const big = Buffer.alloc(2048, 0x61);
    await expect(readJsonBodyCapped(mkReq([big]), 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('empty body → {} (treated as no fields)', async () => {
    const parsed = await readJsonBodyCapped(mkReq([Buffer.from('')]), 1024);
    expect(parsed).toEqual({});
  });
});

describe('ConcurrencySlots', () => {
  it('acquires up to the cap then refuses', () => {
    const slots = new ConcurrencySlots(2);
    expect(slots.tryAcquire()).toBe(true);
    expect(slots.tryAcquire()).toBe(true);
    expect(slots.tryAcquire()).toBe(false);
  });
  it('release frees a slot', () => {
    const slots = new ConcurrencySlots(1);
    expect(slots.tryAcquire()).toBe(true);
    expect(slots.tryAcquire()).toBe(false);
    slots.release();
    expect(slots.tryAcquire()).toBe(true);
  });
  it('release is idempotent-safe (never goes negative)', () => {
    const slots = new ConcurrencySlots(1);
    slots.release();
    slots.release();
    expect(slots.tryAcquire()).toBe(true);
    expect(slots.tryAcquire()).toBe(false);
  });
});
