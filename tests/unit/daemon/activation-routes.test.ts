/**
 * The activation gate on the daemon's HTTP routes (PX2 mini-spec §3, issue #222).
 *
 * WHY THE CHECK IS IN `routeRequest` AND NOT IN `rest/dispatch.ts`. The
 * firecrawl-compat handlers do not go through `dispatchTool` — they call
 * `handleFetch` / `handleSearch` / `handleCrawl` directly. A gate inside dispatch
 * would therefore cover `/v1/{tool}` and leave `/compat/firecrawl/*` wide open,
 * with nothing in the diff to show for it. `routeRequest` is the one seam above
 * both, which is why the compat arm below is the load-bearing one: it is the
 * path a check placed one layer lower would silently miss.
 *
 * The complement matters just as much. `/health` is a liveness probe, and
 * `/openapi.json`, `/v1/openapi.json` and `/v1/tools` execute no tool — gating
 * them would make an un-activated install unable to describe itself, which is the
 * REST equivalent of refusing `tools/list`. `/v1/runs*` was in that column for the
 * same reason until the run surface left core with the companion extraction.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonHttpServer } from '../../../src/daemon/http-server.js';
import { resetConfig } from '../../../src/config.js';
import { ACTIVATION_REFUSALS } from '../../../src/account/gate.js';
import { setActivationChecker } from '../../../src/server/activation.js';
import { installActivated } from '../server/activation-fixture.js';

let daemon: DaemonHttpServer;
let port: number;
let dataDir: string;

function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          Connection: 'close',
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* leave as text */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-activation-rest-'));
  process.env.WIGOLO_DATA_DIR = dataDir;
  process.env.WIGOLO_FIRECRAWL_COMPAT = '1';
  delete process.env.WIGOLO_API_TOKEN;
  delete process.env.WIGOLO_API_TOKEN_FILE;
  resetConfig();
  daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
  port = parseInt(new URL(await daemon.start()).port, 10);
}, 30000);

afterAll(async () => {
  await daemon?.stop();
  delete process.env.WIGOLO_DATA_DIR;
  delete process.env.WIGOLO_FIRECRAWL_COMPAT;
  resetConfig();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 30000);

describe('daemon routes — un-activated install', () => {
  beforeEach(() => {
    // The temp data dir carries no account state, so the shipped disk-backed
    // checker is the un-activated condition. Dropping any checker a sibling
    // file installed is what makes that true rather than assumed.
    setActivationChecker(null);
  });

  it('refuses POST /v1/{tool} with the pinned line and a structured 403', async () => {
    const r = await request('POST', '/v1/search', { query: 'anything' });
    expect(r.status).toBe(403);
    const body = r.body as { ok: boolean; error: string; error_reason: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_activated');
    expect(body.error_reason).toBe(ACTIVATION_REFUSALS.never_activated);
  });

  it('refuses the firecrawl-compat family — the handlers that bypass dispatchTool', async () => {
    // This is the arm a gate inside `rest/dispatch.ts` would fail: /compat
    // reaches handleScrape/handleSearch directly and never passes through it.
    const r = await request('POST', '/compat/firecrawl/v1/scrape', {
      url: 'https://example.invalid/',
    });
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toBe('not_activated');
  });

  it('leaves /health open — a liveness probe exposes no tool surface', async () => {
    const r = await request('GET', '/health');
    expect(r.status).toBe(200);
  });

  it('leaves the discovery routes open — REST’s initialize and tools/list', async () => {
    for (const path of ['/openapi.json', '/v1/openapi.json', '/v1/tools']) {
      const r = await request('GET', path);
      expect({ path, status: r.status }).toEqual({ path, status: 200 });
    }
  });

  it('refuses /v1/runs like any other unknown path — the run surface is not core\'s any more', async () => {
    // It used to be the second ungated group, exempt because the run store reached no tool handler.
    // The surface left core with the run layer, so the exemption left with it: what a client gets
    // is the ordinary un-activated refusal, not a route that half-answers.
    const r = await request('POST', '/v1/runs', {});
    expect(r.status).toBe(403);
  });
});

describe('daemon routes — activated install', () => {
  let restore: () => void;
  beforeEach(() => { restore = installActivated(); });
  afterEach(() => { restore(); });

  it('lets a tool route through to its own validation instead of the refusal', async () => {
    // The proof that the 403s above are the GATE and not the route being broken:
    // the identical request now reaches the tool's input validation.
    const r = await request('POST', '/v1/search', {});
    expect(r.status).not.toBe(403);
    expect(JSON.stringify(r.body)).not.toContain(ACTIVATION_REFUSALS.never_activated);
  });
});
