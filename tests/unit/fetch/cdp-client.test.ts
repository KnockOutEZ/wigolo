import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { discoverSessions, parseCDPResponse, isCDPReachable } from '../../../src/fetch/cdp-client.js';
import type { CDPSession } from '../../../src/types.js';

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'cdp-json');

function readFixture(name: string): string {
  return fs.readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

function startMockCDP(responseBody: string, statusCode = 200): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json') {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function getPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

describe('parseCDPResponse', () => {
  it('parses a valid CDP /json response with multiple sessions', () => {
    const raw = readFixture('active-sessions.json');
    const sessions = parseCDPResponse(raw);
    expect(sessions).toHaveLength(4);
    expect(sessions[0].id).toBe('ABC123');
    expect(sessions[0].url).toBe('https://www.google.com/');
    expect(sessions[0].title).toBe('Google Search');
    expect(sessions[0].webSocketDebuggerUrl).toBe('ws://localhost:9222/devtools/page/ABC123');
  });

  it('parses empty array', () => {
    const raw = readFixture('empty.json');
    const sessions = parseCDPResponse(raw);
    expect(sessions).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    const raw = readFixture('malformed.json');
    const sessions = parseCDPResponse(raw);
    expect(sessions).toEqual([]);
  });

  it('returns empty array for null-like input', () => {
    expect(parseCDPResponse('')).toEqual([]);
    expect(parseCDPResponse('null')).toEqual([]);
    expect(parseCDPResponse('undefined')).toEqual([]);
  });

  it('filters out entries missing webSocketDebuggerUrl', () => {
    const raw = JSON.stringify([
      { id: '1', url: 'http://a.com', title: 'A', webSocketDebuggerUrl: 'ws://localhost:9222/1' },
      { id: '2', url: 'http://b.com', title: 'B' },
      { id: '3', url: 'http://c.com', title: 'C', webSocketDebuggerUrl: '' },
    ]);
    const sessions = parseCDPResponse(raw);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('1');
  });

  it('filters out entries missing id', () => {
    const raw = JSON.stringify([
      { url: 'http://a.com', title: 'A', webSocketDebuggerUrl: 'ws://localhost:9222/1' },
    ]);
    const sessions = parseCDPResponse(raw);
    expect(sessions).toEqual([]);
  });

  it('handles unicode in title', () => {
    const raw = JSON.stringify([
      { id: '1', url: 'http://a.com', title: 'Uber uns', webSocketDebuggerUrl: 'ws://localhost:9222/1' },
    ]);
    const sessions = parseCDPResponse(raw);
    expect(sessions[0].title).toBe('Uber uns');
  });

  it('handles very long title', () => {
    const longTitle = 'A'.repeat(10000);
    const raw = JSON.stringify([
      { id: '1', url: 'http://a.com', title: longTitle, webSocketDebuggerUrl: 'ws://localhost:9222/1' },
    ]);
    const sessions = parseCDPResponse(raw);
    expect(sessions[0].title).toBe(longTitle);
  });

  it('handles sessions with extra unknown fields', () => {
    const raw = JSON.stringify([
      { id: '1', url: 'http://a.com', title: 'A', webSocketDebuggerUrl: 'ws://x', extra: 'field', nested: { a: 1 } },
    ]);
    const sessions = parseCDPResponse(raw);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('1');
  });

  it('preserves type and devtoolsFrontendUrl when present', () => {
    const raw = JSON.stringify([
      {
        id: '1', url: 'http://a.com', title: 'A',
        webSocketDebuggerUrl: 'ws://x',
        type: 'page',
        devtoolsFrontendUrl: '/devtools/inspector.html?ws=x',
      },
    ]);
    const sessions = parseCDPResponse(raw);
    expect(sessions[0].type).toBe('page');
    expect(sessions[0].devtoolsFrontendUrl).toBe('/devtools/inspector.html?ws=x');
  });

  it('handles JSON array with 100 entries', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      id: `id-${i}`, url: `http://page-${i}.com`, title: `Page ${i}`,
      webSocketDebuggerUrl: `ws://localhost:9222/devtools/page/id-${i}`,
    }));
    const sessions = parseCDPResponse(JSON.stringify(entries));
    expect(sessions).toHaveLength(100);
  });

  it('returns empty array for JSON object (not array)', () => {
    const sessions = parseCDPResponse('{"id": "1"}');
    expect(sessions).toEqual([]);
  });
});

describe('discoverSessions', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it('fetches and parses sessions from a live CDP endpoint', async () => {
    const fixture = readFixture('active-sessions.json');
    server = await startMockCDP(fixture);
    const port = getPort(server);

    const sessions = await discoverSessions(`http://127.0.0.1:${port}`);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0].id).toBe('ABC123');
  });

  it('returns empty array for empty CDP endpoint', async () => {
    const fixture = readFixture('empty.json');
    server = await startMockCDP(fixture);
    const port = getPort(server);

    const sessions = await discoverSessions(`http://127.0.0.1:${port}`);
    expect(sessions).toEqual([]);
  });

  it('returns empty array when CDP endpoint is unreachable', async () => {
    const sessions = await discoverSessions('http://127.0.0.1:19999');
    expect(sessions).toEqual([]);
  });

  it('returns empty array when CDP returns non-200', async () => {
    server = await startMockCDP('Internal Server Error', 500);
    const port = getPort(server);

    const sessions = await discoverSessions(`http://127.0.0.1:${port}`);
    expect(sessions).toEqual([]);
  });

  it('returns empty array for malformed JSON response', async () => {
    server = await startMockCDP('{not json}');
    const port = getPort(server);

    const sessions = await discoverSessions(`http://127.0.0.1:${port}`);
    expect(sessions).toEqual([]);
  });

  it('handles timeout to slow endpoint', async () => {
    server = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('[]');
        }, 10000);
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = getPort(server);

    const sessions = await discoverSessions(`http://127.0.0.1:${port}`, { timeoutMs: 500 });
    expect(sessions).toEqual([]);
  }, 10000);

  it('filters page-type sessions by default', async () => {
    const fixture = readFixture('active-sessions.json');
    server = await startMockCDP(fixture);
    const port = getPort(server);

    const sessions = await discoverSessions(`http://127.0.0.1:${port}`, { filterPages: true });
    expect(sessions.every(s => s.type === 'page' || s.type === undefined)).toBe(true);
  });
});

describe('isCDPReachable', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it('returns true when CDP endpoint responds', async () => {
    server = await startMockCDP('[]');
    const port = getPort(server);

    const reachable = await isCDPReachable(`http://127.0.0.1:${port}`);
    expect(reachable).toBe(true);
  });

  it('returns false when CDP endpoint is unreachable', async () => {
    const reachable = await isCDPReachable('http://127.0.0.1:19998');
    expect(reachable).toBe(false);
  });

  it('returns false when endpoint responds with 500', async () => {
    server = await startMockCDP('error', 500);
    const port = getPort(server);

    const reachable = await isCDPReachable(`http://127.0.0.1:${port}`);
    expect(reachable).toBe(false);
  });

  it('returns false for timeout', async () => {
    server = await new Promise<http.Server>((resolve) => {
      const s = http.createServer(() => {
        // Never respond
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = getPort(server);

    const reachable = await isCDPReachable(`http://127.0.0.1:${port}`, 500);
    expect(reachable).toBe(false);
  }, 10000);
});
