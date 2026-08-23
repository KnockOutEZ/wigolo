/**
 * The parts of the G-S11a gate DEFINITION that are numbers rather than code.
 *
 * They live apart from `gate.ts` for one reason: that file runs its measurement on import, so a test
 * that needs the gate's own constants cannot import it without running it. Splitting them keeps
 * `tests/integration/visual-ldet-gate.test.ts` asserting against the SAME numbers the printed report
 * uses, instead of a second copy that can drift from it silently.
 */

/**
 * THE PINNED SECOND VIEWPORT WIDTH.
 *
 * The spec's clause 2 says "a second viewport width" and never says which, and the verdict is a
 * function of that unstated number (known-issues P4). The pin is chosen on one criterion, from the
 * captured sweep: **the width where the shipped signer clears the clause and the spec's own
 * normalisation mutant does not.** A width both clear is a clause with no power — it would report
 * green for a build whose viewport normalisation had been deleted. See `gate.ts` for the measured
 * table the choice was made from, and its PIN POWER line, which re-checks the criterion every run.
 */
export const GATE_ALT_WIDTH = 1024;

/** G-S11a-1 clause 1: share of the corpus whose same-build re-render pair must separate. */
export const CLAUSE1_THRESHOLD = 95;

/** G-S11a-1 clause 2: share that must stay in the same-page band across the width change. */
export const CLAUSE2_THRESHOLD = 90;

/** G-S11a-2: CDP round trips a single page's harvest may cost. */
export const HARVEST_ROUND_TRIP_BUDGET = 1;

/** G-S11a-2: the quantiser's own p50 budget on a page larger than the perception layer's ~900 elements. */
export const QUANTISER_BUDGET_MS = 250;
