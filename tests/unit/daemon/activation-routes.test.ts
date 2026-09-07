/**
 * The daemon's HTTP routes on an UNREGISTERED install (PX brief §0a.1, issue #336).
 *
 * WHAT THIS FILE USED TO PIN. PX2 put an activation check in `routeRequest`, above
 * both REST dispatchers, and every arm here asserted a structured 403 carrying the
 * `never_activated` line — for `/v1/{tool}`, for the firecrawl-compat family that
 * bypasses `dispatchTool`, and for `/v1/runs`. §0a.1 made the hard gate
 * Studio-only, so the check is gone and each of those arms is inverted.
 *
 * WHY THE COMPAT ARM IS STILL THE LOAD-BEARING ONE, JUST POINTING THE OTHER WAY.
 * `/compat/firecrawl/*` calls `handleFetch` / `handleSearch` / `handleCrawl`
 * directly and never passes through `rest/dispatch.ts`. A gate reintroduced in
 * `routeRequest` — the only seam above both — would be invisible to an arm that
 * only exercises `/v1/{tool}`, and equally invisible the other way round. Both
 * families are swept, and the assertion is "not 403, and no refusal text
 * anywhere in the body".
 *
 * The complement is unchanged and still asserted: `/health` is a liveness probe
 * and the discovery routes describe the surface, so they were open under PX2 and
 * are open now. Their arms exist to prove the sweep above is about the gate
 * rather than about the whole server being broken.
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

/** No refusal line, and no `not_activated` code, anywhere in a response. */
function expectUngated(r: { status: number; body: unknown }, what: string): void {
  const whole = JSON.stringify(r.body);
  expect({ what, status: r.status }).not.toEqual({ what, status: 403 });
  expect(whole, `${what} carried the not_activated code`).not.toContain('not_activated');
  for (const line of Object.values(ACTIVATION_REFUSALS)) {
    expect(whole, `${what} rendered a refusal line`).not.toContain(line);
  }
}

describe('daemon routes — unregistered install', () => {
  beforeEach(() => {
    // The temp data dir carries no account state, so the shipped disk-backed
    // checker is the unregistered condition. Dropping any checker a sibling
    // file installed is what makes that true rather than assumed.
    setActivationChecker(null);
  });

  it('lets POST /v1/{tool} through to the tool with no account', async () => {
    // Reaching the tool's OWN answer — not a 403 — is the whole of §0a.1 on this
    // transport. Whether that answer is a result or a validation error is the
    // tool's business; what matters is that the route stopped arbitrating.
    const r = await request('POST', '/v1/search', {});
    expectUngated(r, 'POST /v1/search');
  });

  it('lets the firecrawl-compat family through — the handlers that bypass dispatchTool', async () => {
    // The arm a gate reintroduced in `routeRequest` would fail even if `/v1` were
    // somehow left alone: /compat reaches handleScrape/handleSearch directly.
    const r = await request('POST', '/compat/firecrawl/v1/scrape', {});
    expectUngated(r, 'POST /compat/firecrawl/v1/scrape');
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

  it('answers /v1/runs as an unknown path, not as a refusal', async () => {
    // Under PX2 this path returned the activation 403, which made "the run surface
    // left core" and "you have no account" indistinguishable to a client. With the
    // gate gone it is simply a route that does not exist, which is the truth.
    const r = await request('POST', '/v1/runs', {});
    expectUngated(r, 'POST /v1/runs');
  });
});

describe('daemon routes — registered install', () => {
  let restore: () => void;
  beforeEach(() => { restore = installActivated(); });
  afterEach(() => { restore(); });

  it('answers a tool route IDENTICALLY to the unregistered one', async () => {
    // THE OUTSIDE SIGNAL. On its own, "the unregistered call was not a 403" could
    // mean the route is broken for everybody. Running the identical request with a
    // real activated fixture and getting the same status is what makes the arms
    // above a statement about the gate: registration changed nothing here, which
    // is exactly §0a.1's claim.
    const registered = await request('POST', '/v1/search', {});
    expect(registered.status).not.toBe(403);
    expect(JSON.stringify(registered.body)).not.toContain('not_activated');

    setActivationChecker(null);
    const unregistered = await request('POST', '/v1/search', {});
    expect(unregistered.status).toBe(registered.status);
  });
});
