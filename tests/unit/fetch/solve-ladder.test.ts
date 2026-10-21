import { describe, it, expect, vi } from 'vitest';
import { runSolveLadder, type SolveLadderOptions } from '../../../src/fetch/solve-ladder.js';
import type { ClearanceCookie } from '../../../src/fetch/challenge-completion.js';

const CF: ClearanceCookie[] = [
  { name: 'cf_clearance', value: 'TOK', domain: 'example.com', expires: Date.now() / 1000 + 3600 },
];

/** Gate config with every solve rung ON — each test flips off only what it
 *  exercises so the "gates off → skip" negatives are unambiguous. */
function allOnGates(): SolveLadderOptions['gates'] {
  return {
    autoPass: 'on',
    aiSolve: 'on',
    humanSolve: 'on',
  };
}

/** Baseline opts: an interactive challenge with all rungs on and every injected
 *  rung a spy that fails, so a test only sets what it means to prove. */
function baseOpts(over: Partial<SolveLadderOptions> = {}): SolveLadderOptions {
  return {
    challengeClass: 'interactive',
    gates: allOnGates(),
    visionAvailable: true,
    tryAutoPass: vi.fn(async () => ({ passed: false, cookies: [] as ClearanceCookie[] })),
    tryAiSolve: vi.fn(async () => ({ solved: false, cookies: [] as ClearanceCookie[] })),
    tryHuman: vi.fn(async () => ({ solved: false, cookies: [] as ClearanceCookie[] })),
    ...over,
  };
}

describe('runSolveLadder — must-not-fire on non-solvable classes', () => {
  it('behavioral → no rung runs; solved:false, solveMethod:null', async () => {
    const opts = baseOpts({ challengeClass: 'behavioral' });
    const res = await runSolveLadder(opts);
    expect(res).toEqual({ solved: false, solveMethod: null, cookies: [] });
    expect(opts.tryAutoPass).not.toHaveBeenCalled();
    expect(opts.tryAiSolve).not.toHaveBeenCalled();
    expect(opts.tryHuman).not.toHaveBeenCalled();
  });

  it('none → no rung runs (never burn an LLM call or a gesture)', async () => {
    const opts = baseOpts({ challengeClass: 'none' });
    const res = await runSolveLadder(opts);
    expect(res).toEqual({ solved: false, solveMethod: null, cookies: [] });
    expect(opts.tryAutoPass).not.toHaveBeenCalled();
    expect(opts.tryAiSolve).not.toHaveBeenCalled();
    expect(opts.tryHuman).not.toHaveBeenCalled();
  });
});

describe('runSolveLadder — interactive class', () => {
  it('auto-pass clears → solveMethod:auto-pass, ai-solve NEVER tried, human NOT reached', async () => {
    const opts = baseOpts({
      tryAutoPass: vi.fn(async () => ({ passed: true, cookies: CF })),
    });
    const res = await runSolveLadder(opts);
    expect(res.solved).toBe(true);
    expect(res.solveMethod).toBe('auto-pass');
    expect(res.cookies).toEqual(CF);
    expect(opts.tryAutoPass).toHaveBeenCalledTimes(1);
    // image rung is never applicable to an interactive class.
    expect(opts.tryAiSolve).not.toHaveBeenCalled();
    expect(opts.tryHuman).not.toHaveBeenCalled();
  });

  it('auto-pass fails → human runs LAST and clears → solveMethod:human', async () => {
    const order: string[] = [];
    const opts = baseOpts({
      tryAutoPass: vi.fn(async () => { order.push('auto'); return { passed: false, cookies: [] }; }),
      tryHuman: vi.fn(async () => { order.push('human'); return { solved: true, cookies: CF }; }),
    });
    const res = await runSolveLadder(opts);
    expect(order).toEqual(['auto', 'human']);
    expect(res.solved).toBe(true);
    expect(res.solveMethod).toBe('human');
    expect(res.cookies).toEqual(CF);
    // ai-vision never applies to interactive.
    expect(opts.tryAiSolve).not.toHaveBeenCalled();
  });

  it('auto-pass off → skip auto, fall to human', async () => {
    const opts = baseOpts({
      gates: { autoPass: 'off', aiSolve: 'on', humanSolve: 'on' },
      tryHuman: vi.fn(async () => ({ solved: true, cookies: CF })),
    });
    const res = await runSolveLadder(opts);
    expect(opts.tryAutoPass).not.toHaveBeenCalled();
    expect(opts.tryHuman).toHaveBeenCalledTimes(1);
    expect(res.solveMethod).toBe('human');
  });

  it('auto-pass on via "auto" value also engages', async () => {
    const opts = baseOpts({
      gates: { autoPass: 'auto', aiSolve: 'off', humanSolve: 'off' },
      tryAutoPass: vi.fn(async () => ({ passed: true, cookies: CF })),
    });
    const res = await runSolveLadder(opts);
    expect(opts.tryAutoPass).toHaveBeenCalledTimes(1);
    expect(res.solveMethod).toBe('auto-pass');
  });

  it('all automated rungs fail + human off → unsolved, solveMethod null', async () => {
    const opts = baseOpts({
      gates: { autoPass: 'on', aiSolve: 'on', humanSolve: 'off' },
    });
    const res = await runSolveLadder(opts);
    expect(res).toEqual({ solved: false, solveMethod: null, cookies: [] });
    expect(opts.tryAutoPass).toHaveBeenCalledTimes(1);
    expect(opts.tryHuman).not.toHaveBeenCalled();
  });
});

describe('runSolveLadder — image class', () => {
  it('ai-solve clears → solveMethod:ai-vision; auto-pass NEVER tried', async () => {
    const opts = baseOpts({
      challengeClass: 'image',
      tryAiSolve: vi.fn(async () => ({ solved: true, cookies: CF })),
    });
    const res = await runSolveLadder(opts);
    expect(res.solved).toBe(true);
    expect(res.solveMethod).toBe('ai-vision');
    expect(res.cookies).toEqual(CF);
    // auto-pass is for interactive widgets only.
    expect(opts.tryAutoPass).not.toHaveBeenCalled();
    expect(opts.tryHuman).not.toHaveBeenCalled();
  });

  it('ai-solve fails → human runs LAST', async () => {
    const order: string[] = [];
    const opts = baseOpts({
      challengeClass: 'image',
      tryAiSolve: vi.fn(async () => { order.push('ai'); return { solved: false, cookies: [] }; }),
      tryHuman: vi.fn(async () => { order.push('human'); return { solved: true, cookies: CF }; }),
    });
    const res = await runSolveLadder(opts);
    expect(order).toEqual(['ai', 'human']);
    expect(res.solveMethod).toBe('human');
  });

  it('aiSolve gate off → ai-solve skipped, fall to human', async () => {
    const opts = baseOpts({
      challengeClass: 'image',
      gates: { autoPass: 'on', aiSolve: 'off', humanSolve: 'on' },
      tryHuman: vi.fn(async () => ({ solved: true, cookies: CF })),
    });
    const res = await runSolveLadder(opts);
    expect(opts.tryAiSolve).not.toHaveBeenCalled();
    expect(opts.tryHuman).toHaveBeenCalledTimes(1);
    expect(res.solveMethod).toBe('human');
  });

  it('no vision provider (visionAvailable false) → ai-solve skipped cleanly, fall to human', async () => {
    const opts = baseOpts({
      challengeClass: 'image',
      visionAvailable: false,
      tryHuman: vi.fn(async () => ({ solved: true, cookies: CF })),
    });
    const res = await runSolveLadder(opts);
    expect(opts.tryAiSolve).not.toHaveBeenCalled();
    expect(opts.tryHuman).toHaveBeenCalledTimes(1);
    expect(res.solveMethod).toBe('human');
  });

  it('image + ai fail + human off → unsolved null', async () => {
    const opts = baseOpts({
      challengeClass: 'image',
      gates: { autoPass: 'on', aiSolve: 'on', humanSolve: 'off' },
    });
    const res = await runSolveLadder(opts);
    expect(res).toEqual({ solved: false, solveMethod: null, cookies: [] });
    expect(opts.tryHuman).not.toHaveBeenCalled();
  });
});

describe('runSolveLadder — abort', () => {
  it('a pre-aborted signal throws its reason before any rung', async () => {
    const ac = new AbortController();
    const reason = new Error('aborted');
    ac.abort(reason);
    const opts = baseOpts({ signal: ac.signal });
    await expect(runSolveLadder(opts)).rejects.toBe(reason);
    expect(opts.tryAutoPass).not.toHaveBeenCalled();
  });
});
