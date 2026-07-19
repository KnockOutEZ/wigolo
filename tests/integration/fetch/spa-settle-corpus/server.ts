import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fx from './fixtures.js';

export interface CorpusServer {
  baseUrl: string;
  close(): Promise<void>;
}

export function startCorpusServer(): Promise<CorpusServer> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = url.pathname;
      if (route === '/beacon') {
        res.writeHead(204);
        res.end();
        return;
      }
      const html =
        route === '/delayed' ? fx.delayedMountSpa(Number(url.searchParams.get('ms') ?? 1500))
        : route === '/nav-shell' ? fx.navShellForever()
        : route === '/never-idle' ? fx.neverNetworkidle()
        : route === '/instant' ? fx.instantStatic()
        // reserved: challenge_shell label is asserted at the browser-pool unit lane (Task 5), not here.
        : route === '/challenge' ? fx.challengeShell()
        : route === '/code-docs' ? fx.codeHeavyDocs()
        : route === '/ticker' ? fx.tickerPage()
        : route === '/thin-frameless' ? fx.thinFrameless()
        : null;
      if (html === null) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(route === '/challenge' ? 403 : 200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}
