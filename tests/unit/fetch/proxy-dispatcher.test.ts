import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import {
  hasProxyDispatcher,
  installProxyDispatcher,
  resetProxyDispatcher,
} from '../../../src/fetch/proxy-dispatcher.js';
import { httpFetch } from '../../../src/fetch/http-client.js';

// The search engines and the HTTP client call the global `fetch` without a dispatcher, so behind
// a proxy they went direct: every non-Bing engine timed out and page fetches returned empty
// content. These tests pin that a configured proxy is installed once and that the global `fetch`
// and `httpFetch` both then go through it.
//
// The fake proxy implements CONNECT tunnelling (undici's ProxyAgent tunnels even plain-HTTP
// targets) and forwards every tunnel to a local origin server, so no request leaves the machine.

const UNRESOLVABLE = 'http://does-not-resolve.wigolo-test.invalid/through-proxy';
const PROXY_ENV = [
  'USE_PROXY',
  'PROXY_URL',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
];

let origin: Server;
let proxy: Server;
let seen: string[];

function clearProxyEnv(): void {
  for (const name of PROXY_ENV) delete process.env[name];
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function stop(server: Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  clearProxyEnv();
  seen = [];
  origin = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('origin-ok');
  });
  const originPort = await listen(origin);

  proxy = createServer((req, res) => {
    // Not used by ProxyAgent (it tunnels), kept so an absolute-form request is still answered.
    seen.push(`plain ${req.url ?? ''}`);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('plain-proxied');
  });
  proxy.on('connect', (req, socket) => {
    seen.push(`connect ${req.url ?? ''}`);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const upstream = connect(originPort, '127.0.0.1');
    socket.pipe(upstream);
    upstream.pipe(socket);
    upstream.on('error', () => socket.destroy());
  });
  const proxyPort = await listen(proxy);

  process.env.USE_PROXY = '1';
  process.env.PROXY_URL = `http://127.0.0.1:${proxyPort}`;
  resetConfig();
});

afterEach(async () => {
  resetProxyDispatcher();
  clearProxyEnv();
  resetConfig();
  await stop(proxy);
  await stop(origin);
});

describe('proxy dispatcher', () => {
  it('routes the global fetch (search engines) through the configured proxy', async () => {
    expect(hasProxyDispatcher()).toBe(false);
    installProxyDispatcher();
    expect(hasProxyDispatcher()).toBe(true);

    const res = await fetch(UNRESOLVABLE);

    expect(await res.text()).toBe('origin-ok');
    expect(seen).toEqual(['connect does-not-resolve.wigolo-test.invalid:80']);
  });

  it('lets httpFetch use the proxy for a host it cannot resolve locally', async () => {
    installProxyDispatcher();

    const result = await httpFetch(UNRESOLVABLE, { timeoutMs: 5000 });

    expect(result.html).toBe('origin-ok');
    expect(seen).toHaveLength(1);
  });

  it('reports no proxy when neither PROXY_URL nor the environment is set', () => {
    clearProxyEnv();
    resetConfig();

    expect(installProxyDispatcher()).toBeNull();
    expect(hasProxyDispatcher()).toBe(false);
  });

  it('still fails closed without a proxy when the host does not resolve', async () => {
    clearProxyEnv();
    resetConfig();
    expect(installProxyDispatcher()).toBeNull();

    await expect(httpFetch(UNRESOLVABLE, { timeoutMs: 5000 })).rejects.toThrow(
      /refusing to connect without pinning/,
    );
    expect(seen).toHaveLength(0);
  });

  it('falls back to the standard proxy environment variables', () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    delete process.env.PROXY_URL;
    delete process.env.USE_PROXY;
    resetConfig();

    expect(installProxyDispatcher()).not.toBeNull();
    expect(hasProxyDispatcher()).toBe(true);
  });
});

