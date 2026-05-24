import { createServer, type Server } from 'node:http';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  detectPlaywrightInstall,
  shouldEscalate,
  fetchWithPlaywright,
  closeDaemonBrowser,
} from '../../../src/fetch/playwright-tier.js';

describe('shouldEscalate', () => {
  it('escalates when body is shorter than 500 chars', () => {
    expect(shouldEscalate('short body')).toBe(true);
  });
  it('escalates when body contains "enable JavaScript"', () => {
    const body = 'x'.repeat(2000) + ' please enable JavaScript to view this site';
    expect(shouldEscalate(body)).toBe(true);
  });
  it('does not escalate substantial English content', () => {
    expect(shouldEscalate('a'.repeat(2000))).toBe(false);
  });
});

describe('detectPlaywrightInstall', () => {
  it('returns { installed: boolean } without throwing', async () => {
    const r = await detectPlaywrightInstall();
    expect(typeof r.installed).toBe('boolean');
    if (!r.installed) expect(r.hint).toMatch(/playwright install/);
  });
});

describe('fetchWithPlaywright hydration', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const status = await detectPlaywrightInstall();
    if (!status.installed) return;
    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        if (req.url === '/spa') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          // SPA shell that hydrates after a short delay. Mirrors react.dev /
          // nextjs.org behaviour where the initial HTML is a near-empty
          // <div id="root"></div> and the body text only appears once the JS
          // bundle runs.
          res.end(`<!doctype html><html><head><title>spa</title></head><body>
<div id="root"></div>
<script>
setTimeout(() => {
  document.getElementById('root').innerHTML =
    '<main><h1>Hydrated heading</h1>' +
    '<p>' + 'hydrated content '.repeat(60) + '</p>' +
    '</main>';
}, 200);
</script>
</body></html>`);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      server.listen(0, () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  }, 60_000);

  afterAll(async () => {
    await closeDaemonBrowser().catch(() => undefined);
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it('waits for delayed-hydration content before returning', async () => {
    const status = await detectPlaywrightInstall();
    if (!status.installed) {
      console.warn('Playwright not installed, skipping hydration test');
      return;
    }
    const result = await fetchWithPlaywright(`${baseUrl}/spa`);
    expect(result.text.length).toBeGreaterThan(500);
    expect(result.text).toContain('hydrated content');
    expect(result.html).toContain('Hydrated heading');
  }, 60_000);

  it('waits past nav-shell text for semantic <main> content (react.dev pattern)', async () => {
    const status = await detectPlaywrightInstall();
    if (!status.installed) {
      console.warn('Playwright not installed, skipping nav-shell test');
      return;
    }
    // Serve a page where the header/nav already contains > 500 chars of text
    // (so a generic body.innerText threshold would short-circuit), but the
    // <main> article only mounts after 300ms. The fix must wait for <main>
    // content, not just any body text.
    const navShellUrl = `${baseUrl}/nav-shell`;
    const navServer = createServer((req, res) => {
      if (req.url === '/nav-shell') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const navLinks = Array.from({ length: 30 }, (_, i) => `<a href="/${i}">Section ${i} navigation entry</a>`).join(' ');
        res.end(`<!doctype html><html><head><title>nav</title></head><body>
<header><nav>${navLinks}</nav></header>
<div id="root"></div>
<script>
setTimeout(() => {
  const main = document.createElement('main');
  main.innerHTML = '<h1>Real Article</h1><p>' + 'Substantive article paragraph that mounts after hydration. '.repeat(20) + '</p>';
  document.getElementById('root').appendChild(main);
}, 300);
</script>
</body></html>`);
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise<void>((resolve) => {
      navServer.listen(0, () => {
        const addr = navServer.address();
        if (typeof addr === 'object' && addr) {
          navShellUrl;
        }
        resolve();
      });
    });
    const addr = navServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const result = await fetchWithPlaywright(`http://127.0.0.1:${port}/nav-shell`);
      expect(result.html).toContain('Real Article');
      expect(result.text).toContain('Substantive article paragraph');
    } finally {
      await new Promise<void>((r) => navServer.close(() => r()));
    }
  }, 60_000);
});

describe('getDaemonBrowser race safety', () => {
  it('coalesces concurrent calls into a single launch', async () => {
    const { getDaemonBrowser, closeDaemonBrowser } = await import('../../../src/fetch/playwright-tier.js');
    await closeDaemonBrowser();
    const [a, b] = await Promise.allSettled([getDaemonBrowser(), getDaemonBrowser()]);
    if (a.status === 'fulfilled' && b.status === 'fulfilled') {
      expect(a.value).toBe(b.value);
    } else if (a.status === 'rejected' && b.status === 'rejected') {
      expect((a.reason as Error).message).toBe('playwright_not_installed');
      expect((b.reason as Error).message).toBe('playwright_not_installed');
    } else {
      throw new Error('inconsistent settlement: one fulfilled, one rejected — race not coalesced');
    }
    await closeDaemonBrowser();
  });
});
