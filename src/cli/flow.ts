/**
 * `wigolo flow` — inspect the flows recorded on this machine.
 *
 * WHY THERE IS NO `run` HERE, and it is a measurement rather than a scoping preference.
 *
 * An attended replay needs a session with a human watching it. This process has neither: `runStudio`
 * spawns the desktop app, and the daemon-side headless host is documented as surviving "only to back
 * tests; the app is the real session host". The two ways to give a terminal a live session are both
 * closed — exposing replay as an agent-facing tool was refused, and driving the existing tool surface
 * step by step would be a second dispatch lane, which the runner's whole safety story forbids (it must
 * call the action handler directly, so that it inherits that handler's gates rather than re-deriving
 * them).
 *
 * So `run` reports why it is absent instead of pretending to be a typo. What ships here is the half that
 * needs no session: a recording is worth having, and worth reading, before anything re-runs it.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { initDatabase, closeDatabase, getDatabase } from '../cache/db.js';
import { listFlows, listFlowSteps, type FlowStep, type FlowSummary } from '../studio/flow/store.js';
import { requiredSlots } from '../studio/flow/run.js';

const USAGE = `Usage: wigolo flow <list|show> [FLOW_ID] [--json]

  list                 Every flow recorded on this machine
  show FLOW_ID         The steps of one flow, in order

Flows are recorded while an agent drives a supervised Studio session. They stay on this
machine and are not exported.`;

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

/** One JSON document on stdout and nothing else — the house `--json` contract. */
function json(doc: unknown): void {
  process.stdout.write(`${JSON.stringify(doc)}\n`);
}

/** A step, shaped for display. Locator internals a reader cannot act on are left out. */
function stepView(s: FlowStep): Record<string, unknown> {
  return {
    seq: s.seq,
    action: s.action,
    ...(s.pageUrl !== undefined ? { page_url: s.pageUrl } : {}),
    ...(s.target ? { role: s.target.role, name: s.target.name } : {}),
    ...(s.slot !== undefined ? { slot: s.slot } : {}),
    ...(s.direction !== undefined ? { direction: s.direction } : {}),
    ...(s.amount !== undefined ? { amount: s.amount } : {}),
  };
}

function summaryWithSlots(db: ReturnType<typeof getDatabase>, f: FlowSummary): Record<string, unknown> {
  return {
    flow_id: f.flowId,
    session_id: f.sessionId,
    steps: f.steps,
    required_slots: requiredSlots(listFlowSteps(db, f.flowId)),
    first_ts: f.firstTs,
    last_ts: f.lastTs,
  };
}

function runList(asJson: boolean): number {
  const db = getDatabase();
  const flows = listFlows(db).map((f) => summaryWithSlots(db, f));
  if (asJson) {
    json({ flows });
    return 0;
  }
  if (flows.length === 0) {
    out('No flows recorded on this machine.');
    return 0;
  }
  for (const f of flows) {
    const slots = f.required_slots as string[];
    out(
      `${String(f.flow_id)}  session=${String(f.session_id)}  steps=${String(f.steps)}` +
        (slots.length > 0 ? `  slots=${slots.join(',')}` : ''),
    );
  }
  return 0;
}

function runShow(flowId: string | undefined, asJson: boolean): number {
  if (!flowId) {
    err('A flow id is required: wigolo flow show FLOW_ID');
    return 2;
  }
  const db = getDatabase();
  const steps = listFlowSteps(db, flowId);
  if (steps.length === 0) {
    err(`Flow not found: ${flowId}`);
    return 1;
  }
  const slots = requiredSlots(steps);
  if (asJson) {
    json({ flow_id: flowId, steps: steps.map(stepView), required_slots: slots });
    return 0;
  }
  out(`${flowId}  steps=${String(steps.length)}${slots.length > 0 ? `  slots=${slots.join(',')}` : ''}`);
  for (const s of steps) {
    const v = stepView(s);
    const bits = [`${String(s.seq).padStart(3)}.`, s.action];
    if (v.name !== undefined) bits.push(`"${String(v.name)}"`);
    if (v.slot !== undefined) bits.push(`slot=${String(v.slot)}`);
    if (v.page_url !== undefined) bits.push(String(v.page_url));
    out(`  ${bits.join(' ')}`);
  }
  return 0;
}

export async function runFlowCommand(args: string[]): Promise<number> {
  const asJson = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const sub = positional[0];

  // The reading subcommands own the cache lifecycle. Nothing upstream opens it for a one-shot command,
  // and reaching for `getDatabase()` without this throws "Database not initialized" as an unhandled
  // stack trace — which is what the first version of this command did, and what no unit test could see,
  // because the tests opened the database themselves in a fixture.
  if (sub === 'list' || sub === 'show') {
    const config = getConfig();
    mkdirSync(config.dataDir, { recursive: true });
    initDatabase(join(config.dataDir, 'wigolo.db'));
    try {
      return sub === 'list' ? runList(asJson) : runShow(positional[1], asJson);
    } finally {
      closeDatabase();
    }
  }

  switch (sub) {
    case 'run':
      // Answered with the reason, not with "unknown subcommand" — a user who expects this deserves to
      // learn why it is absent rather than go looking for the right spelling.
      err(
        'Replaying a flow is not available from the command line: a replay runs attended, and this ' +
          'process has no supervised session to run it in. Open the Studio app and re-run the flow there.',
      );
      return 2;
    default:
      err(USAGE);
      return 2;
  }
}
