import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PageSnapshotter, type PageSnapshot } from '../../src/studio/perception/snapshot.js';
import { diffSnapshots, resolveObserve } from '../../src/studio/perception/diff.js';
import { fitElementsToBudget, readSpill } from '../../src/studio/perception/spill.js';
import { escalate, VisionBudget, type Region } from '../../src/studio/perception/vision.js';

/**
 * The regression wall (CEO sign-off #2, item 1): the 2D spike's numbers transfer
 * ONLY if production runs the same ID algorithm. So the spike fixtures are PORTED
 * here and pinned against the PRODUCTION PageSnapshotter — any drift in fingerprint
 * normalization or the positional tiebreaker breaks these, not just a thrown-away
 * harness. Headed; skips by default (RUN_STUDIO_HEADED=1 to run).
 */
const HEADED = !!process.env.RUN_STUDIO_HEADED;
const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'studio');
const url = (f: string) => 'file://' + join(FIX, f);

const attrsObj = (a: string[] = []) => { const o: Record<string, string> = {}; for (let i = 0; i + 1 < a.length; i += 2) o[a[i]] = a[i + 1]; return o; };

interface DomNode { backendNodeId?: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode }

describe.skipIf(!HEADED)('studio perception — production snapshot reproduces the 2D verdict numbers', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  // Resolve the ground-truth data-oracle for each ref via refMap → backendNodeId → pierced-DOM attrs.
  async function observe(cdp: { send: (m: string, p?: Record<string, unknown>) => Promise<unknown> }): Promise<{ snap: PageSnapshot; byOracle: Map<string, { ref: string; confidence?: string }> }> {
    const snap = await new PageSnapshotter({ tokenBudget: 1_000_000 }).snapshot(cdp);
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
    const oracleOf = new Map<number, string>();
    const walk = (n: DomNode) => {
      const o = attrsObj(n.attributes)['data-oracle'];
      if (n.backendNodeId != null && o) oracleOf.set(n.backendNodeId, o);
      for (const c of n.children ?? []) walk(c);
      for (const s of n.shadowRoots ?? []) walk(s);
      if (n.contentDocument) walk(n.contentDocument);
    };
    walk(root);
    const byOracle = new Map<string, { ref: string; confidence?: string }>();
    for (const e of snap.elements) {
      const be = snap.refMap.get(e.ref);
      const oracle = be != null ? oracleOf.get(be) : undefined;
      if (oracle) byOracle.set(oracle, e);
    }
    return { snap, byOracle };
  }

  const survival = (a: Map<string, { ref: string }>, b: Map<string, { ref: string }>, pred: (o: string) => boolean) => {
    let hit = 0, tot = 0;
    for (const [o, ea] of a) { if (!pred(o)) continue; tot++; const eb = b.get(o); if (eb && eb.ref === ea.ref) hit++; }
    return { hit, tot };
  };
  const isDistinct = (o: string) => o.startsWith('task-') || o.startsWith('field-');
  const isDup = (o: string) => o.startsWith('del-');

  async function open(f: string) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('Accessibility.enable');
    await page.goto(url(f));
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
    return { ctx, page, cdp };
  }

  it('determinism: two observes of an unchanged page give identical refs (the trivial floor)', async () => {
    const { ctx, cdp } = await open('rerender.html');
    const a = await observe(cdp);
    const b = await observe(cdp);
    const d = survival(a.byOracle, b.byOracle, () => true);
    expect(d.hit).toBe(d.tot);
    expect(d.tot).toBe(15); // 5 task + 5 field + 5 delete
    await ctx.close();
  });

  it('hybrid reproduces survival across content-preserving mutations (distinct 100%; dup-reorder drifts)', async () => {
    for (const [hook, expectDupHit] of [['__rerender', 5], ['__insert', 5], ['__hydrate', 5], ['__reorder', 1]] as const) {
      const { ctx, page, cdp } = await open('rerender.html');
      const before = await observe(cdp);
      await page.evaluate((h) => (window as unknown as Record<string, () => void>)[h](), hook);
      const after = await observe(cdp);
      const dist = survival(before.byOracle, after.byOracle, isDistinct);
      const dup = survival(before.byOracle, after.byOracle, isDup);
      expect(dist.hit).toBe(dist.tot); // distinct names: 100% survival across the identity swap
      expect(dup.hit).toBe(expectDupHit); // dup run: 100% except reorder where positional refs drift to 1/5 (20%)
      expect(dup.tot).toBe(5);
      await ctx.close();
    }
  });

  it('uniqueness + low-confidence: 5 identical "Delete" get 5 distinct refs, all flagged low at snapshot time', async () => {
    const { ctx, cdp } = await open('rerender.html');
    const { byOracle } = await observe(cdp);
    const dupRefs = [...byOracle].filter(([o]) => isDup(o)).map(([, e]) => e);
    expect(new Set(dupRefs.map((e) => e.ref)).size).toBe(5); // not ambiguous (the fp-only failure)
    expect(dupRefs.every((e) => e.confidence === 'low')).toBe(true);
    expect([...byOracle].filter(([o]) => isDistinct(o)).every(([, e]) => e.confidence === undefined)).toBe(true);
    await ctx.close();
  });

  it('shadow-DOM piercing: open + nested-open + CLOSED interactive elements are all observed', async () => {
    const { ctx, cdp } = await open('webcomponents.html');
    const { byOracle } = await observe(cdp);
    for (const o of ['light-1', 'open-1', 'open-2', 'nested-1', 'closed-1']) {
      expect(byOracle.has(o), `expected to observe ${o}`).toBe(true);
    }
    await ctx.close();
  });

  // ---- 2F: the wall extends to diff correctness + desync + heavy spill (pinned against production) ----

  it('diff: shifting the identical-Delete run → low-confidence CHURN + one real add, never a phantom delta (build-in #1)', async () => {
    const { ctx, page, cdp } = await open('rerender.html');
    const snapper = new PageSnapshotter({ tokenBudget: 1_000_000 });
    const prev = await snapper.snapshot(cdp);
    await page.evaluate(() => (window as unknown as { __shiftItems: () => void }).__shiftItems());
    const next = await snapper.snapshot(cdp);
    const d = diffSnapshots(prev, next);

    // Shifting the run by one position overlaps the path SET, so 4 Delete refs are
    // reused and only the boundary drifts: 1 ref off the end + 1 new, folded into
    // churn. The key property: NO phantom structural delta — the drift is churn, the
    // 4 stable Deletes aren't touched, and only Archive surfaces as a real add.
    // (The multi-element churn-folding case is pinned in the diff.ts unit tests.)
    expect(d.added.map((e) => e.name)).toEqual(['Archive']); // ONLY the genuine add surfaces
    expect(d.removed).toEqual([]); // NO Delete phantom-removed
    expect(d.lowConfidenceChurn.removed.length).toBe(1); // the single boundary drift, as churn…
    expect(d.lowConfidenceChurn.added.length).toBe(1);
    expect([...d.lowConfidenceChurn.removed, ...d.lowConfidenceChurn.added].every((e) => e.name === 'Delete')).toBe(true);
    await ctx.close();
  });

  it('desync: a stale held base → full resync; a matching base → diff; navigation → full (build-ins #2/#5)', async () => {
    const { ctx, page, cdp } = await open('rerender.html');
    const snapper = new PageSnapshotter({ tokenBudget: 1_000_000 });
    const prev = await snapper.snapshot(cdp);
    await page.evaluate(() => (window as unknown as { __rerender: () => void }).__rerender());
    const next = await snapper.snapshot(cdp);

    expect(resolveObserve(prev, next, { heldBaseId: prev.id }).kind).toBe('diff'); // matching base → delta
    expect(resolveObserve(prev, next, { heldBaseId: 'stale-base' })).toMatchObject({ kind: 'full', reason: 'base_mismatch' });
    expect(resolveObserve(prev, next, { heldBaseId: prev.id, navigated: true })).toMatchObject({ kind: 'full', reason: 'navigated' });
    await ctx.close();
  });

  it('heavy page: over budget → spill keeps the top-ranked inline and the spilled tail stays addressable (build-ins #3/#4)', async () => {
    const { ctx, cdp } = await open('heavy.html?n=300');
    const snap = await new PageSnapshotter({ tokenBudget: 4000 }).snapshot(cdp);
    expect(snap.tokenCount).toBeGreaterThan(4000); // heavy pages routinely blow the budget
    expect(snap.overBudget).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'wigolo-spill-int-'));
    try {
      const fit = fitElementsToBudget(snap.elements, 4000, dir);
      expect(fit.spillRef).not.toBeNull();
      expect(fit.spilled).toBeGreaterThan(0);
      expect(fit.tokenCount).toBeLessThanOrEqual(4000); // inline fits
      expect(fit.elements[0].ref).toBe(snap.elements[0].ref); // top-ranked kept inline
      const full = readSpill(fit.spillRef!, dir) as Array<{ ref: string }>;
      expect(full.length).toBe(snap.elements.length); // every element retrievable…
      expect(full.map((e) => e.ref)).toContain(snap.elements[snap.elements.length - 1].ref); // …incl. the spilled tail (addressable)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await ctx.close();
  });

  it('vision (headed): a GPU/canvas-rendered region captures NON-BLANK, carries the region, is tagged untrusted (lock #6)', async () => {
    const { ctx, page, cdp } = await open('canvas.html');
    const rectOf = (sel: string): Promise<Region> =>
      page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    const art = await rectOf('#art');
    const blank = await rectOf('#blank');
    const budget = new VisionBudget(5, 8_000_000);

    const canvasShot = await escalate(cdp, { trigger: 'canvas', region: art }, budget, { inlineByteCap: 10_000_000 });
    const blankShot = await escalate(cdp, { trigger: 'canvas', region: blank }, budget, { inlineByteCap: 10_000_000 });
    expect(canvasShot.ok && blankShot.ok).toBe(true);
    if (canvasShot.ok && blankShot.ok) {
      // The drawn canvas PNG must carry real content — NOT a blank/transparent capture
      // (the headless-canvas false-confidence trap). It must dwarf the same-size solid region.
      expect(canvasShot.result.bytes).toBeGreaterThan(blankShot.result.bytes * 2);
      expect(canvasShot.result.region).toEqual(art); // locus for 2J
      expect(canvasShot.result.trusted).toBe(false); // untrusted channel
      expect(canvasShot.result.image.base64).toBeTruthy();
    }
    await ctx.close();
  });
});
