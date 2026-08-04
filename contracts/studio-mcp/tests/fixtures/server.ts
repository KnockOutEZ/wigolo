import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A loopback server for the one fixture page. Bound to 127.0.0.1 on an ephemeral port so parallel or
 * repeated runs cannot collide on a fixed one, and it serves exactly one file — there is no path
 * routing to get wrong and nothing else on the origin to reach.
 */
export interface FixtureServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const html = readFileSync(join(import.meta.dirname, 'contract-page.html'), 'utf8');
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/contract-page.html`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
