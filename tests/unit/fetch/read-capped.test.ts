import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { resetConfig } from '../../../src/config.js';
import { httpFetch } from '../../../src/fetch/http-client.js';
import { tlsFetch, _resetTlsBackend, _setTlsBackendForTests } from '../../../src/fetch/tls-tier.js';
import { describeFetchError } from '../../../src/fetch/error-describe.js';
import { readCapped, ResponseTooLargeError, isResponseTooLarge } from '../../../src/fetch/read-capped.js';

/** Start a local HTTP server on a random port with the given handler. */
function startServer(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Close a test server, dropping any open keep-alive connections first. */
function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** A stream of `count` chunks of `size` bytes, tracking how many were pulled. */
function chunkedStream(count: number, size: number): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= count) {
        controller.close();
        return;
      }
      sent++;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  return { stream, pulled: () => sent };
}

describe('readCapped', () => {
  it('returns the full body when under the cap', async () => {
    const buf = await readCapped(new Response('hello world'), 1024);
    expect(buf.toString('utf-8')).toBe('hello world');
  });

  it('accepts a body exactly at the cap', async () => {
    const buf = await readCapped(new Response('x'.repeat(100)), 100);
    expect(buf.length).toBe(100);
  });

  it('rejects early on a declared content-length over the cap', async () => {
    const { stream, pulled } = chunkedStream(10, 100);
    const res = new Response(stream);
    await expect(readCapped(res, 50, { contentLength: '1000' })).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it('aborts a stream with no declared length once it passes the cap', async () => {
    const { stream, pulled } = chunkedStream(1000, 1024);
    const res = new Response(stream);
    const err = await readCapped(res, 4096).catch((e) => e);
    expect(isResponseTooLarge(err)).toBe(true);
    expect((err as ResponseTooLargeError).maxBytes).toBe(4096);
    // Stopped shortly after the cap instead of reading all 1000 chunks.
    expect(pulled()).toBeLessThan(10);
  });

  it('treats a cap of 0 as disabled', async () => {
    const buf = await readCapped(new Response('x'.repeat(5000)), 0, { contentLength: '5000' });
    expect(buf.length).toBe(5000);
  });

  it('falls back to arrayBuffer() when there is no body stream', async () => {
    const res = { body: null, arrayBuffer: async () => new TextEncoder().encode('abcdef').buffer as ArrayBuffer };
    await expect(readCapped(res, 3)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect((await readCapped(res, 10)).toString()).toBe('abcdef');
  });

  it('describes the error with a hint pointing at the env var', () => {
    const d = describeFetchError(new ResponseTooLargeError(10, 'https://example.com/big'));
    expect(d.reason).toContain('10-byte limit');
    expect(d.hint).toContain('WIGOLO_MAX_RESPONSE_BYTES');
  });
});

describe('httpFetch response-size cap', () => {
  const originalEnv = { ...process.env };
  let server: http.Server;

  beforeEach(() => {
    process.env.WIGOLO_MAX_RESPONSE_BYTES = '4096';
    resetConfig();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    resetConfig();
    if (server) await closeServer(server);
  });

  it('fails a text response whose content-length is over the cap', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(10_000) });
      res.end('a'.repeat(10_000));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const err = await httpFetch(url).catch((e) => e);
    expect(isResponseTooLarge(err)).toBe(true);
  });

  it('fails a chunked response with no content-length once it passes the cap', async () => {
    let written = 0;
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }); // chunked, no length
      const timer = setInterval(() => {
        if (res.destroyed || written >= 1_000_000) {
          clearInterval(timer);
          if (!res.destroyed) res.end();
          return;
        }
        res.write('a'.repeat(1024));
        written += 1024;
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const err = await httpFetch(url).catch((e) => e);
    expect(isResponseTooLarge(err)).toBe(true);
    expect(written).toBeLessThan(1_000_000);
  });

  it('applies the cap to PDF bodies too', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10_000)]));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/doc.pdf`;
    await expect(httpFetch(url)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('still returns responses under the cap unchanged', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>small</body></html>');
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const result = await httpFetch(url);
    expect(result.html).toContain('small');
  });
});

describe('tlsFetch response-size cap', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.WIGOLO_MAX_RESPONSE_BYTES = '4096';
    resetConfig();
    _resetTlsBackend();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    _setTlsBackendForTests(null);
    _resetTlsBackend();
  });

  it('fails a streamed body with no content-length once it passes the cap', async () => {
    const { stream, pulled } = chunkedStream(1000, 1024);
    _setTlsBackendForTests({
      fetch: async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    await expect(tlsFetch('https://example.com/huge')).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(pulled()).toBeLessThan(10);
  });

  it('returns a body under the cap', async () => {
    _setTlsBackendForTests({
      fetch: async () => new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    const r = await tlsFetch('https://example.com/small');
    expect(r.html).toBe('<html>ok</html>');
  });
});
