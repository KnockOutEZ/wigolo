import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalClient } from '../src/local.js';
import { scrubWigoloEnv } from './helpers.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('no port')));
      }
    });
  });
}

/** Stand up a fake daemon: /health returns `healthStatus`, /v1/tools `toolsStatus`. */
function fakeDaemon(port: number, healthStatus: number, toolsStatus: number): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(healthStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: healthStatus === 200 ? 'ok' : 'down' }));
        return;
      }
      if (req.url === '/v1/tools') {
        res.writeHead(toolsStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(toolsStatus === 200 ? { tools: [] } : { error: 'x' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

const servers: Server[] = [];
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  scrubWigoloEnv();
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => {});
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

describe('reuse of an already-running daemon', () => {
  it('reuses a healthy daemon (owned=false) without touching it on close', async () => {
    const port = await freePort();
    const srv = await fakeDaemon(port, 200, 200);
    servers.push(srv);
    const local = await createLocalClient({ port });
    expect(local.owned).toBe(false);
    await local.close(); // no-op
    // Still reachable after close.
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });
});

describe('stale / mismatched daemon detection', () => {
  it('throws "predates the REST API" when /v1/tools 404s', async () => {
    const port = await freePort();
    const srv = await fakeDaemon(port, 200, 404);
    servers.push(srv);
    await expect(createLocalClient({ port })).rejects.toThrow(/predates the REST API/i);
  });

  it('throws a token-mismatch error when /v1/tools 401s', async () => {
    const port = await freePort();
    const srv = await fakeDaemon(port, 200, 401);
    servers.push(srv);
    await expect(createLocalClient({ port, token: 'wrong' })).rejects.toThrow(
      /requires a bearer token/i,
    );
  });

  it('does not reuse a 503-down daemon', async () => {
    const port = await freePort();
    const srv = await fakeDaemon(port, 503, 200);
    servers.push(srv);
    await expect(createLocalClient({ port })).rejects.toThrow(/unhealthy/i);
  });
});

describe('WIGOLO_CLI command resolution', () => {
  it('spawns a JSON-array WIGOLO_CLI and reuses the port it binds', async () => {
    const port = await freePort();
    const dir = await mkdtemp(join(tmpdir(), 'wigolo-sdk-fake-'));
    const script = join(dir, 'fake-serve.mjs');
    // A minimal daemon that ignores the serve args except --port, serving
    // /health + /v1/tools with 200. Proves argv-array parsing end-to-end.
    await writeFile(
      script,
      `import { createServer } from 'node:http';
const args = process.argv.slice(2);
const i = args.indexOf('--port');
const port = Number(args[i + 1]);
createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end(JSON.stringify({status:'ok'})); return; }
  if (req.url === '/v1/tools') { res.writeHead(200); res.end(JSON.stringify({tools:[]})); return; }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
`,
    );
    process.env.WIGOLO_CLI = JSON.stringify([process.execPath, script]);
    const local = await createLocalClient({ port });
    closers.push(() => local.close());
    expect(local.owned).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    await local.close();
    // After close the owned child is gone.
    await new Promise((r) => setTimeout(r, 300));
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toBeTruthy();
  });

  it('treats a non-array WIGOLO_CLI with spaces as ONE executable path (ENOENT)', async () => {
    const port = await freePort();
    // A path that does not exist, containing a space — must NOT be split.
    process.env.WIGOLO_CLI = '/no/such dir/wigolo-bin';
    await expect(createLocalClient({ port })).rejects.toThrow(
      /could not be launched|REST-capable wigolo|WIGOLO_CLI/i,
    );
  });

  it('maps a spawn ENOENT to an actionable install/WIGOLO_CLI hint', async () => {
    const port = await freePort();
    process.env.WIGOLO_CLI = JSON.stringify(['/definitely/not/here/wigolo']);
    const err = await createLocalClient({ port }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/could not be launched|WIGOLO_CLI/i);
  });

  it('spawns the explicit command option (not WIGOLO_CLI/PATH) and reuses its port', async () => {
    const port = await freePort();
    const dir = await mkdtemp(join(tmpdir(), 'wigolo-sdk-fake-opt-'));
    const script = join(dir, 'fake-serve.mjs');
    await writeFile(
      script,
      `import { createServer } from 'node:http';
const args = process.argv.slice(2);
const i = args.indexOf('--port');
const port = Number(args[i + 1]);
createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end(JSON.stringify({status:'ok'})); return; }
  if (req.url === '/v1/tools') { res.writeHead(200); res.end(JSON.stringify({tools:[]})); return; }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
`,
    );
    // Point WIGOLO_CLI at a bogus path to prove the option WINS over the env.
    process.env.WIGOLO_CLI = JSON.stringify(['/definitely/not/here/wigolo']);
    const local = await createLocalClient({ port, command: [process.execPath, script] });
    closers.push(() => local.close());
    expect(local.owned).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    await local.close();
    await new Promise((r) => setTimeout(r, 300));
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toBeTruthy();
  });
});

describe('port validation', () => {
  it('rejects a non-integer WIGOLO_LOCAL_PORT with trailing garbage', async () => {
    process.env.WIGOLO_LOCAL_PORT = '3333;x';
    await expect(createLocalClient()).rejects.toThrow(/WIGOLO_LOCAL_PORT is not a valid port/i);
  });

  it('rejects an out-of-range port option', async () => {
    await expect(createLocalClient({ port: 70000 })).rejects.toThrow(/out of range/i);
    await expect(createLocalClient({ port: 0 })).rejects.toThrow(/out of range/i);
  });
});

describe('stderr token redaction', () => {
  it('redacts the resolved bearer token from a child-exit error tail', async () => {
    const port = await freePort();
    const dir = await mkdtemp(join(tmpdir(), 'wigolo-sdk-fake-tok-'));
    const script = join(dir, 'fake-exit.mjs');
    // A child that echoes its token to stderr then exits non-zero. Proves the
    // token never reaches the surfaced error message.
    await writeFile(
      script,
      `process.stderr.write('boot with token=' + (process.env.WIGOLO_API_TOKEN || '') + '\\n');
process.exit(7);
`,
    );
    process.env.WIGOLO_CLI = JSON.stringify([process.execPath, script]);
    const secret = 'super-secret-bearer-xyz';
    const err = (await createLocalClient({ port, token: secret }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(secret);
    expect(err.message).toContain('[redacted]');
  });
});
