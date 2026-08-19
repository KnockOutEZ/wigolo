/**
 * S13-2 — the attended runner. Unit arm: the act handler and the candidate set are injected, so these
 * cases measure the RUNNER's decisions. The envelope's own gates are exercised against the real act
 * handler in `tests/integration/studio-flow-g3.test.ts`.
 *
 * Every halt asserted here also asserts that **nothing was dispatched after it** — a runner that logged a
 * divergence and carried on would be acting on a page it has already failed to recognise, and a test
 * that only checked the halt REASON would pass against exactly that runner.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { runFlow, MAX_REPLAY_STEPS } from '../../../../src/studio/flow/run.js';
import type { FlowStep, FlowTargetSeed } from '../../../../src/studio/flow/store.js';
import type { HealCandidate } from '../../../../src/studio/mark/heal.js';
import { computeFingerprint } from '../../../../src/studio/perception/id.js';
import type { StudioActInput } from '../../../../src/daemon/studio-dispatch.js';

function seed(over: Partial<FlowTargetSeed> = {}): FlowTargetSeed {
  const role = over.role ?? 'button';
  const name = over.name ?? 'Next page';
  const attrs = over.attrs ?? { type: 'button' };
  return {
    role,
    name,
    fingerprint: over.fingerprint ?? computeFingerprint({ role, name, attrs }),
    ancestorPath: over.ancestorPath ?? 'html/body/main/nav',
    attrs,
  };
}

function step(over: Partial<FlowStep> = {}): FlowStep {
  return {
    flowId: 'flw_run',
    sessionId: 's1',
    seq: 1,
    auditSeq: 1,
    action: 'click',
    pageUrl: 'https://ex.com/orders',
    target: seed(),
    recordedRef: 'e-recorded',
    healTierAtRecord: 'high',
    ts: 1,
    ...over,
  };
}

function candidate(ref: string, over: Partial<FlowTargetSeed> = {}, backendNodeId = 1): HealCandidate {
  const s = seed(over);
  return { ref, target: { ...s, backendNodeId, trusted: false } };
}

/** An act handler that records what it was asked to do and can be told to refuse at a given call. */
function fakeAct(opts: { refuseAt?: number; reason?: string } = {}) {
  const calls: StudioActInput[] = [];
  let n = 0;
  const act = async (input: StudioActInput) => {
    n += 1;
    calls.push(input);
    if (opts.refuseAt === n) return { error_reason: opts.reason ?? 'parked_for_review' } as never;
    return { ok: true } as never;
  };
  return { act, calls };
}

describe('runFlow — a linear flow, dispatched through the act handler', () => {
  it('dispatches every step in seq order', async () => {
    const f = fakeAct();
    const r = await runFlow({
      steps: [
        step({ seq: 1, action: 'navigate', pageUrl: 'https://ex.com/a', target: undefined }),
        step({ seq: 2, action: 'click' }),
        step({ seq: 3, action: 'scroll', direction: 'down', amount: 400, target: undefined }),
      ],
      act: f.act,
      candidates: async () => [candidate('e-live')],
    });
    expect(r.ok).toBe(true);
    expect(r.dispatched.map((d) => d.seq)).toEqual([1, 2, 3]);
    expect(f.calls.map((c) => c.action)).toEqual(['navigate', 'click', 'scroll']);
  });

  it('runs in SEQ order even when handed the steps out of order', async () => {
    // The order is the artifact. A runner that trusted array order would replay a flow backwards given a
    // store read that changed its ORDER BY.
    const f = fakeAct();
    const r = await runFlow({
      steps: [
        step({ seq: 2, action: 'navigate', pageUrl: 'https://ex.com/second', target: undefined }),
        step({ seq: 1, action: 'navigate', pageUrl: 'https://ex.com/first', target: undefined }),
      ],
      act: f.act,
      candidates: async () => [],
    });
    expect(r.ok).toBe(true);
    expect(f.calls.map((c) => c.url)).toEqual(['https://ex.com/first', 'https://ex.com/second']);
  });

  it('passes the recorded url on a navigate and the direction+amount on a scroll', async () => {
    const f = fakeAct();
    await runFlow({
      steps: [
        step({ seq: 1, action: 'navigate', pageUrl: 'https://ex.com/x?q=1', target: undefined }),
        step({ seq: 2, action: 'scroll', direction: 'up', amount: 120, target: undefined }),
      ],
      act: f.act,
      candidates: async () => [],
    });
    expect(f.calls[0]).toEqual({ action: 'navigate', url: 'https://ex.com/x?q=1' });
    expect(f.calls[1]).toEqual({ action: 'scroll', direction: 'up', amount: 120 });
  });

  it('resolves the LIVE ref per step and never dispatches the recorded one', async () => {
    const f = fakeAct();
    await runFlow({
      steps: [step({ seq: 1, recordedRef: 'e-recorded' })],
      act: f.act,
      candidates: async () => [candidate('e-live-now')],
    });
    expect(f.calls[0]?.ref).toBe('e-live-now');
    expect(f.calls[0]?.ref).not.toBe('e-recorded');
  });

  it('re-resolves against a FRESH candidate set for every targeted step', async () => {
    // A click can navigate. Resolving once per run would target the second step against the first page's
    // snapshot — which is exactly the "page changed underneath" case the halt exists for.
    let built = 0;
    const f = fakeAct();
    await runFlow({
      steps: [step({ seq: 1 }), step({ seq: 2 }), step({ seq: 3, action: 'navigate', pageUrl: 'https://ex.com/z', target: undefined })],
      act: f.act,
      candidates: async () => { built += 1; return [candidate('e-live')]; },
    });
    expect(built).toBe(2); // the two targeted steps, not the navigate, and not once for the run
  });
});

describe('runFlow — first divergence halts, and NOTHING runs after it (§5.3, T13, G3-g)', () => {
  it('halts at step k of n and dispatches EXACTLY 0 steps after k', async () => {
    const f = fakeAct();
    let call = 0;
    const r = await runFlow({
      steps: [step({ seq: 1 }), step({ seq: 2 }), step({ seq: 3 }), step({ seq: 4 })],
      act: f.act,
      // The 3rd resolve finds nothing: a total miss.
      candidates: async () => (++call === 3 ? [] : [candidate('e-live')]),
    });
    expect(r.ok).toBe(false);
    expect(r.halt).toEqual({ atSeq: 3, reason: 'unresolved_target' });
    expect(r.dispatched.map((d) => d.seq)).toEqual([1, 2]);
    expect(f.calls).toHaveLength(2); // step 3 never dispatched, step 4 never reached
  });

  it('halts when the resolved role differs from the recorded role, without acting (G3-e)', async () => {
    const f = fakeAct();
    const impostor: HealCandidate = { ref: 'e-live', target: { ...seed(), role: 'link', backendNodeId: 1, trusted: false } };
    const r = await runFlow({ steps: [step()], act: f.act, candidates: async () => [impostor] });
    expect(r.halt?.reason).toBe('role_changed');
    expect(f.calls).toHaveLength(0);
  });

  it('halts on an AMBIGUOUS match without acting — never candidate[0] (G3-f, T7)', async () => {
    // The one failure that produces an automated click on a wrong element.
    const f = fakeAct();
    const r = await runFlow({
      steps: [step()],
      act: f.act,
      candidates: async () => [candidate('e-a'), candidate('e-b', {}, 2)],
    });
    expect(r.halt?.reason).toBe('ambiguous_target');
    expect(f.calls).toHaveLength(0);
  });

  it('halts on a total miss without acting (G3-f)', async () => {
    const f = fakeAct();
    const r = await runFlow({ steps: [step()], act: f.act, candidates: async () => [] });
    expect(r.halt?.reason).toBe('unresolved_target');
    expect(f.calls).toHaveLength(0);
  });

  it('halts and SURFACES the act handler\'s own typed refusal rather than inventing one', async () => {
    // Every typed refusal exists to stop an agent; a runner that stepped over one would be a bypass. The
    // reason travels so the caller learns WHICH gate fired.
    const f = fakeAct({ refuseAt: 2, reason: 'origin_budget_exhausted' });
    const r = await runFlow({
      steps: [step({ seq: 1 }), step({ seq: 2 }), step({ seq: 3 })],
      act: f.act,
      candidates: async () => [candidate('e-live')],
    });
    expect(r.halt).toEqual({ atSeq: 2, reason: 'act_refused', detail: 'origin_budget_exhausted' });
    expect(f.calls).toHaveLength(2); // step 3 never attempted
    expect(r.dispatched.map((d) => d.seq)).toEqual([1]);
  });

  it('treats a reclaim mid-run as the halt it is, dropping the next step (G3-i)', async () => {
    const f = fakeAct({ refuseAt: 2, reason: 'aborted_reclaimed' });
    const r = await runFlow({
      steps: [step({ seq: 1 }), step({ seq: 2 }), step({ seq: 3 })],
      act: f.act,
      candidates: async () => [candidate('e-live')],
    });
    expect(r.halt).toMatchObject({ atSeq: 2, reason: 'act_refused', detail: 'aborted_reclaimed' });
    expect(f.calls).toHaveLength(2);
  });
});

describe('runFlow — a degraded resolution RUNS and is reported (§5.3 as amended, A174)', () => {
  it('dispatches a step that resolved below its recorded tier, carrying from→to', async () => {
    const f = fakeAct();
    // Same role+name, a stable attr changed ⇒ tier 1 misses, tier 2 is unique ⇒ medium.
    const drifted = candidate('e-live', { attrs: { type: 'submit' } });
    const r = await runFlow({
      steps: [step({ healTierAtRecord: 'high' })],
      act: f.act,
      candidates: async () => [drifted],
    });
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(r.dispatched[0]?.degraded).toEqual({ from: 'high', to: 'medium' });
  });

  it('does not mark a step degraded when its tier held', async () => {
    const f = fakeAct();
    const r = await runFlow({ steps: [step()], act: f.act, candidates: async () => [candidate('e-live')] });
    expect(r.dispatched[0] && 'degraded' in r.dispatched[0]).toBe(false);
  });
});

describe('runFlow — a type step needs a per-run value, and never a stored one (§6)', () => {
  it('halts on a type step whose slot has no value, BEFORE dispatching', async () => {
    // Typing an empty string would report success while typing nothing — a silently wrong replay.
    const f = fakeAct();
    const r = await runFlow({
      steps: [step({ action: 'type', slot: 'search_query', target: seed({ role: 'textbox', name: 'Search' }) })],
      act: f.act,
      candidates: async () => [candidate('e-live', { role: 'textbox', name: 'Search' })],
    });
    expect(r.halt).toEqual({ atSeq: 1, reason: 'slot_unfilled', detail: 'search_query' });
    expect(f.calls).toHaveLength(0);
  });

  it('dispatches the caller\'s value for the slot, and the step itself carries no value', async () => {
    const f = fakeAct();
    const s = step({ action: 'type', slot: 'search_query', target: seed({ role: 'textbox', name: 'Search' }) });
    await runFlow({
      steps: [s],
      act: f.act,
      candidates: async () => [candidate('e-live', { role: 'textbox', name: 'Search' })],
      values: { search_query: 'winter boots' },
    });
    expect(f.calls[0]).toMatchObject({ action: 'type', text: 'winter boots' });
    // The recording is value-free: it held a slot NAME and nothing else.
    expect(JSON.stringify(s)).not.toContain('winter boots');
  });
});

describe('runFlow — what bounds a run (§5.4, A176)', () => {
  it('REFUSES a recording longer than the ceiling before dispatching anything', async () => {
    // Pre-flight, not truncation: a run stopped at the ceiling has already executed a partial sequence,
    // which is the hazard the ceiling exists to prevent.
    const f = fakeAct();
    const steps = Array.from({ length: MAX_REPLAY_STEPS + 1 }, (_, i) =>
      step({ seq: i + 1, action: 'navigate', pageUrl: `https://ex.com/${i}`, target: undefined }));
    const r = await runFlow({ steps, act: f.act, candidates: async () => [] });
    expect(r.halt).toEqual({ atSeq: 0, reason: 'too_long', detail: String(MAX_REPLAY_STEPS + 1) });
    expect(f.calls).toHaveLength(0);
    expect(r.dispatched).toEqual([]);
  });

  it('runs a flow exactly AT the ceiling — the bound is not off by one', async () => {
    const f = fakeAct();
    const steps = Array.from({ length: MAX_REPLAY_STEPS }, (_, i) =>
      step({ seq: i + 1, action: 'navigate', pageUrl: `https://ex.com/${i}`, target: undefined }));
    const r = await runFlow({ steps, act: f.act, candidates: async () => [] });
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(MAX_REPLAY_STEPS);
  });

  it('halts an empty flow rather than reporting a vacuous success', async () => {
    const f = fakeAct();
    const r = await runFlow({ steps: [], act: f.act, candidates: async () => [] });
    expect(r).toEqual({ ok: false, dispatched: [], halt: { atSeq: 0, reason: 'empty_flow' } });
    expect(f.calls).toHaveLength(0);
  });

  it('charges the budget once per navigate STEP — the runner neither batches nor exempts (G3-h, T15)', async () => {
    // The origin budget is charged inside the act handler's drive gate, so "m navigate steps charge m
    // units" holds exactly as long as the runner dispatches m separate navigates. Counted on the
    // dispatches, which is the only thing this module controls.
    const f = fakeAct();
    const m = 4;
    const steps = Array.from({ length: m }, (_, i) =>
      step({ seq: i + 1, action: 'navigate', pageUrl: `https://ex.com/p${i}`, target: undefined }));
    await runFlow({ steps, act: f.act, candidates: async () => [] });
    expect(f.calls.filter((c) => c.action === 'navigate')).toHaveLength(m);
  });

  it('refuses a verb the recorder could not have written, rather than dispatching it blind', async () => {
    const f = fakeAct();
    const r = await runFlow({
      steps: [step({ action: 'evaluate', target: undefined })],
      act: f.act,
      candidates: async () => [],
    });
    expect(r.halt).toMatchObject({ reason: 'act_refused', detail: 'unknown_action:evaluate' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('runFlow — the structural envelope (§5.1, §5.2, T8, T9, T10)', () => {
  /** Walks real (non-type) imports from a module, transitively, and returns every file reached. */
  function importGraph(entry: string): string[] {
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf-8');
      // `import type` / `export type` are erased at build and cannot pull a runtime dependency.
      const specs = [...src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
      for (const spec of specs) {
        if (!spec.startsWith('.')) continue; // a bare specifier is a package, not one of ours
        const abs = resolvePath(dirname(file), spec).replace(/\.js$/, '.ts');
        walk(abs);
      }
    };
    walk(entry);
    return [...seen];
  }

  it('reaches NO CDP, transport or input-channel module transitively (T8)', () => {
    // Asserted on the GRAPH, not on a grep of the runner: a grep cannot see a re-export, which is
    // precisely how a direct dispatch path would arrive without appearing in this file.
    const graph = importGraph(join(process.cwd(), 'src/studio/flow/run.ts'));
    expect(graph.length).toBeGreaterThan(1); // a walker that reached nothing would pass every row below
    const forbidden = graph.filter((f) => /cdp|transport|channel|input-|\/act\.ts$/i.test(f));
    expect(forbidden, `runner must not reach a dispatch surface: ${forbidden.join(', ')}`).toEqual([]);
  });

  it('names the act contract by TYPE only, so it cannot pull the dispatch path in', () => {
    const src = readFileSync(join(process.cwd(), 'src/studio/flow/run.ts'), 'utf-8');
    // The act types come from the dispatch module; the import must be erased at build.
    expect(src).toMatch(/import type \{[^}]*StudioActInput[^}]*\} from '\.\.\/\.\.\/daemon\/studio-dispatch\.js'/);
    expect(src).not.toMatch(/^import \{[^}]*StudioActInput/m);
  });

  it('has no field to read a recorded authorization or risk from (T9, T10)', () => {
    // Migration 013 gives the table no risk and no approval column, so this is structural rather than a
    // behaviour the runner has to remember. A test that only checked "the runner does not read them"
    // would pass on a schema that offered them.
    const store = readFileSync(join(process.cwd(), 'src/studio/flow/store.ts'), 'utf-8');
    const iface = store.slice(store.indexOf('export interface FlowStep'), store.indexOf('export interface FlowStep') + 900);
    expect(iface).not.toMatch(/\brisk\b/);
    expect(iface).not.toMatch(/\bapproval\b/);
    const runner = readFileSync(join(process.cwd(), 'src/studio/flow/run.ts'), 'utf-8');
    expect(runner).not.toMatch(/step\.(risk|approval)/);
  });

  it('exposes the ceiling as a constant with no way to raise it per run', () => {
    // §5.4 / `vision.ts`: a clamp you cannot crank up to unsafe is safer than one you can.
    const src = readFileSync(join(process.cwd(), 'src/studio/flow/run.ts'), 'utf-8');
    expect(src).toMatch(/export const MAX_REPLAY_STEPS = \d+;/);
    // No dep, option or env var may override it.
    expect(src).not.toMatch(/maxSteps|stepCeiling|MAX_REPLAY_STEPS\s*=\s*deps|process\.env/);
    expect(typeof MAX_REPLAY_STEPS).toBe('number');
  });
});
