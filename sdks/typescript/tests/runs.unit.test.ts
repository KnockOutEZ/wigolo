import { describe, it, expect } from 'vitest';
import { WigoloClient, type FetchLike } from '../src/client.js';
import { Runs, parseRunEvent, type RunEvent, type RunsTransport } from '../src/runs.js';
import { LAST_EVENT_ID_HEADER } from '../src/sse.js';

// ---- envelopes, in the shape the daemon actually sends -------------------------------------

function frame(seq: number, type: string, payload: Record<string, unknown> = {}): string {
  const envelope = {
    seq,
    ts: `2026-08-22T14:03:${String(10 + seq).padStart(2, '0')}.000Z`,
    actor: { kind: 'agent', driver: 'cli' },
    type,
    payload,
  };
  return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

const MESSAGE_QUEUED = (seq: number) =>
  frame(seq, 'message.queued', {
    messageId: `m${seq}`,
    text: 'check the second tab',
    from: { kind: 'human' },
  });

const DECISION_REQUESTED = (seq: number) =>
  frame(seq, 'decision.requested', {
    decisionId: `d${seq}`,
    kind: 'approval',
    prompt: 'Submit this order?',
    anchor: { tabId: 't1', mark: 4 },
    requestedAt: '2026-08-22T14:03:20.000Z',
  });

const DRIVER_CHANGED = (seq: number, cause: string) =>
  frame(seq, 'driver.changed', {
    from: { kind: 'cli' },
    to: { kind: 'human' },
    cause,
    reason: 'human took control',
  });

// ---- a transport that replays scripted streams ---------------------------------------------

interface Connection {
  headers: Record<string, string>;
  path: string;
}

/**
 * Each element of `streams` is one connection's worth of chunks. When a connection's chunks run
 * out the stream ENDS — which is exactly what a dropped socket looks like to the client, and is
 * how the resume path is exercised without killing a real socket.
 */
function scriptedTransport(streams: string[][], requests: unknown[] = []) {
  const connections: Connection[] = [];
  let index = 0;
  const transport: RunsTransport = {
    request: async <T,>(method: string, path: string, body: unknown): Promise<T> => {
      requests.push({ method, path, body });
      return (requests[requests.length - 1] as { response?: T }).response as T;
    },
    stream: (path, headers) => {
      connections.push({ path, headers: { ...headers } });
      const chunks = streams[index] ?? [];
      index += 1;
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
  return { transport, connections, connectionCount: () => index };
}

async function collect(
  iterator: AsyncGenerator<RunEvent>,
  count: number,
): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of iterator) {
    out.push(event);
    if (out.length >= count) break;
  }
  return out;
}

describe('parseRunEvent — forward compatibility', () => {
  it('parses a complete envelope', () => {
    const event = parseRunEvent(
      '{"seq":7,"ts":"t","actor":{"kind":"human"},"type":"tab.attached","payload":{"tabId":"a"}}',
    );
    expect(event).toEqual({
      seq: 7,
      ts: 't',
      actor: { kind: 'human' },
      type: 'tab.attached',
      payload: { tabId: 'a' },
    });
  });

  it('accepts a type this SDK has never heard of', () => {
    const event = parseRunEvent('{"seq":1,"ts":"t","actor":{"kind":"daemon"},"type":"quantum.entangled","payload":{}}');
    expect(event?.type).toBe('quantum.entangled');
  });

  it('accepts unknown FIELDS on the envelope without dropping the event', () => {
    const event = parseRunEvent(
      '{"seq":1,"ts":"t","actor":{"kind":"daemon"},"type":"x.y","payload":{},"future":"data"}',
    );
    expect(event?.seq).toBe(1);
  });

  it('drops a frame that is not JSON rather than throwing', () => {
    expect(parseRunEvent('not json at all')).toBeUndefined();
  });

  it('drops a frame with no seq — ordering is built on it', () => {
    expect(parseRunEvent('{"ts":"t","type":"x.y","payload":{}}')).toBeUndefined();
  });

  it('drops a frame with no type — dispatch is built on it', () => {
    expect(parseRunEvent('{"seq":1,"ts":"t","payload":{}}')).toBeUndefined();
  });

  it('substitutes defaults for a missing actor and payload rather than dropping the event', () => {
    const event = parseRunEvent('{"seq":2,"type":"x.y"}');
    expect(event).toEqual({ seq: 2, ts: '', actor: { kind: 'system' }, type: 'x.y', payload: {} });
  });
});

describe('runs.events — streaming and resume', () => {
  it('yields envelopes in seq order from one connection', async () => {
    const { transport } = scriptedTransport([[frame(1, 'run.created'), frame(2, 'tab.attached')]]);
    const events = await collect(new Runs(transport).events('7fq2', { reconnect: false }), 2);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => e.type)).toEqual(['run.created', 'tab.attached']);
  });

  it('survives a dropped stream and resumes gapless — seq continuity asserted', async () => {
    // Connection 1 delivers 1..3 and then dies mid-frame: the bytes of seq 4 arrive without
    // their terminating blank line, exactly as a socket cut would leave them.
    const dropped = frame(4, 'tab.attached').slice(0, -6);
    const { transport, connections } = scriptedTransport([
      [frame(1, 'run.created'), frame(2, 'tab.attached'), frame(3, 'cost.recorded'), dropped],
      [frame(4, 'tab.attached'), frame(5, 'run.completed')],
    ]);

    const events = await collect(
      new Runs(transport).events('7fq2', { reconnectDelayMs: 0 }),
      5,
    );

    // No gap, no duplicate, no rewind: 1,2,3,4,5 across two connections.
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    // The half-delivered seq 4 was NOT counted as delivered — the reconnect asks for >3, and the
    // server's re-send of 4 is the first thing the second connection yields.
    expect(connections).toHaveLength(2);
    expect(connections[0].headers[LAST_EVENT_ID_HEADER]).toBeUndefined();
    expect(connections[1].headers[LAST_EVENT_ID_HEADER]).toBe('3');
  });

  it('drops a duplicate the server re-sent rather than yielding it twice', async () => {
    // The second connection replays 3 (which the client already has) before continuing.
    const { transport } = scriptedTransport([
      [frame(1, 'run.created'), frame(2, 'tab.attached'), frame(3, 'cost.recorded')],
      [frame(3, 'cost.recorded'), frame(4, 'run.completed')],
    ]);
    const events = await collect(new Runs(transport).events('7fq2', { reconnectDelayMs: 0 }), 4);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('starts from an explicit since, sending it as the resume header', async () => {
    const { transport, connections } = scriptedTransport([[frame(41, 'run.completed')]]);
    await collect(new Runs(transport).events('7fq2', { since: 40, reconnect: false }), 1);
    expect(connections[0].headers[LAST_EVENT_ID_HEADER]).toBe('40');
  });

  it('stops reconnecting after maxReconnects when nothing is being delivered', async () => {
    const { transport, connectionCount } = scriptedTransport([[], [], [], [], []]);
    const events = await collect(
      new Runs(transport).events('7fq2', { reconnectDelayMs: 0, maxReconnects: 2 }),
      99,
    );
    expect(events).toEqual([]);
    // The first connect plus two retries; the third failure ends it.
    expect(connectionCount()).toBe(3);
  });

  it('does not reconnect when reconnect is off', async () => {
    const { transport, connectionCount } = scriptedTransport([[frame(1, 'run.created')], []]);
    await collect(new Runs(transport).events('7fq2', { reconnect: false }), 1);
    expect(connectionCount()).toBe(1);
  });

  it('ignores a frame that is not an envelope and keeps streaming', async () => {
    const { transport } = scriptedTransport([
      [frame(1, 'run.created'), 'event: junk\ndata: {oops\n\n', frame(2, 'run.completed')],
    ]);
    const events = await collect(new Runs(transport).events('7fq2', { reconnect: false }), 2);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('ends when the caller aborts', async () => {
    const controller = new AbortController();
    const { transport } = scriptedTransport([[frame(1, 'run.created')], [frame(2, 'x.y')]]);
    const seen: number[] = [];
    for await (const event of new Runs(transport).events('7fq2', {
      signal: controller.signal,
      reconnectDelayMs: 0,
    })) {
      seen.push(event.seq);
      controller.abort();
    }
    expect(seen).toEqual([1]);
  });
});

describe('runs.watchRun — fan-out', () => {
  async function watchAll(streams: string[][]) {
    const { transport } = scriptedTransport(streams);
    const humanMessages: RunEvent[] = [];
    const approvals: RunEvent[] = [];
    const takeovers: RunEvent[] = [];
    const all: RunEvent[] = [];
    const watch = new Runs(transport).watchRun(
      '7fq2',
      {
        onHumanMessage: (e) => void humanMessages.push(e),
        onApproval: (e) => void approvals.push(e),
        onTakeover: (e) => void takeovers.push(e),
        onEvent: (e) => void all.push(e),
      },
      { reconnect: false },
    );
    await watch.done;
    return { humanMessages, approvals, takeovers, all, watch };
  }

  it('routes message.queued to onHumanMessage, with the real envelope', async () => {
    const { humanMessages } = await watchAll([[MESSAGE_QUEUED(4)]]);
    expect(humanMessages).toHaveLength(1);
    expect(humanMessages[0].type).toBe('message.queued');
    expect(humanMessages[0].payload.text).toBe('check the second tab');
  });

  it('routes decision.requested to onApproval, anchor intact', async () => {
    const { approvals } = await watchAll([[DECISION_REQUESTED(6)]]);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].payload.anchor).toEqual({ tabId: 't1', mark: 4 });
  });

  it('routes driver.changed {cause: takeover} to onTakeover', async () => {
    const { takeovers } = await watchAll([[DRIVER_CHANGED(9, 'takeover')]]);
    expect(takeovers).toHaveLength(1);
    expect(takeovers[0].payload.reason).toBe('human took control');
  });

  it('does NOT fire onTakeover for a grant or a release — the cause is the distinction', async () => {
    const { takeovers, all } = await watchAll([
      [DRIVER_CHANGED(1, 'grant'), DRIVER_CHANGED(2, 'release')],
    ]);
    expect(takeovers).toEqual([]);
    // Both still reached the tap, so nothing was silently swallowed.
    expect(all.map((e) => e.payload.cause)).toEqual(['grant', 'release']);
  });

  it('delivers every envelope to onEvent, known types included', async () => {
    const { all } = await watchAll([
      [MESSAGE_QUEUED(1), DECISION_REQUESTED(2), DRIVER_CHANGED(3, 'takeover')],
    ]);
    expect(all.map((e) => e.type)).toEqual([
      'message.queued',
      'decision.requested',
      'driver.changed',
    ]);
  });

  it('ignores a future event type: it reaches onEvent only, and nothing throws', async () => {
    const { humanMessages, approvals, takeovers, all } = await watchAll([
      [frame(1, 'holodeck.engaged', { deck: 3 }), frame(2, 'message.queued', { text: 'hi' })],
    ]);
    expect(humanMessages.map((e) => e.seq)).toEqual([2]);
    expect(approvals).toEqual([]);
    expect(takeovers).toEqual([]);
    expect(all.map((e) => e.type)).toEqual(['holodeck.engaged', 'message.queued']);
  });

  it('ignores a future type entirely when no onEvent is supplied', async () => {
    const { transport } = scriptedTransport([[frame(1, 'holodeck.engaged')]]);
    const errors: unknown[] = [];
    const watch = new Runs(transport).watchRun(
      '7fq2',
      { onHumanMessage: () => undefined, onError: (e) => void errors.push(e) },
      { reconnect: false },
    );
    await watch.done;
    expect(errors).toEqual([]);
  });

  it('keeps watching when a callback throws, reporting it to onError', async () => {
    const { transport } = scriptedTransport([[MESSAGE_QUEUED(1), MESSAGE_QUEUED(2)]]);
    const seen: number[] = [];
    const errors: unknown[] = [];
    const watch = new Runs(transport).watchRun(
      '7fq2',
      {
        onHumanMessage: (e) => {
          seen.push(e.seq);
          throw new Error(`handler exploded on ${e.seq}`);
        },
        onError: (err) => void errors.push(err),
      },
      { reconnect: false },
    );
    await watch.done;
    // The second event was still delivered: a watcher killed by its own handler would stop
    // projecting a run that is still going.
    expect(seen).toEqual([1, 2]);
    expect(errors).toHaveLength(2);
  });

  it('awaits async callbacks before moving on', async () => {
    const { transport } = scriptedTransport([[MESSAGE_QUEUED(1), MESSAGE_QUEUED(2)]]);
    const order: string[] = [];
    const watch = new Runs(transport).watchRun(
      '7fq2',
      {
        onHumanMessage: async (e) => {
          order.push(`start ${e.seq}`);
          await Promise.resolve();
          order.push(`end ${e.seq}`);
        },
      },
      { reconnect: false },
    );
    await watch.done;
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('tracks lastSeq so a caller can restart the watch where it stopped', async () => {
    const { transport } = scriptedTransport([[frame(11, 'run.created'), frame(12, 'x.y')]]);
    const watch = new Runs(transport).watchRun('7fq2', {}, { reconnect: false });
    await watch.done;
    expect(watch.lastSeq).toBe(12);
  });

  it('stop() ends the watch and is idempotent', async () => {
    const { transport } = scriptedTransport([[MESSAGE_QUEUED(1)], [MESSAGE_QUEUED(2)]]);
    const seen: number[] = [];
    const watch = new Runs(transport).watchRun(
      '7fq2',
      {
        onHumanMessage: (e) => {
          seen.push(e.seq);
          watch.stop();
          watch.stop();
        },
      },
      { reconnectDelayMs: 0 },
    );
    await watch.done;
    expect(seen).toEqual([1]);
  });
});

describe('runs — request methods over the REST seam', () => {
  function jsonClient(handler: (req: { method: string; url: string; body?: string }) => unknown) {
    const calls: { method: string; url: string; body?: string; headers: Record<string, string> }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ method: init.method, url, body: init.body, headers: init.headers });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(handler({ method: init.method, url, body: init.body })),
      };
    };
    return { client: new WigoloClient({ fetch: fetchImpl, baseUrl: 'http://d' }), calls };
  }

  const RUN = {
    id: '7fq2',
    task: 'find three monitors',
    spaceId: 'default',
    createdAt: 'now',
    status: 'running',
    driver: { kind: 'api' },
    tabIds: [],
    pendingDecisions: [],
    cost: { browserActions: 0, tokensIn: 0, tokensOut: 0, spendUsd: 0 },
    visibility: 'hidden',
    lastSeq: 1,
    updatedAt: 'now',
  };

  it('create POSTs the task and unwraps the run', async () => {
    const { client, calls } = jsonClient(() => ({ ok: true, run: RUN }));
    const run = await client.runs.create({ task: 'find three monitors' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://d/v1/runs' });
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ task: 'find three monitors' });
    expect(run.id).toBe('7fq2');
  });

  it('get encodes the run id into the path', async () => {
    const { client, calls } = jsonClient(() => ({ ok: true, run: RUN }));
    await client.runs.get('a/b');
    expect(calls[0].url).toBe('http://d/v1/runs/a%2Fb');
  });

  it('list serialises a status array as the comma-list the route expects', async () => {
    const { client, calls } = jsonClient(() => ({ ok: true, runs: [RUN], next_cursor: 'MjA' }));
    const page = await client.runs.list({ status: ['running', 'needs_you'], limit: 10 });
    expect(calls[0].url).toBe('http://d/v1/runs?status=running%2Cneeds_you&limit=10');
    expect(page.nextCursor).toBe('MjA');
    expect(page.runs).toHaveLength(1);
  });

  it('list omits the query string entirely when nothing was asked for', async () => {
    const { client, calls } = jsonClient(() => ({ ok: true, runs: [] }));
    const page = await client.runs.list();
    expect(calls[0].url).toBe('http://d/v1/runs');
    expect(page.nextCursor).toBeUndefined();
  });

  it('sendMessage sends the wire spelling of the idempotency key and returns state_line', async () => {
    const { client, calls } = jsonClient(() => ({
      ok: true,
      message: {
        message_id: 'm1',
        text: 'hi',
        from: { kind: 'human' },
        queued_at: 'now',
        queued_at_step: 12,
        state: 'queued',
        state_line: 'queued — reaches the agent at its next tool call',
      },
      replayed: true,
    }));
    const result = await client.runs.sendMessage('7fq2', { text: 'hi', messageId: 'm1' });
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ text: 'hi', message_id: 'm1' });
    expect(calls[0].url).toBe('http://d/v1/runs/7fq2/messages');
    // Law 7 on the wire: the SDK returns the honest state line rather than composing its own.
    expect(result.message.state_line).toBe('queued — reaches the agent at its next tool call');
    expect(result.replayed).toBe(true);
  });

  it('driverGesture posts the gesture verbatim and defaults events to an empty list', async () => {
    const { client, calls } = jsonClient(() => ({ ok: true, run: RUN }));
    const result = await client.runs.driverGesture('7fq2', {
      gesture: 'request',
      by: { kind: 'sdk', client: { name: 'acme', version: '1.0' } },
      reason: 'I can finish this',
    });
    expect(calls[0].url).toBe('http://d/v1/runs/7fq2/driver');
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({
      gesture: 'request',
      by: { kind: 'sdk', client: { name: 'acme', version: '1.0' } },
      reason: 'I can finish this',
    });
    // Empty is the honest answer for a gesture that was a no-op.
    expect(result.events).toEqual([]);
  });

  it('sends the bearer token on the event stream', async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init.headers);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '',
        body: (async function* () {
          yield new TextEncoder().encode(frame(1, 'run.created'));
        })(),
      };
    };
    const client = new WigoloClient({ fetch: fetchImpl, baseUrl: 'http://d', token: 'sekret' });
    await collect(client.runs.events('7fq2', { reconnect: false }), 1);
    expect(seen[0].Authorization).toBe('Bearer sekret');
    expect(seen[0].Accept).toBe('text/event-stream');
  });

  it('reads a ReadableStream body, decoding chunks that split a multi-byte character', async () => {
    const bytes = new TextEncoder().encode(frame(1, 'run.created', { note: 'café ✅' }));
    // Split mid-character on purpose: decoding each half independently would corrupt the JSON.
    const cut = bytes.length - 12;
    const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
    let i = 0;
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length ? { done: false, value: chunks[i++] } : { done: true },
          cancel: async () => undefined,
        }),
      },
    });
    const client = new WigoloClient({ fetch: fetchImpl, baseUrl: 'http://d' });
    const events = await collect(client.runs.events('7fq2', { reconnect: false }), 1);
    expect(events[0].payload.note).toBe('café ✅');
  });

  it('explains itself when the runtime gives no streaming body', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
    });
    const client = new WigoloClient({ fetch: fetchImpl, baseUrl: 'http://d' });
    await expect(
      collect(client.runs.events('7fq2', { reconnect: false }), 1),
    ).rejects.toThrow(/no readable body/);
  });
});
