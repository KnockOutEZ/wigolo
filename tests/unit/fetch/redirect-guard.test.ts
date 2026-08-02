import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { resetConfig } from '../../../src/config.js';
import { httpFetch } from '../../../src/fetch/http-client.js';
import { defaultPdfProbe } from '../../../src/fetch/router.js';

/**
 * WHY: the manual 3xx redirect loop used to resolve `Location` and follow it
 * with NO SSRF re-check — a public URL could 302 a fetch straight onto a
 * cloud-metadata endpoint (169.254.169.254) or a private LAN host, bypassing
 * the input-URL guard entirely. These rows pin that EVERY resolved redirect
 * target is re-guarded with the same policy the input URL got. Loopback
 * (127.0.0.0/8) stays intentionally exempt — the fetch/crawl guard promises
 * local dev servers keep working — so the security property under test is
 * "redirect into private/metadata is refused", matching guardFetchUrl.
 */

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

describe('httpFetch redirect SSRF re-guard', () => {
  let server: http.Server;

  beforeEach(() => {
    delete process.env.WIGOLO_FETCH_ALLOW_PRIVATE;
    resetConfig();
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    delete process.env.WIGOLO_FETCH_ALLOW_PRIVATE;
    resetConfig();
  });

  it('refuses a 302 into a link-local metadata address (169.254.169.254)', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    const url = `http://127.0.0.1:${getPort(server)}/redir-metadata`;
    await expect(httpFetch(url)).rejects.toThrow(/link-local|metadata|blocked/i);
  });

  it('refuses a 302 into a private RFC1918 address by default', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(302, { location: 'http://10.0.0.5/internal' });
      res.end();
    });
    const url = `http://127.0.0.1:${getPort(server)}/redir-private`;
    await expect(httpFetch(url)).rejects.toThrow(/private|blocked|WIGOLO_FETCH_ALLOW_PRIVATE/i);
  });

  it('allows a 302 into another public host', async () => {
    // Chain two loopback servers (loopback is the fetch/crawl-exempt local-dev
    // case) to prove the guarded loop still follows a legitimate redirect.
    const end = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>Public destination</html>');
    });
    server = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${getPort(end)}/final` });
      res.end();
    });
    const url = `http://127.0.0.1:${getPort(server)}/start`;
    try {
      const r = await httpFetch(url);
      expect(r.statusCode).toBe(200);
      expect(r.html).toContain('Public destination');
    } finally {
      await closeServer(end);
    }
  });

  it('still bounds the hop count on a redirect chain', async () => {
    server = await startServer((req, res) => {
      const n = parseInt(req.url!.slice(1)) || 0;
      res.writeHead(302, { location: `http://127.0.0.1:${getPort(server)}/${n + 1}` });
      res.end();
    });
    process.env.MAX_REDIRECTS = '3';
    resetConfig();
    const url = `http://127.0.0.1:${getPort(server)}/0`;
    await expect(httpFetch(url)).rejects.toThrow(/redirect/i);
    delete process.env.MAX_REDIRECTS;
    resetConfig();
  });

  it('WIGOLO_FETCH_ALLOW_PRIVATE=1 allows a private redirect but STILL refuses metadata', async () => {
    process.env.WIGOLO_FETCH_ALLOW_PRIVATE = '1';
    // Fast-fail the doomed private connection so the "allowed → attempts
    // connection" path does not stall on a non-routable address.
    process.env.FETCH_MAX_RETRIES = '0';
    process.env.FETCH_TIMEOUT_MS = '1500';
    resetConfig();
    server = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://10.0.0.5:59999/never` });
      res.end();
    });
    // The guard now permits the private hop; the connection to 10.0.0.5 fails
    // fast (no listener) → a network error, NOT the SSRF guard refusal.
    const priv = `http://127.0.0.1:${getPort(server)}/redir-private-allowed`;
    await expect(httpFetch(priv)).rejects.not.toThrow(/Redirect blocked/i);
    await closeServer(server);

    delete process.env.FETCH_MAX_RETRIES;
    delete process.env.FETCH_TIMEOUT_MS;
    resetConfig();
    process.env.WIGOLO_FETCH_ALLOW_PRIVATE = '1';
    resetConfig();

    // Metadata stays refused even with allowPrivate.
    server = await startServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    const meta = `http://127.0.0.1:${getPort(server)}/redir-metadata-still-blocked`;
    await expect(httpFetch(meta)).rejects.toThrow(/link-local|metadata|blocked/i);
  }, 15000);
});

describe('defaultPdfProbe redirect SSRF re-guard', () => {
  let server: http.Server;

  beforeEach(() => {
    delete process.env.WIGOLO_FETCH_ALLOW_PRIVATE;
    resetConfig();
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    delete process.env.WIGOLO_FETCH_ALLOW_PRIVATE;
    resetConfig();
  });

  it('does not follow a HEAD redirect into a metadata address (returns false, no probe leak)', async () => {
    // The probe must never follow a redirect into a private/metadata target.
    // A guarded loop refuses the hop and returns false (probe failure is
    // non-fatal by contract) rather than issuing the metadata request.
    server = await startServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    const url = `http://127.0.0.1:${getPort(server)}/pdf-redir`;
    const result = await defaultPdfProbe(url);
    expect(result).toBe(false);
  });

  it('follows a benign redirect and detects a PDF at the destination', async () => {
    const pdf = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.4 body');
    });
    server = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${getPort(pdf)}/doc.pdf` });
      res.end();
    });
    const url = `http://127.0.0.1:${getPort(server)}/redir-to-pdf`;
    try {
      const result = await defaultPdfProbe(url);
      expect(result).toBe(true);
    } finally {
      await closeServer(pdf);
    }
  });
});
