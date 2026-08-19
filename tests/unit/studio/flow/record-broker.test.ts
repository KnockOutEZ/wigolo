/**
 * K34 — the Electron host records flows through the BROKER, and the join key is the durable audit seq.
 *
 * Why this file exists rather than more cases in `record.test.ts`: the Electron host cannot persist
 * synchronously. It holds no database handle, every persist is an async `broker.call(...)` into the
 * child process that owns the native DB, and its audit log is in-memory. What it must NOT have is a
 * second notion of what gets recorded — so these tests assert that the async recorder shares
 * `draftFlowStep` with the CLI recorder rather than reimplementing the decisions.
 *
 * THE DEFECT THIS SLICE CLOSES, stated precisely because the known-issues row understates it:
 * `persistAudit` builds a fresh `SessionAuditLog` that hydrates `seq` from the table and assigns
 * `++seq`; the host's in-memory log also counts 1, 2, 3… So on a healthy broker the two sequences
 * COINCIDE BY ACCIDENT, and diverge only when a persist fails — which the host's `.catch(() => {})`
 * swallows. A join key that is right until the broker hiccups passes every test run against a healthy
 * broker, and `013-studio-flows.sql` puts no foreign key on `audit_seq`, so nothing else would catch
 * it either. Hence the durable seq is threaded explicitly and its absence records nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBrokerFlowRecorder, draftFlowStep } from '../../../../src/studio/flow/record.js';
import type { FlowStep, FlowProjection } from '../../../../src/studio/flow/store.js';
import type { StructuredTarget } from '../../../../src/studio/mark/target.js';

function target(over: Partial<StructuredTarget> = {}): StructuredTarget {
  return {
    role: 'button',
    name: 'Next page',
    fingerprint: 'fp-next',
    ancestorPath: 'html/body/main/nav',
    attrs: { type: 'button' },
    backendNodeId: 11,
    trusted: false,
    ...over,
  } as StructuredTarget;
}

interface Harness {
  inserted: FlowStep[];
  /** in-memory audit seq → durable audit seq. `undefined` models a persist that never landed. */
  durable: Map<number, number | undefined>;
  failNextInsert: boolean;
  rejections: string[];
}

function harness(over: Partial<{ maxSeq: number; durable: Map<number, number | undefined> }> = {}) {
  const h: Harness = {
    inserted: [],
    durable: over.durable ?? new Map([[1, 1], [2, 2], [3, 3]]),
    failNextInsert: false,
    rejections: [],
  };
  const recorder = createBrokerFlowRecorder({
    sessionId: 'sess-1',
    seed: async () => target(),
    maxSeq: async () => over.maxSeq ?? 0,
    resolveAuditSeq: async (inMemorySeq: number) => h.durable.get(inMemorySeq),
    insert: async (step: FlowStep): Promise<FlowProjection> => {
      if (h.failNextInsert) {
        h.failNextInsert = false;
        throw new Error('broker down');
      }
      h.inserted.push(step);
      return { ok: true, step };
    },
    now: () => 1_700_000_000,
    onReject: (r) => h.rejections.push(r.reason),
  });
  return { h, recorder };
}

describe('the broker recorder — the Electron surface records, and joins to durable rows', () => {
  it('records a step per successful act, in order, through the async persister', async () => {
    const { h, recorder } = harness();
    recorder.record({ action: 'navigate', auditSeq: 1, pageUrl: 'https://ex.com/a' });
    recorder.record({ action: 'click', auditSeq: 2, pageUrl: 'https://ex.com/a', target: target(), recordedRef: 'e1' });
    await recorder.flush();
    expect(h.inserted.map((s) => s.seq)).toEqual([1, 2]);
    expect(h.inserted.map((s) => s.action)).toEqual(['navigate', 'click']);
  });

  it('keys the step on the DURABLE audit seq, never on the host\'s in-memory count', async () => {
    // The whole of K34. A dropped persist offsets every later durable seq, so in-memory 2 is durable
    // 1 here. Storing the in-memory number would produce a row pointing at an audit seq that exists
    // but belongs to a DIFFERENT action — worse than a dangling reference, because it reads as valid.
    const { h, recorder } = harness({ durable: new Map([[2, 1], [3, 2]]) });
    recorder.record({ action: 'navigate', auditSeq: 2, pageUrl: 'https://ex.com/a' });
    recorder.record({ action: 'scroll', auditSeq: 3, direction: 'down', amount: 400, pageUrl: 'https://ex.com/a' });
    await recorder.flush();
    expect(h.inserted.map((s) => s.auditSeq)).toEqual([1, 2]);
  });

  it('records NOTHING when the audit row never landed — no audit row, no step', async () => {
    // Degrades to the sidecar's existing rule rather than inventing a new failure mode: the sidecar is
    // DERIVED from the forensic record, so a step whose audit row is absent must not exist.
    const { h, recorder } = harness({ durable: new Map([[1, undefined]]) });
    recorder.record({ action: 'navigate', auditSeq: 1, pageUrl: 'https://ex.com/a' });
    await recorder.flush();
    expect(h.inserted).toEqual([]);
  });

  it('shares the credential refusal with the CLI recorder — ONE decision, not two implementations', async () => {
    const { h, recorder } = harness();
    recorder.record({ action: 'click', auditSeq: 1, pageUrl: 'https://ex.com/login', target: target(), recordedRef: 'e1' });
    recorder.record({ action: 'type', auditSeq: 2, pageUrl: 'https://ex.com/x', target: target(), pageHasCredentialField: true });
    await recorder.flush();
    expect(h.inserted).toEqual([]);
  });

  it('stores a named slot and never a value on a type step, exactly as the sync recorder does', async () => {
    const { h, recorder } = harness();
    recorder.record({
      action: 'type', auditSeq: 1, pageUrl: 'https://ex.com/x',
      target: target({ role: 'textbox', name: 'Search orders' }), recordedRef: 'e9',
    });
    await recorder.flush();
    expect(h.inserted[0]?.slot).toBe('search_orders');
    expect(JSON.stringify(h.inserted[0])).not.toContain('secret');
  });

  it('never throws out of record(), and never rejects, when the broker is down', async () => {
    const { h, recorder } = harness();
    h.failNextInsert = true;
    expect(() => recorder.record({ action: 'navigate', auditSeq: 1, pageUrl: 'https://ex.com/a' })).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(h.inserted).toEqual([]);
  });

  it('does NOT advance seq when a persist fails, so a transient outage costs one step and not the sequence', async () => {
    // Mirrors the sync recorder's rule. Advancing would leave a permanent hole at the failed number,
    // and the unique (flow_id, seq) index would then make the hole indistinguishable from a step that
    // was never attempted.
    const { h, recorder } = harness();
    h.failNextInsert = true;
    recorder.record({ action: 'navigate', auditSeq: 1, pageUrl: 'https://ex.com/a' });
    recorder.record({ action: 'navigate', auditSeq: 2, pageUrl: 'https://ex.com/b' });
    await recorder.flush();
    expect(h.inserted.map((s) => s.seq)).toEqual([1]);
    expect(h.inserted[0]?.action).toBe('navigate');
  });

  it('resumes numbering from the broker\'s MAX(seq) rather than colliding on 1 after a restart', async () => {
    const { h, recorder } = harness({ maxSeq: 4 });
    recorder.record({ action: 'navigate', auditSeq: 1, pageUrl: 'https://ex.com/a' });
    await recorder.flush();
    expect(h.inserted[0]?.seq).toBe(5);
  });

  it('preserves call order even though every persist is async — the chain is what keeps seq monotonic', async () => {
    // Without the chain, three record() calls would race and the (flow_id, seq) index would silently
    // drop whichever collided. Asserted on the ORDER of what arrived, not just the count.
    const { h, recorder } = harness();
    recorder.record({ action: 'navigate', auditSeq: 1, pageUrl: 'https://ex.com/1' });
    recorder.record({ action: 'navigate', auditSeq: 2, pageUrl: 'https://ex.com/2' });
    recorder.record({ action: 'navigate', auditSeq: 3, pageUrl: 'https://ex.com/3' });
    await recorder.flush();
    expect(h.inserted.map((s) => [s.seq, s.pageUrl])).toEqual([
      [1, 'https://ex.com/1'],
      [2, 'https://ex.com/2'],
      [3, 'https://ex.com/3'],
    ]);
  });

  it('routes both recorders through draftFlowStep, so the two can never drift apart', () => {
    // A structural guard, because the failure it prevents is invisible in behaviour until the day the
    // two paths disagree. If a future edit re-inlines the decisions into either recorder, this reds.
    const src = readFileSync(join(process.cwd(), 'src/studio/flow/record.ts'), 'utf-8');
    const body = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(body.match(/draftFlowStep\(/g)?.length).toBe(3); // 1 definition + 2 call sites
    // The credential predicate and the URL narrowing each have exactly ONE call site, inside the shared
    // path — not one per recorder. Matched on the call FORM rather than the bare name, because the bare
    // name also matches each function's own definition and would make these counts mean nothing.
    expect(body.match(/isCredentialRecordingContext\(\{/g)?.length).toBe(1);
    expect(body.match(/narrowPageUrl\(input\./g)?.length).toBe(1);
    // The recordable-verb decision likewise: one definition, one call from the drafter, one pre-flight
    // from the async recorder. A fourth would mean a recorder had grown its own opinion.
    expect(body.match(/isRecordableAct\(/g)?.length).toBe(3);
  });

  it('drafts identically for both recorders on the same input — asserted on the drafter directly', () => {
    // The structural test above proves ONE call path; this proves the path produces what the sidecar
    // expects, independent of either persister.
    const fields = draftFlowStep(
      { action: 'click', auditSeq: 7, pageUrl: 'https://ex.com/orders?token=abc#frag', target: target(), recordedRef: 'e1' },
      1,
      99,
    );
    expect(fields?.pageUrl).toBe('https://ex.com/orders');
    expect(fields?.auditSeq).toBe(7);
    expect(fields?.healTierAtRecord).toBe('high');
    expect(fields?.ts).toBe(99);
  });
});
