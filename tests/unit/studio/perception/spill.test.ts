import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSpill, readSpill, fitElementsToBudget, fitDiffToBudget } from '../../../../src/studio/perception/spill.js';
import type { SnapshotElement } from '../../../../src/studio/perception/snapshot.js';

const el = (ref: string, name: string): SnapshotElement => ({ ref, role: 'button', name });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wigolo-spill-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('writeSpill / readSpill — content-addressed', () => {
  it('round-trips a payload by ref', () => {
    const ref = writeSpill({ hello: 'world', n: [1, 2, 3] }, dir);
    expect(ref).toMatch(/^spill:[0-9a-z]+$/);
    expect(readSpill(ref, dir)).toEqual({ hello: 'world', n: [1, 2, 3] });
  });
  it('returns null for unknown refs and REJECTS path traversal', () => {
    expect(readSpill('spill:deadbeef', dir)).toBeNull();
    expect(readSpill('spill:../../../etc/passwd', dir)).toBeNull();
    expect(readSpill('not-a-spill-ref', dir)).toBeNull();
  });
});

describe('fitElementsToBudget — keep the top-ranked inline, spill the rest, keep it actionable (build-in #4)', () => {
  it('under budget → everything inline, no spill', () => {
    const els = [el('e1', 'A'), el('e2', 'B')];
    const r = fitElementsToBudget(els, 100000, dir);
    expect(r.spillRef).toBeNull();
    expect(r.elements).toEqual(els);
    expect(r.spilled).toBe(0);
  });

  it('over budget → inline is the top-ranked prefix; the FULL set spills with refs intact (spilled elements stay addressable)', () => {
    const els = Array.from({ length: 50 }, (_, i) => el('e' + i, 'Item ' + i));
    const r = fitElementsToBudget(els, 200, dir);
    expect(r.spillRef).not.toBeNull();
    expect(r.spilled).toBeGreaterThan(0);
    expect(r.elements.length).toBeLessThan(50);
    expect(r.elements[0].ref).toBe('e0'); // top-ranked kept (document-order relevance), NOT arbitrary
    expect(r.tokenCount).toBeLessThanOrEqual(200);
    // actionability: a SPILLED tail element keeps its ref in the retrievable full set
    const full = readSpill(r.spillRef!, dir) as Array<{ ref: string }>;
    expect(full.length).toBe(50);
    expect(full.map((e) => e.ref)).toContain('e49');
  });
});

describe('fitDiffToBudget — an over-budget diff spills too (build-in #3)', () => {
  const churn = { groups: [] as string[], added: [] as SnapshotElement[], removed: [] as SnapshotElement[] };
  it('small diff stays inline', () => {
    const diff = { baseId: 's1', id: 's2', added: [el('e1', 'A')], removed: [], changed: [], lowConfidenceChurn: churn };
    expect(fitDiffToBudget(diff, 100000, dir).spillRef).toBeNull();
  });
  it('large diff → counts summary inline + full diff spilled + retrievable', () => {
    const added = Array.from({ length: 100 }, (_, i) => el('e' + i, 'New ' + i));
    const diff = { baseId: 's1', id: 's2', added, removed: [], changed: [], lowConfidenceChurn: churn };
    const r = fitDiffToBudget(diff, 100, dir);
    expect(r.spillRef).not.toBeNull();
    expect(r.diff).toBeNull();
    expect(r.summary).toMatchObject({ added: 100, removed: 0 });
    expect((readSpill(r.spillRef!, dir) as { added: unknown[] }).added.length).toBe(100);
  });
});
