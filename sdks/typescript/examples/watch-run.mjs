/**
 * Drive one run from the TypeScript SDK: create it, watch it, answer it.
 *
 *   node sdks/examples/runs-wire-stub.mjs &
 *   node sdks/typescript/examples/watch-run.mjs
 *
 * Point it at a studio daemon instead with WIGOLO_BASE_URL / WIGOLO_API_TOKEN; nothing in this
 * file changes. Run it from the repo root after `npm run build --prefix sdks/typescript`.
 */
import { WigoloClient } from '../dist/index.js';

const client = new WigoloClient({
  baseUrl: process.env.WIGOLO_BASE_URL ?? 'http://127.0.0.1:8787',
});

const run = await client.runs.create({
  task: 'compare three 27-inch monitors',
  driver: { kind: 'sdk', client: { name: 'demo', version: '1.0' } },
});
console.log(`run ${run.id} — ${run.status} — driver ${run.driver.kind}`);

const watch = client.runs.watchRun(
  run.id,
  {
    onHumanMessage: (event) => {
      console.log(`  [human]    seq ${event.seq}: ${event.payload.text}`);
    },
    onApproval: async (event) => {
      const anchor = event.payload.anchor;
      console.log(
        `  [approval] seq ${event.seq}: ${event.payload.prompt} ` +
          `(anchored to mark ${anchor?.mark} on ${anchor?.tabId})`,
      );
    },
    onTakeover: (event) => {
      console.log(`  [takeover] seq ${event.seq}: ${event.payload.reason}`);
    },
    onEvent: (event) => {
      console.log(`  [event]    seq ${event.seq}: ${event.type}`);
      if (event.type === 'run.completed') watch.stop();
    },
    onError: (err) => console.log(`  [error]    ${err}`),
  },
  { reconnectDelayMs: 100 },
);

// A message is QUEUED, never sent. The server's own state line says so and we print it verbatim.
const queued = await client.runs.sendMessage(run.id, { text: 'prefer 120Hz panels' });
console.log(`message ${queued.message.message_id}: ${queued.message.state_line}`);

// Request-the-wheel is a gesture, never a race.
const gesture = await client.runs.driverGesture(run.id, {
  gesture: 'request',
  by: { kind: 'sdk', client: { name: 'demo', version: '1.0' } },
  reason: 'I can finish the comparison',
});
console.log(`wheel requested — requestId ${gesture.requestId}, events ${gesture.events.length}`);

await watch.done;
console.log(`watch stopped at seq ${watch.lastSeq}`);
