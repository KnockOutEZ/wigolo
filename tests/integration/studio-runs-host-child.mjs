/**
 * The live run-store OWNER, in a process of its own — the studio host half of SD1 mini-spec §6.
 *
 * It has to be a real second process. `getMyInstanceId()` is per-process state, so a host and a
 * proxying daemon sharing one process would both read the same answer and both take the same
 * branch; there would be no hop to test. And the fan-out claim is itself about process boundaries:
 * `run-bus.ts` publishes to subscribers in the process that appended, so an append made anywhere
 * else would prove REPLAY and never prove STREAMING (the same reasoning as A-50-1).
 *
 * Three servers, all loopback, all on ephemeral ports reported on stdout as one JSON line:
 *
 *   - `rest`    — the real `DaemonHttpServer`, bearer-authed, serving `/v1/runs*` incl. the SSE tail.
 *   - `control` — `POST /append`, the only way a test in another process can put an event on THIS
 *     process's live tail.
 *
 * It publishes the session handle naming ITSELF (`instanceId` set before the write, which is the
 * wiring order the self-reference guard defends), so this process serves its own store and the
 * daemon beside it proxies here.
 *
 * `WIGOLO_DATA_DIR` must already be in this process's env — it is read and cached the first time a
 * wigolo module resolves its config, which the imports below do.
 */
import { createServer } from 'node:http';
import { DaemonHttpServer } from '../../dist/daemon/http-server.js';
import { setMyInstanceId, writeHandle } from '../../dist/companion/handle.js';
import { getDatabase } from '../../dist/cache/db.js';
import { appendRunEventWithTail } from '../../dist/studio/run-bus.js';

const HOST_TOKEN = process.env.WIGOLO_TEST_HOST_TOKEN ?? 'host-secret-token';
const instanceId = `host-${process.pid}-${Date.now()}`;

// THE GATEWAY SHAPE, not the standalone-daemon one — `auth` set, `apiToken` left unset. That is
// what `startGateway` builds, and it is the only shape in which sd-87's defect exists: with
// `WIGOLO_API_TOKEN` exported (the parent suite exports a DECOY, deliberately different from
// HOST_TOKEN), an `apiToken` that defaulted to the environment would give the embedded REST router
// a different credential from the outer handle gate, and `/v1/runs*` would then accept NEITHER —
// the handle token 401'd by the router, the env token 401'd by the outer gate. Every row in the
// parent suite crosses this surface, so they all pin the single-credential rule; the explicit
// one-credential row states it directly.
const rest = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: { token: HOST_TOKEN, host: '127.0.0.1' } });
const restUrl = await rest.start();

// Order is the point: claim the identity, THEN publish the handle. Reversed, there is a window in
// which this process reads its own handle as a foreign host and proxies to itself.
setMyInstanceId(instanceId);
writeHandle({
  id: 'integration-session',
  endpoint: restUrl.replace(/\/+$/, ''),
  token: HOST_TOKEN,
  pid: process.pid,
  instanceId,
});

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
  `${JSON.stringify({
    rest: Number(new URL(restUrl).port),
    control: control.address().port,
    instanceId,
  })}\n`,
);
