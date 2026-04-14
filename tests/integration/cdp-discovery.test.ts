import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { resetConfig } from '../../src/config.js';
import { discoverSessions, isCDPReachable, parseCDPResponse } from '../../src/fetch/cdp-client.js';
import { listSessions } from '../../src/fetch/auth.js';
import type { CDPSession } from '../../src/types.js';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'cdp-json');

function readFixture(name: string): string {
  return fs.readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

let cdpServer: http.Server;
let cdpPort: number;
let responseBody: string;
let responseStatus: number;

function startCDPServer(): Promise<void> {
  return new Promise((resolve) => {
    cdpServer = http.createServer((req, res) => {
      if (req.url === '/json') {
        res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      } else if (req.url === '/json/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          'Browser': 'Chrome/120.0.0.0',
          'Protocol-Version': '1.3',
          'User-Agent': 'Mozilla/5.0',
          'V8-Version': '12.0.0.0',
          'WebKit-Version': '537.36',
          'webSocketDebuggerUrl': `ws://127.0.0.1:${cdpPort}/devtools/browser/mock`,
        }));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    cdpServer.listen(0, '127.0.0.1', () => {
      cdpPort = (cdpServer.address() as AddressInfo).port;
      resolve();
    });
  });
}

function stopCDPServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cdpServer) {
      cdpServer.close((err) => (err ? reject(err) : resolve()));
    } else {
      resolve();
    }
  });
}

describe('CDP Discovery Integration', () => {
  const originalEnv = process.env;

  beforeAll(async () => {
    responseBody = readFixture('active-sessions.json');
    responseStatus = 200;
    await startCDPServer();
  });

  afterAll(async () => {
    await stopCDPServer();
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    responseBody = readFixture('active-sessions.json');
    responseStatus = 200;
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('discovers sessions from a live mock CDP endpoint', async () => {
    const sessions = await discoverSessions(`http://127.0.0.1:${cdpPort}`);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0]).toHaveProperty('id');
    expect(sessions[0]).toHaveProperty('url');
    expect(sessions[0]).toHaveProperty('title');
    expect(sessions[0]).toHaveProperty('webSocketDebuggerUrl');
  });

  it('isCDPReachable returns true for live endpoint', async () => {
    const reachable = await isCDPReachable(`http://127.0.0.1:${cdpPort}`);
    expect(reachable).toBe(true);
  });

  it('isCDPReachable returns false for dead port', async () => {
    const reachable = await isCDPReachable('http://127.0.0.1:19876');
    expect(reachable).toBe(false);
  });

  it('listSessions integrates with CDP endpoint via config', async () => {
    process.env.WIGOLO_CDP_URL = `http://127.0.0.1:${cdpPort}`;
    resetConfig();

    const sessions = await listSessions();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0].id).toBeDefined();
  });

  it('listSessions returns empty when WIGOLO_CDP_URL not set', async () => {
    delete process.env.WIGOLO_CDP_URL;
    resetConfig();

    const sessions = await listSessions();
    expect(sessions).toEqual([]);
  });

  it('handles server returning empty array', async () => {
    responseBody = readFixture('empty.json');

    const sessions = await discoverSessions(`http://127.0.0.1:${cdpPort}`);
    expect(sessions).toEqual([]);
  });

  it('handles server returning malformed JSON', async () => {
    responseBody = readFixture('malformed.json');

    const sessions = await discoverSessions(`http://127.0.0.1:${cdpPort}`);
    expect(sessions).toEqual([]);
  });

  it('handles server returning 500 error', async () => {
    responseStatus = 500;
    responseBody = 'Internal Server Error';

    const sessions = await discoverSessions(`http://127.0.0.1:${cdpPort}`);
    expect(sessions).toEqual([]);
  });

  it('filters page-type sessions when requested', async () => {
    const sessions = await discoverSessions(`http://127.0.0.1:${cdpPort}`, { filterPages: true });
    for (const session of sessions) {
      expect(session.type === 'page' || session.type === undefined).toBe(true);
    }
  });

  it('includes all session types when not filtering', async () => {
    const sessions = await discoverSessions(`http://127.0.0.1:${cdpPort}`);
    const types = sessions.map(s => s.type).filter(Boolean);
    expect(types.length).toBeGreaterThan(0);
  });

  it('session objects have correct CDPSession shape', async () => {
    const sessions = await discoverSessions(`http://127.0.0.1:${cdpPort}`);
    for (const session of sessions) {
      expect(typeof session.id).toBe('string');
      expect(typeof session.url).toBe('string');
      expect(typeof session.title).toBe('string');
      expect(typeof session.webSocketDebuggerUrl).toBe('string');
      expect(session.webSocketDebuggerUrl).toMatch(/^ws:\/\//);
    }
  });

  it('handles unicode in session titles from real endpoint', async () => {
    const sessions = await discoverSessions(`http://127.0.0.1:${cdpPort}`);
    const reactSession = sessions.find(s => s.id === 'GHI789');
    expect(reactSession).toBeDefined();
    expect(reactSession!.title).toContain('React');
  });

  it('concurrent discovery calls do not interfere', async () => {
    const results = await Promise.all([
      discoverSessions(`http://127.0.0.1:${cdpPort}`),
      discoverSessions(`http://127.0.0.1:${cdpPort}`),
      discoverSessions(`http://127.0.0.1:${cdpPort}`),
    ]);

    for (const sessions of results) {
      expect(sessions.length).toBeGreaterThan(0);
    }
  });

  it('discovery with very short timeout handles gracefully', async () => {
    const sessions = await discoverSessions(`http://127.0.0.1:${cdpPort}`, { timeoutMs: 1 });
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('parseCDPResponse handles the full fixture correctly', () => {
    const raw = readFixture('active-sessions.json');
    const sessions = parseCDPResponse(raw);
    expect(sessions).toHaveLength(4);

    const pageTypes = sessions.filter(s => s.type === 'page');
    expect(pageTypes).toHaveLength(3);

    const serviceWorkers = sessions.filter(s => s.type === 'service_worker');
    expect(serviceWorkers).toHaveLength(1);
  });
});
