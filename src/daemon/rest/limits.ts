import type { IncomingMessage } from 'node:http';

/**
 * Serve-mode resource discipline: body caps, per-route deadlines, concurrency
 * slots, and the param-clamp table. Everything here is transport policy, not
 * tool logic — the tool layer's own defaults/caps are untouched.
 */

const MiB = 1024 * 1024;
const DEFAULT_BODY_CAP = 1 * MiB;
const LARGE_BODY_CAP = 5 * MiB;
const LARGE_BODY_TOOLS = new Set(['diff', 'extract']);

/** Body cap in bytes for a tool. `WIGOLO_SERVE_MAX_BODY_BYTES` overrides the
 * base cap; diff/extract get the larger cap when no override is set. */
export function bodyCapFor(tool: string): number {
  const override = process.env.WIGOLO_SERVE_MAX_BODY_BYTES;
  if (override) {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return LARGE_BODY_TOOLS.has(tool) ? LARGE_BODY_CAP : DEFAULT_BODY_CAP;
}

const DEADLINES: Record<string, number> = {
  search: 60_000,
  cache: 60_000,
  diff: 60_000,
  find_similar: 60_000,
  fetch: 120_000,
  extract: 120_000,
  watch: 120_000,
  crawl: 300_000,
  research: 300_000,
  agent: 300_000,
};

/** Per-route response deadline in ms, scaled by `WIGOLO_SERVE_TIMEOUT_SCALE`. */
export function deadlineFor(tool: string): number {
  const base = DEADLINES[tool] ?? 120_000;
  const scaleRaw = process.env.WIGOLO_SERVE_TIMEOUT_SCALE;
  const scale = scaleRaw ? Number(scaleRaw) : 1;
  return Math.round(base * (Number.isFinite(scale) && scale > 0 ? scale : 1));
}

/** In-flight cap on /v1 + shim; `WIGOLO_SERVE_MAX_CONCURRENCY` overrides. */
export function maxConcurrency(): number {
  const override = process.env.WIGOLO_SERVE_MAX_CONCURRENCY;
  if (override) {
    const n = Number(override);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return 16;
}

export interface ClampSpec {
  tool: string;
  field: string;
  /** For scalar fields: the maximum value. For array fields: max item count. */
  max: number;
  kind: 'scalar' | 'array';
}

/**
 * Single source of truth for server-side param clamps, imported by both the
 * router (enforcement) and openapi.ts (bound injection) so the served bounds
 * can never drift from the enforced ones.
 */
export const CLAMP_TABLE: readonly ClampSpec[] = [
  { tool: 'crawl', field: 'max_pages', max: 200, kind: 'scalar' },
  { tool: 'crawl', field: 'max_depth', max: 5, kind: 'scalar' },
  { tool: 'agent', field: 'max_time_ms', max: 240_000, kind: 'scalar' },
  { tool: 'search', field: 'query', max: 10, kind: 'array' },
] as const;

export interface ClampViolation {
  field: string;
  max: number;
  kind: 'scalar' | 'array';
}

/**
 * Generic clamp check: compares body fields against the clamp table. Returns
 * the first violation or null. Array clamps only fire when the field is an
 * array (a string `query` is unbounded by this table).
 */
export function findClampViolation(tool: string, body: Record<string, unknown>): ClampViolation | null {
  for (const spec of CLAMP_TABLE) {
    if (spec.tool !== tool) continue;
    const value = body[spec.field];
    if (value === undefined || value === null) continue;
    if (spec.kind === 'scalar') {
      if (typeof value === 'number' && value > spec.max) {
        return { field: spec.field, max: spec.max, kind: 'scalar' };
      }
    } else {
      if (Array.isArray(value) && value.length > spec.max) {
        return { field: spec.field, max: spec.max, kind: 'array' };
      }
    }
  }
  return null;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the configured cap');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Read and JSON-parse a request body, destroying the stream if it exceeds
 * `capBytes` (→ BodyTooLargeError). An empty body parses to `{}`. A parse
 * failure rejects with a SyntaxError (router maps to 400 invalid_json).
 */
export function readJsonBodyCapped(req: IncomingMessage, capBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > capBytes) {
        // Stop buffering and reject; the caller writes a 413 on the still-open
        // response. We do NOT destroy the request socket — that would reset the
        // connection before the 413 reaches the client. Pausing drops us out of
        // flowing mode so we stop accumulating.
        req.pause();
        finish(() => reject(new BodyTooLargeError()));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish(() => {
        const text = Buffer.concat(chunks).toString('utf-8').trim();
        if (text === '') {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', (err) => finish(() => reject(err)));
  });
}

/** Simple counting semaphore for the in-flight cap. Acquired pre-dispatch,
 * released ONLY when the handler promise settles (never at 504). */
export class ConcurrencySlots {
  private inFlight = 0;
  constructor(private readonly cap: number) {}

  tryAcquire(): boolean {
    if (this.inFlight >= this.cap) return false;
    this.inFlight++;
    return true;
  }

  release(): void {
    if (this.inFlight > 0) this.inFlight--;
  }

  get active(): number {
    return this.inFlight;
  }
}
