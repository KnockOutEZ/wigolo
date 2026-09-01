import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowNetworkInThisFile } from '../net-fence.js';

allowNetworkInThisFile(
  'boots a real DaemonHttpServer; its background search-backend bootstrap may egress, the run assertions do not',
);

/**
 * §7 row 1 END TO END — "human edits a page mid-run → invalidate the snapshot; the next result says
 * `page changed by human — re-read`".
 *
 * WHY AN INTEGRATION ROW: the unit tests each prove one seam, and each of them would still pass if
 * the seams were wired to DIFFERENT holders — the observer to one, the human-input path to another
 * — which is precisely the bug that would make the feature inert in a real host. This row runs the
 * whole scene through ONE holder: the real `SessionController` takes the human's keystroke, the
 * real `createActHandler` refuses the mark the agent was holding, the real `createObserver` returns
 * the fresh page, and the invalidation reaches a REAL SSE client over a REAL socket — the surface
 * law 1 says every other projection has to agree with.
 */

let dataDir: string;
let daemon: import('../../src/daemon/http-server.js').DaemonHttpServer;
let port: number;
let db: import('better-sqlite3').Database;

interface SseFrame { id?: string; event?: string; data?: string }

class SseReader {
  frames: SseFrame[] = [];
  private buffer = '';
  private req?: http.ClientRequest;
  private waiters: Array<() => void> = [];

  open(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.req = http.request(
        { hostname: '127.0.0.1', port, method: 'GET', path, headers: { Accept: 'text/event-stream' } },
        (res) => {
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => { this.buffer += chunk; this.drain(); });
          resolve();
        },
      );
      this.req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
      });
      this.req.end();
    });
  }

  private drain(): void {
    let idx = this.buffer.indexOf('\n\n');
    while (idx !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      if (!raw.startsWith(':')) {
        const frame: SseFrame = {};
        for (const line of raw.split('\n')) {
          const sep = line.indexOf(':');
          if (sep === -1) continue;
          const key = line.slice(0, sep);
          const value = line.slice(sep + 1).replace(/^ /, '');
          if (key === 'id') frame.id = value;
          else if (key === 'event') frame.event = value;
          else if (key === 'data') frame.data = value;
        }
        if (frame.id !== undefined || frame.data !== undefined) this.frames.push(frame);
      }
      idx = this.buffer.indexOf('\n\n');
    }
    for (const w of this.waiters.splice(0)) w();
  }

  async waitForEvent(type: string, timeoutMs = 5000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.find((f) => f.event === type);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`no \`${type}\` frame; saw ${JSON.stringify(this.frames.map((f) => f.event))}`);
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, 25);
        this.waiters.push(() => { clearTimeout(t); r(); });
      });
    }
  }

  kill(): void { this.req?.destroy(); }
}

function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        let text = '';
        res.setEncoding('utf-8');
        res.on('data', (c: string) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-snapshot-invalidated-'));
  process.env.WIGOLO_DATA_DIR = dataDir;
  delete process.env.WIGOLO_API_TOKEN;
  delete process.env.WIGOLO_API_TOKEN_FILE;

  const { DaemonHttpServer } = await import('../../src/daemon/http-server.js');
  daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
  port = parseInt(new URL(await daemon.start()).port, 10);
  const { getDatabase } = await import('../../src/cache/db.js');
  db = getDatabase();
}, 60000);

afterAll(async () => {
  await daemon?.stop();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.WIGOLO_DATA_DIR;
});

describe('§7 row 1 — a human page edit, end to end', () => {
  it('the agent is told the page changed, refused the stale mark, and re-reads the human’s text — and the run stream carries the invalidation', async () => {
    const { HeldSnapshot, snapshotInvalidatedEvent } = await import('../../src/studio/perception/held-snapshot.js');
    const { appendRunEventWithTail } = await import('../../src/studio/run-bus.js');
    const { buildSnapshot } = await import('../../src/studio/perception/snapshot.js');
    const { createObserver } = await import('../../src/studio/observe.js');
    const { createActHandler } = await import('../../src/studio/act.js');
    const { StudioEventQueue } = await import('../../src/studio/event-queue.js');
    const { SessionController } = await import('../../src/studio/session-control.js');
    const { ControlToken } = await import('../../src/studio/control-token.js');
    const { isStudioToolError } = await import('../../src/daemon/studio-dispatch.js');

    const created = await post('/v1/runs', { task: 'book the 9am slot' });
    expect(created.status).toBe(201);
    const runId = (created.body as { run: { id: string } }).run.id;

    const stream = new SseReader();
    await stream.open(`/v1/runs/${runId}/events`);

    // THE ONE HOLDER. Its invalidations go straight into the run log, which is what puts them on
    // every projection — the SSE tail below included — with no second source of truth.
    const held = new HeldSnapshot({
      tabId: 'tab-1',
      onInvalidated: (i) => { appendRunEventWithTail(db, runId, snapshotInvalidatedEvent(i)); },
    });

    // A tiny live "page" the human can type into. Two AX/DOM nodes to start; the human's keystroke
    // adds the third, so the agent's re-read has something only a human could have put there.
    let page = [
      { be: 10, role: 'textbox', name: 'Guest name' },
      { be: 11, role: 'button', name: 'Book' },
    ];
    const livePage = () => {
      const axNodes = page.map((s) => ({ ignored: false, role: { value: s.role }, name: { value: s.name }, backendDOMNodeId: s.be }));
      const root = {
        backendNodeId: 1,
        localName: 'html',
        children: [{ backendNodeId: 2, localName: 'body', children: page.map((s) => ({ backendNodeId: s.be, localName: s.role === 'textbox' ? 'input' : 'button', attributes: [] })) }],
      };
      return buildSnapshot(axNodes, root, { tokenBudget: 4000 });
    };

    const observe = createObserver({
      snapshot: async () => livePage(),
      eventQueue: new StudioEventQueue(100),
      inlineBudget: 100000,
      spillMaxBytes: 10_000_000,
      dataDir,
      held,
    });

    const dispatched: string[] = [];
    const act = createActHandler({
      browser: { navigate: async () => {} },
      controlToken: { holder: 'agent', epoch: 1, assertCanDrive: () => ({ ok: true }) },
      grant: { allowPrivate: false } as never,
      resolve: async () => ({ backendNodeId: 11, center: { x: 4, y: 5 } }),
      channel: { dispatchAgentUnit: async () => { dispatched.push('unit'); return true; }, viewportCenter: () => ({ x: 0, y: 0 }) },
      held,
    });

    const controller = new SessionController(new ControlToken(), {
      key: async () => {}, neutralizeHeld: async () => {}, agentMouseAt: async () => {}, viewportCenter: () => ({ x: 0, y: 0 }),
    }, () => {}, held);

    const transcript: string[] = [];

    // 1. The agent reads the page and picks a mark.
    const first = await observe({});
    if (isStudioToolError(first)) throw new Error(first.error_reason);
    const bookRef = (first.elements as Array<{ ref: string; name: string }>).find((e) => e.name === 'Book')!.ref;
    transcript.push(`agent  studio_observe        → ${first.kind} snapshot ${first.id}, ${(first.elements as unknown[]).length} elements; holding ref ${bookRef} ("Book")`);

    // 2. The human types into the page. Real keystroke, real controller, real page mutation.
    page = [...page, { be: 12, role: 'textbox', name: 'Ada Lovelace — typed by the human' }];
    const invalidated = controller.humanInput('key');
    transcript.push(`human  types into the page   → SessionController.humanInput('key') invalidated the held snapshot: ${invalidated}`);

    // 3. The agent's next act on the mark it was holding is refused, in §7 row 1's words.
    const refused = await act({ action: 'click', ref: bookRef });
    expect(isStudioToolError(refused)).toBe(true);
    const err = refused as { error_reason: string; hint: string };
    expect(err.error_reason).toBe('page_changed_by_human');
    expect(err.hint).toContain('page changed by human — re-read');
    expect(dispatched).toEqual([]); // the click never reached the page
    transcript.push(`agent  studio_act click ${bookRef}   → REFUSED ${err.error_reason}: ${err.hint}`);

    // 4. The re-read announces the change and carries what the human typed.
    const second = await observe({ base_id: first.id });
    if (isStudioToolError(second)) throw new Error(second.error_reason);
    const notice = second.events.find((e) => e.type === 'page_changed');
    expect(notice).toMatchObject({ by: 'human', cause: 'input', notice: 'page changed by human — re-read' });
    expect(second.kind).toBe('full');
    expect(JSON.stringify(second.elements)).toContain('typed by the human');
    transcript.push(`agent  studio_observe        → ${JSON.stringify(notice)}`);
    transcript.push(`agent  studio_observe        → ${second.kind} snapshot ${second.id}; elements now include "Ada Lovelace — typed by the human"`);

    // 5. The same fact reached a real SSE client over a real socket.
    const frame = await stream.waitForEvent('snapshot.invalidated');
    expect(JSON.parse(frame.data ?? '{}')).toMatchObject({
      type: 'snapshot.invalidated',
      actor: { kind: 'human' },
      payload: { tabId: 'tab-1', by: 'human', cause: 'input' },
    });
    transcript.push(`sse    GET /v1/runs/${runId}/events → id: ${frame.id}  event: ${frame.event}  data: ${frame.data}`);

    // 6. And the act the agent retries AFTER re-reading goes through.
    const retried = await act({ action: 'click', ref: bookRef });
    expect(isStudioToolError(retried)).toBe(false);
    expect(dispatched).toEqual(['unit']);
    transcript.push(`agent  studio_act click ${bookRef}   → ok (the re-read cleared the refusal)`);

    stream.kill();
    if (process.env.WIGOLO_DEMO_TRANSCRIPT) writeFileSync(process.env.WIGOLO_DEMO_TRANSCRIPT, transcript.join('\n') + '\n');
  }, 60000);
});
