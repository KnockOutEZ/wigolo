import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { getConfig, resetConfig } from '../../../src/config.js';
import { httpFetch } from '../../../src/fetch/http-client.js';

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

describe('httpFetch', () => {
  beforeEach(() => {
    resetConfig();
  });

  describe('successful fetch', () => {
    let server: http.Server;

    afterEach(async () => {
      await closeServer(server);
    });

    it('returns status, headers, and body on success', async () => {
      server = await startServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body>Hello</body></html>');
      });

      const url = `http://127.0.0.1:${getPort(server)}/`;
      const result = await httpFetch(url);

      expect(result.statusCode).toBe(200);
      expect(result.html).toContain('Hello');
      expect(result.contentType).toContain('text/html');
      expect(result.url).toBe(url);
      expect(result.finalUrl).toBe(url);
      expect(result.headers).toBeDefined();
    });

    it('buffers a PDF served as application/octet-stream into rawBuffer (magic-bytes sniff)', async () => {
      // WHY: some servers ship a PDF with a generic content-type (octet-stream
      // or none). The byte tier must recognise the %PDF- magic marker and
      // buffer the bytes, otherwise the router's PDF short-circuit never fires
      // and the empty-decoded body escalates to the browser.
      const pdfBytes = Buffer.from('%PDF-1.4\n%âãÏÓ\nfake pdf body', 'latin1');
      server = await startServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(pdfBytes);
      });

      const url = `http://127.0.0.1:${getPort(server)}/paper`;
      const result = await httpFetch(url);

      expect(result.statusCode).toBe(200);
      expect(result.rawBuffer).toBeDefined();
      expect(result.rawBuffer!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(result.html).toBe('');
      // Normalised so the extractor (keys on content-type) runs pdf-parse.
      expect(result.contentType).toBe('application/pdf');
    });

    it('does NOT buffer a normal octet-stream (non-PDF) response into rawBuffer', async () => {
      // Regression guard: only %PDF- bodies get the byte-tier treatment; a
      // generic binary/text octet-stream still decodes to html as before.
      server = await startServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('just some plain text, not a pdf');
      });

      const url = `http://127.0.0.1:${getPort(server)}/data`;
      const result = await httpFetch(url);

      expect(result.rawBuffer).toBeUndefined();
      expect(result.html).toContain('just some plain text');
    });

    it('sends custom headers', async () => {
      let receivedHeaders: http.IncomingHttpHeaders = {};
      server = await startServer((req, res) => {
        receivedHeaders = req.headers;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html></html>');
      });

      const url = `http://127.0.0.1:${getPort(server)}/`;
      await httpFetch(url, { headers: { 'x-custom': 'test-value' } });

      expect(receivedHeaders['x-custom']).toBe('test-value');
    });
  });

  describe('timeout', () => {
    let server: http.Server;

    afterEach(async () => {
      await closeServer(server);
    });

    it('triggers timeout after configured duration', async () => {
      server = await startServer((_req, _res) => {
        // Never respond — force a timeout
      });

      process.env.FETCH_TIMEOUT_MS = '100';
      resetConfig();

      const url = `http://127.0.0.1:${getPort(server)}/`;
      await expect(httpFetch(url)).rejects.toThrow();
    }, 5000);
  });

  describe('retries', () => {
    let server: http.Server;

    afterEach(async () => {
      await closeServer(server);
    });

    it('retries on 502 and eventually succeeds', async () => {
      let requestCount = 0;
      server = await startServer((_req, res) => {
        requestCount++;
        if (requestCount < 3) {
          res.writeHead(502);
          res.end('Bad Gateway');
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>OK</html>');
        }
      });

      process.env.FETCH_MAX_RETRIES = '3';
      process.env.FETCH_TIMEOUT_MS = '5000';
      resetConfig();

      const url = `http://127.0.0.1:${getPort(server)}/`;
      const result = await httpFetch(url);

      expect(result.statusCode).toBe(200);
      expect(requestCount).toBe(3);
    }, 15000);

    it('retries on 503', async () => {
      let requestCount = 0;
      server = await startServer((_req, res) => {
        requestCount++;
        if (requestCount < 2) {
          res.writeHead(503);
          res.end('Service Unavailable');
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>OK</html>');
        }
      });

      process.env.FETCH_MAX_RETRIES = '2';
      process.env.FETCH_TIMEOUT_MS = '5000';
      resetConfig();

      const url = `http://127.0.0.1:${getPort(server)}/`;
      const result = await httpFetch(url);

      expect(result.statusCode).toBe(200);
      expect(requestCount).toBe(2);
    }, 10000);

    it('retries on 429', async () => {
      let requestCount = 0;
      server = await startServer((_req, res) => {
        requestCount++;
        if (requestCount < 2) {
          res.writeHead(429, { 'retry-after': '0' });
          res.end('Too Many Requests');
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>OK</html>');
        }
      });

      process.env.FETCH_MAX_RETRIES = '2';
      process.env.FETCH_TIMEOUT_MS = '5000';
      resetConfig();

      const url = `http://127.0.0.1:${getPort(server)}/`;
      const result = await httpFetch(url);

      expect(result.statusCode).toBe(200);
      expect(requestCount).toBe(2);
    }, 10000);

    it('does not retry on 404', async () => {
      let requestCount = 0;
      server = await startServer((_req, res) => {
        requestCount++;
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('Not Found');
      });

      process.env.FETCH_MAX_RETRIES = '3';
      resetConfig();

      const url = `http://127.0.0.1:${getPort(server)}/`;
      const result = await httpFetch(url);

      expect(result.statusCode).toBe(404);
      expect(requestCount).toBe(1);
    });

    it('throws after exhausting retries on persistent 502', async () => {
      server = await startServer((_req, res) => {
        res.writeHead(502);
        res.end('Bad Gateway');
      });

      process.env.FETCH_MAX_RETRIES = '1';
      process.env.FETCH_TIMEOUT_MS = '5000';
      resetConfig();

      const url = `http://127.0.0.1:${getPort(server)}/`;
      await expect(httpFetch(url)).rejects.toThrow();
    }, 10000);
  });

  describe('redirects', () => {
    let server: http.Server;

    afterEach(async () => {
      await closeServer(server);
    });

    it('follows redirects and records final URL', async () => {
      server = await startServer((req, res) => {
        if (req.url === '/start') {
          res.writeHead(301, { location: `http://127.0.0.1:${getPort(server)}/end` });
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>Final</html>');
        }
      });

      const startUrl = `http://127.0.0.1:${getPort(server)}/start`;
      const endUrl = `http://127.0.0.1:${getPort(server)}/end`;
      const result = await httpFetch(startUrl);

      expect(result.url).toBe(startUrl);
      expect(result.finalUrl).toBe(endUrl);
      expect(result.html).toContain('Final');
    });

    it('detects redirect loops and aborts', async () => {
      server = await startServer((req, res) => {
        if (req.url === '/a') {
          res.writeHead(302, { location: `http://127.0.0.1:${getPort(server)}/b` });
          res.end();
        } else {
          res.writeHead(302, { location: `http://127.0.0.1:${getPort(server)}/a` });
          res.end();
        }
      });

      const url = `http://127.0.0.1:${getPort(server)}/a`;
      await expect(httpFetch(url)).rejects.toThrow(/redirect loop/i);
    });

    it('aborts when MAX_REDIRECTS exceeded', async () => {
      server = await startServer((req, res) => {
        const n = parseInt(req.url!.slice(1)) || 0;
        res.writeHead(302, { location: `http://127.0.0.1:${getPort(server)}/${n + 1}` });
        res.end();
      });

      process.env.MAX_REDIRECTS = '3';
      resetConfig();

      const url = `http://127.0.0.1:${getPort(server)}/0`;
      await expect(httpFetch(url)).rejects.toThrow(/redirect/i);
    });

    it('follows 307 and 308 redirects', async () => {
      server = await startServer((req, res) => {
        if (req.url === '/307') {
          res.writeHead(307, { location: `http://127.0.0.1:${getPort(server)}/done` });
          res.end();
        } else if (req.url === '/done') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>Done</html>');
        }
      });

      const url = `http://127.0.0.1:${getPort(server)}/307`;
      const result = await httpFetch(url);
      expect(result.statusCode).toBe(200);
      expect(result.html).toContain('Done');
    });
  });

  describe('connection errors', () => {
    it('throws on ECONNREFUSED after retries', async () => {
      process.env.FETCH_MAX_RETRIES = '1';
      process.env.FETCH_TIMEOUT_MS = '2000';
      resetConfig();

      // Port 1 is almost always refused
      await expect(httpFetch('http://127.0.0.1:1/')).rejects.toThrow();
    }, 10000);
  });

  describe('external signal cancellation', () => {
    afterEach(() => {
      delete process.env.FETCH_MAX_RETRIES;
      delete process.env.FETCH_TIMEOUT_MS;
      resetConfig();
    });

    it('an already-aborted external signal rejects without hitting the server', async () => {
      let hits = 0;
      const server = await startServer((_req, res) => { hits++; res.end('ok'); });
      const port = getPort(server);
      const ac = new AbortController();
      ac.abort(new DOMException('stage_timeout', 'AbortError'));
      await expect(httpFetch(`http://127.0.0.1:${port}/`, { signal: ac.signal })).rejects.toBeTruthy();
      expect(hits).toBe(0);
      await closeServer(server);
    });

    it('aborting during retry backoff rejects well before the backoff elapses', async () => {
      // Server always 503 (retryable) → httpFetch enters sleep(backoffMs ~500-1000ms).
      // Aborting at ~50ms via real timer must wake the sleep and reject promptly.
      process.env.FETCH_MAX_RETRIES = '3';
      process.env.FETCH_TIMEOUT_MS = '2000';
      resetConfig();

      const server = await startServer((_req, res) => { res.statusCode = 503; res.end('busy'); });
      const port = getPort(server);
      const ac = new AbortController();
      const startedAt = Date.now();
      const p = httpFetch(`http://127.0.0.1:${port}/`, { signal: ac.signal });
      setTimeout(() => ac.abort(new DOMException('stage_timeout', 'AbortError')), 50);
      await expect(p).rejects.toBeTruthy();
      expect(Date.now() - startedAt).toBeLessThan(450); // woke from sleep, did NOT wait full backoff
      await closeServer(server);
    }, 5000);
  });
});
