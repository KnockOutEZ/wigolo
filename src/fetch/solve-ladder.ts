// Solve-ladder orchestrator (slice PL) — pure sequencing over the in-band solve
// rungs. Given the classifier's `challengeClass`, the resolved config gates, and
// injected rung-runner callbacks, decide WHICH rungs to run and in WHAT order,
// stopping at the first that clears. Mirrors challenge-completion.ts: no
// Playwright / CDP / LLM import here — every rung is injected as a function, so
// this module unit-tests against mocks.
//
// The honesty posture lives here: a `behavioral` / `none` class runs NO rung
// (no image to read, no widget to click — burning an LLM call or a gesture would
// be dishonest work), returning the honest `{solved:false, solveMethod:null}`
// the blocked_by_challenge path depends on.
//
// Rung availability by class (spec §2 ladder):
//   - interactive → auto-pass (trusted gesture), then human (last).
//   - image       → ai-vision (in-band vision), then human (last).
//   - behavioral / none → nothing.
// Human is the LAST rung for any solvable class once the automated rung failed;
// the human module itself hard-no-ops on missing consent / surface, so gating
// here on the `humanSolve` knob alone is safe.
//
// Rungs the LADDER does not own: the raw control-plane rung (cdp-direct) and the
// hosted scraping-browser rung are both wired, but at the BROWSER POOL level —
// cdp-direct runs before the pool ever navigates, and the hosted rung replaces
// the local launch. Neither is a slot in this sequence, so nothing is called for
// them here. Both are opt-in and off by default.

import type { ChallengeClass, SolveMethod } from '../types.js';
import type { ClearanceCookie } from './challenge-completion.js';

/** The three tri-state solve knobs the ladder consults. Each mirrors the config
 *  value ('off' | 'auto' | 'on'); a rung engages on anything other than 'off'. */
export interface SolveLadderGates {
  autoPass: 'off' | 'auto' | 'on';
  aiSolve: 'off' | 'auto' | 'on';
  humanSolve: 'off' | 'auto' | 'on';
}

/** Outcome of the injected auto-pass rung. */
export interface AutoPassOutcome {
  passed: boolean;
  cookies: ClearanceCookie[];
}

/** Outcome of the injected ai-vision / human rungs. */
export interface SolveOutcome {
  solved: boolean;
  cookies: ClearanceCookie[];
}

export interface SolveLadderOptions {
  /** The class the classifier assigned to the current challenge. */
  challengeClass: ChallengeClass;
  /** Resolved config gates (the caller reads them off `getConfig()`). */
  gates: SolveLadderGates;
  /** True when a vision-capable LLM provider is configured — the ai-vision rung
   *  is skipped cleanly when false (no provider to call). */
  visionAvailable: boolean;
  /** Injected interactive-widget pass (trusted gesture). Backed by auto-pass.ts. */
  tryAutoPass: () => Promise<AutoPassOutcome>;
  /** Injected in-band vision solve. Backed by ai-solve.ts. */
  tryAiSolve: () => Promise<SolveOutcome>;
  /** Injected human last-resort. Backed by human-solve.ts (hard no-ops on
   *  missing consent / surface). */
  tryHuman: () => Promise<SolveOutcome>;
  /** Abort signal; checked before each rung so an abort short-circuits. */
  signal?: AbortSignal;
}

export interface SolveLadderResult {
  solved: boolean;
  /** Which rung cleared it, or null when nothing did (the honest blocked path). */
  solveMethod: SolveMethod | null;
  cookies: ClearanceCookie[];
}

/** A tri-state knob is engaged on any value other than 'off'. */
function engaged(v: 'off' | 'auto' | 'on'): boolean {
  return v !== 'off';
}

const UNSOLVED: SolveLadderResult = { solved: false, solveMethod: null, cookies: [] };

/**
 * Sequence the applicable solve rungs for `challengeClass`, returning at the
 * first that clears. Behavioral / none run no rung. Human is always the LAST
 * rung tried (and only when its knob is on). An abort throws the signal's reason
 * promptly, before the next rung.
 */
export async function runSolveLadder(opts: SolveLadderOptions): Promise<SolveLadderResult> {
  const { challengeClass, gates, visionAvailable, signal } = opts;

  if (signal?.aborted) throw signal.reason;

  // behavioral / none: nothing to solve in-band. Honest ceiling — no rung.
  if (challengeClass === 'behavioral' || challengeClass === 'none') {
    return { ...UNSOLVED, cookies: [] };
  }

  // interactive → the automated rung is a trusted-gesture pass of the widget.
  if (challengeClass === 'interactive' && engaged(gates.autoPass)) {
    const auto = await opts.tryAutoPass();
    if (auto.passed) {
      return { solved: true, solveMethod: 'auto-pass', cookies: auto.cookies };
    }
    if (signal?.aborted) throw signal.reason;
  }

  // image → the automated rung is an in-band vision solve (needs a provider).
  if (challengeClass === 'image' && engaged(gates.aiSolve) && visionAvailable) {
    const ai = await opts.tryAiSolve();
    if (ai.solved) {
      return { solved: true, solveMethod: 'ai-vision', cookies: ai.cookies };
    }
    if (signal?.aborted) throw signal.reason;
  }

  // The raw control-plane and hosted scraping-browser rungs are deliberately
  // absent from this sequence: the browser pool engages them around the whole
  // navigation, not as a step between the automated rungs and human. See
  // cdp-direct.ts / scraping-browser.ts and their call sites in browser-pool.ts.

  // human is the LAST rung for any solvable class. The human module hard-no-ops
  // on missing consent / visible surface, so gating on the knob alone is safe.
  if (engaged(gates.humanSolve)) {
    const human = await opts.tryHuman();
    if (human.solved) {
      return { solved: true, solveMethod: 'human', cookies: human.cookies };
    }
  }

  return { ...UNSOLVED, cookies: [] };
}
