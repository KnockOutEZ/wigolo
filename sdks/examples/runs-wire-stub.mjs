/**
 * A stand-in for the runs routes, for the SDK demos.
 *
 * The runs surface left this repository with the companion extraction — it is served by the
 * studio daemon, not by `wigolo serve` — so a demo run here needs something on the other end of
 * the socket. This is that: a real HTTP server speaking the documented wire (SD1 mini-spec 5,
 * SD2's message and driver routes), with real sockets, a real event stream and a real hang-up.
 *
 * It is a DEMO FIXTURE, not a second implementation of anything: it stores no run, projects no
 * status, and its "log" is a fixed script. Point the demos at a studio daemon instead by setting
 * WIGOLO_BASE_URL, and neither demo script changes.
 *
 *   node sdks/examples/runs-wire-stub.mjs [port]
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 8787);
const RUN_ID = '7fq2';

/** The scripted log this run replays. seq is 1-based, monotonic and gap-free. */
const LOG = [
  { type: 'run.created', payload: { task: 'compare three 27-inch monitors', spaceId: 'default', driver: { kind: 'sdk' } } },
  { type: 'tab.attached', payload: { tabId: 'tab-1', url: 'https://example.com/monitors' } },
  { type: 'cost.recorded', payload: { kind: 'browser_action', amount: 3 } },
  { type: 'message.queued', payload: { messageId: 'm1', text: 'check the second tab too', from: { kind: 'human' } } },
  { type: 'decision.requested', payload: { decisionId: 'd1', kind: 'approval', prompt: 'Add this monitor to the cart?', anchor: { tabId: 'tab-1', mark: 4 }, requestedAt: new Date().toISOString() } },
  { type: 'driver.changed', payload: { from: { kind: 'sdk' }, to: { kind: 'human' }, cause: 'takeover', reason: 'human took control' } },
  // A type no shipped SDK knows. It must reach onEvent and nothing else, and must not throw.
  { type: 'holodeck.engaged', payload: { deck: 3 } },
  { type: 'run.completed', payload: { outcome: 'three candidates shortlisted' } },
];

/** Cut the FIRST connection here, mid-frame, so the demo exercises resume rather than claiming it. */
const CUT_AFTER_SEQ = 3;
let connections = 0;

function envelope(index) {
  const seq = index + 1;
  return {
    seq,
    ts: new Date(Date.UTC(2026, 7, 22, 14, 3, 10 + seq)).toISOString(),
    actor: { kind: LOG[index].type === 'message.queued' ? 'human' : 'agent', driver: 'sdk' },
    type: LOG[index].type,
    payload: LOG[index].payload,
  };
}

function frame(index) {
  const event = envelope(index);
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function runObject() {
  return {
    id: RUN_ID,
    task: 'compare three 27-inch monitors',
    spaceId: 'default',
    createdAt: '2026-08-22T14:03:11.000Z',
    status: 'running',
    driver: { kind: 'sdk', client: { name: 'demo', version: '1.0' } },
    tabIds: ['tab-1'],
    pendingDecisions: [],
    cost: { browserActions: 3, tokensIn: 0, tokensOut: 0, spendUsd: 0 },
    visibility: 'hidden',
    lastSeq: LOG.length,
    updatedAt: '2026-08-22T14:03:18.000Z',
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);

  if (req.method === 'POST' && url.pathname === '/v1/runs') {
    await readBody(req);
    json(res, 201, { ok: true, run: runObject() });
    return;
  }

  if (req.method === 'GET' && segments.length === 3 && segments[1] === 'runs') {
    json(res, 200, { ok: true, run: runObject() });
    return;
  }

  if (req.method === 'POST' && segments[3] === 'messages') {
    const body = await readBody(req);
    // 202, not 200: the honesty rule in the status line. Accepted, and nothing delivered.
    json(res, 202, {
      ok: true,
      message: {
        message_id: body.message_id ?? 'm-demo',
        text: body.text ?? '',
        from: { kind: 'human' },
        queued_at: new Date().toISOString(),
        queued_at_step: LOG.length,
        state: 'queued',
        state_line: 'queued — reaches the agent at its next tool call',
      },
    });
    return;
  }

  if (req.method === 'POST' && segments[3] === 'driver') {
    const body = await readBody(req);
    json(res, 200, {
      ok: true,
      run: runObject(),
      events: [],
      ...(body.gesture === 'request' ? { requestId: 'wr-1' } : {}),
    });
    return;
  }

  if (req.method === 'GET' && segments[3] === 'events') {
    const header = req.headers['last-event-id'];
    const since = Number(Array.isArray(header) ? header[0] : header ?? url.searchParams.get('since') ?? 0) || 0;
    connections += 1;
    const isFirst = connections === 1;
    process.stdout.write(
      `[stub] connection ${connections}: Last-Event-ID=${since || '(none)'}\n`,
    );

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close',
    });
    res.write('retry: 500\n\n');

    // Paced, because a run emits over time and because a socket destroyed in the same tick as
    // its last write can drop that write on the floor before the client ever decodes it — which
    // would make the demo show a full replay rather than a resume.
    let index = since;
    const tick = () => {
      if (res.destroyed) return;
      if (index >= LOG.length) return; // the daemon never closes the stream on its own
      const seq = index + 1;
      if (isFirst && seq > CUT_AFTER_SEQ) {
        // Hang up mid-frame, exactly as a dropped socket leaves it.
        res.write(frame(index).slice(0, 20));
        setTimeout(() => res.destroy(), 30);
        return;
      }
      // Strictly greater than `since` — the resume contract, server side.
      res.write(frame(index));
      index += 1;
      setTimeout(tick, 30);
    };
    tick();
    return;
  }

  json(res, 404, { ok: false, error: 'not found', error_reason: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`[stub] runs wire stub on http://127.0.0.1:${PORT} (run ${RUN_ID})\n`);
});
