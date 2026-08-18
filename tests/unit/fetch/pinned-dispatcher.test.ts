import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { pinnedFetch } from '../../../src/fetch/pinned-dispatcher.js';

function getPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

function startServer(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('pinnedFetch (HTTP-tier DNS-rebinding pin)', () => {
  let server: http.Server;

  afterEach(async () => {
    if (server) await closeServer(server);
  });

  it('connects to the validated IP while keeping the original Host header', async () => {
    // WHY: the pin must land the socket on the IP we already checked, without
    // rewriting the URL to an IP literal (that would break SNI / vhost / Host).
    // `ssrf-pin.test` is not a real DNS name — without the pin, fetch would
    // ENOTFOUND. With the pin, it hits the loopback server and sends the name
    // as Host.
    let seenHost: string | undefined;
    server = await startServer((req, res) => {
      seenHost = req.headers.host;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pinned');
    });
    const port = getPort(server);
    const url = `http://ssrf-pin.test:${port}/page`;
    const response = await pinnedFetch(
      url,
      { redirect: 'manual' },
      [{ address: '127.0.0.1', family: 4 }],
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('pinned');
    expect(seenHost).toBe(`ssrf-pin.test:${port}`);
  });

  it('does not consult DNS again after the validated set is in hand', async () => {
    // A hostname that does not resolve at all. If the Agent re-resolved
    // instead of using the pinned set, this fetch would fail with ENOTFOUND
    // rather than reaching the loopback listener.
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const port = getPort(server);
    const response = await pinnedFetch(
      `http://does-not-resolve.invalid:${port}/`,
      { redirect: 'manual' },
      [{ address: '127.0.0.1', family: 4 }],
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('falls through to ordinary fetch when there is no validated address set', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('literal');
    });
    const url = `http://127.0.0.1:${getPort(server)}/`;
    const response = await pinnedFetch(url, { redirect: 'manual' }, []);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('literal');
  });
});
