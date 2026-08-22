/**
 * The REST/SSE half of the SD1 exit gate, in a process of its own.
 *
 * The exit-gate sentence is "a run created via REST SURVIVES APP RESTART". A daemon that lives in the
 * vitest process cannot witness that: it created the run, it still holds the row in a handle it opened
 * once, and asking it afterwards only proves it remembers what it just did. Restart survival is a
 * claim about a FRESH process reading the durable log off disk, so the daemon is spawned here, killed
 * with the app, and spawned again — the second one has never seen the run before.
 *
 * Two servers, both on loopback, both on an ephemeral port reported on stdout as one JSON line:
 *
 *   - `rest`    — the real `DaemonHttpServer`, serving `/v1/runs*` including the SSE tail.
 *   - `control` — `POST /append`, the only way a test in another process can put an event on THIS
 *     process's live tail. `A-46-2` fans a live tail out only within the process that appended, so an
 *     append made anywhere else would prove replay and never prove streaming.
 *
 * `WIGOLO_DATA_DIR` must already be in this process's env — it is read (and cached) the first time a
 * wigolo module resolves its config, which the imports below do.
 */
import { createServer } from 'node:http';
import { DaemonHttpServer } from 'wigolo/studio';
import { getDatabase } from '../../../../dist/cache/db.js';
import { appendRunEventWithTail } from '../../../../dist/studio/run-bus.js';

const rest = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
const restUrl = await rest.start();

const control = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/append') {
    res.writeHead(404).end('no');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const { runId, actor, type, payload } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      const event = appendRunEventWithTail(getDatabase(), runId, { actor, type, payload });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(event));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
    }
  });
});

await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));

process.stdout.write(
  `${JSON.stringify({ rest: Number(new URL(restUrl).port), control: control.address().port })}\n`,
);
