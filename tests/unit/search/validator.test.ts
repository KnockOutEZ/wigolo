import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { validateLinks } from '../../../src/search/validator.js';
import { resetConfig } from '../../../src/config.js';

describe('validateLinks', () => {
  let server: Server;
  let port: number;
  const originalEnv = process.env;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok') { res.writeHead(200); res.end(); }
      else if (req.url === '/not-found') { res.writeHead(404); res.end(); }
      else if (req.url === '/error') { res.writeHead(500); res.end(); }
      else if (req.url === '/slow') { /* never respond — test timeout */ }
      else { res.writeHead(200); res.end(); }
    });
    await new Promise<void>(resolve => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(() => { server.close(); });

  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'true', VALIDATE_TIMEOUT_MS: '1000' };
    resetConfig();
  });

  afterEach(() => { process.env = originalEnv; resetConfig(); });

  it('keeps valid URLs', async () => {
    const results = [{ url: `http://127.0.0.1:${port}/ok`, title: 'OK' }];
    const valid = await validateLinks(results);
    expect(valid).toHaveLength(1);
  });

  it('filters 404 URLs', async () => {
    const results = [
      { url: `http://127.0.0.1:${port}/ok`, title: 'OK' },
      { url: `http://127.0.0.1:${port}/not-found`, title: 'Missing' },
    ];
    const valid = await validateLinks(results);
    expect(valid).toHaveLength(1);
    expect(valid[0].title).toBe('OK');
  });

  it('filters 5xx URLs', async () => {
    const results = [{ url: `http://127.0.0.1:${port}/error`, title: 'Err' }];
    const valid = await validateLinks(results);
    expect(valid).toHaveLength(0);
  });

  it('filters URLs that time out', async () => {
    const results = [{ url: `http://127.0.0.1:${port}/slow`, title: 'Slow' }];
    const valid = await validateLinks(results);
    expect(valid).toHaveLength(0);
  });

  it('skips validation when VALIDATE_LINKS=false', async () => {
    process.env.VALIDATE_LINKS = 'false';
    resetConfig();
    const results = [{ url: `http://127.0.0.1:${port}/not-found`, title: 'Missing' }];
    const valid = await validateLinks(results);
    expect(valid).toHaveLength(1);
  });

  it('handles concurrent validation within batch limit', async () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      url: `http://127.0.0.1:${port}/ok?i=${i}`,
      title: `Result ${i}`,
    }));
    const valid = await validateLinks(results, { maxConcurrent: 3 });
    expect(valid).toHaveLength(10);
  });
});
