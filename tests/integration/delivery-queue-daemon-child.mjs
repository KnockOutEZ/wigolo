/**
 * A real daemon, in a process of its own, for the SD2 §3.3 durability claim.
 *
 * The claim is that an undelivered message survives a daemon restart BY CONSTRUCTION — it is an
 * event, and the queue is a fold over the log rather than anything held in memory. A restart is the
 * only way to test that, and a restart needs a process: an in-process "restart" would reopen the
 * same module-level SQLite handle and the same `run-bus` subscribers, so it would prove that a
 * cached handle still answers and nothing at all about what is on disk.
 *
 * Two servers, both loopback, ports reported on stdout as one JSON line:
 *
 *   - `rest`    — the real `DaemonHttpServer`, serving `/v1/runs*` incl. the messages route.
 *   - `control` — `POST /call`, one studio tool call THROUGH the dispatch seam, which is the only
 *     way another process can make this one mint a result and so drain its queue. The host handlers
 *     are stubs; the seam, the baton gate and the delivery hooks are the production ones, installed
 *     by `setStudioHost` exactly as the live studio host installs them.
 *
 * `WIGOLO_DATA_DIR` must already be in this process's env — it is read and cached the first time a
 * wigolo module resolves its config, which the imports below do.
 */
import { createServer } from 'node:http';
import { DaemonHttpServer } from '../../dist/daemon/http-server.js';
import { dispatchStudioTool } from '../../dist/daemon/studio-dispatch.js';

const dataDir = process.env.WIGOLO_DATA_DIR;

/** Enough of a host to mint a result. Nothing here touches a page; the queue rides the result. */
const host = {
  observe: async () => ({ id: 's', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  act: async (input) => ({ ok: true, action: input.action, url: input.url }),
  marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
  spawn: async () => ({ session_id: 'bg-1' }),
  close: async (input) => ({ closed: true, session_id: input.session_id ?? '' }),
  list: async () => ({ sessions: [] }),
  say: async () => ({ posted: true, posted_at: 0 }),
  extractSet: async () => ({ columns: [], rows: [], pages_followed: 0, artifact_id: 1 }),
};

const rest = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
const restUrl = await rest.start();
// This is what installs the baton gate and the delivery hooks (http-server.ts) — the production
// closures, reading this process's own store. A child that skipped it would drain nothing and the
// restart row would pass for the wrong reason.
rest.setStudioHost(host);

const control = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/call') {
    res.writeHead(404).end('no');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const { runId } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      const result = await dispatchStudioTool(
        'studio_act',
        { action: 'navigate', url: 'https://example.com', run_id: runId },
        host,
        dataDir,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(result.content[0].text);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
    }
  });
});

await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));

process.stdout.write(`${JSON.stringify({ rest: Number(new URL(restUrl).port), control: control.address().port, pid: process.pid })}\n`);
