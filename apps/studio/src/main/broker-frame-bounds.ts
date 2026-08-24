/**
 * The host's wire bound, in its own module because the OTHER side of the pipe has to read it.
 *
 * It lived in `broker-client.ts` and belongs to it. What forced the split is resolution, not design:
 * `apps/studio` is a Bundler-resolution project whose `wigolo/studio` specifier resolves through the
 * BUILT package, and the type-gate CI job deliberately does not build — so any root-program file that
 * statically imports `broker-client.ts` drags `wigolo/studio` into a program that cannot resolve it
 * and fails a gate it has nothing to do with. `tests/integration/studio-attach-tab-law4.test.ts`
 * writes the same rule down and pays it with a computed specifier plus a hand-written interface.
 *
 * A number does not need that machinery, and paying it would cost the thing the number exists for:
 * the assertion tying this ceiling to the child's page budget has to NAME the real constant, so a
 * bump on either side reds a test naming the other. This module imports nothing, so it resolves in
 * either program, and the link stays static.
 */

/**
 * The most one answer may occupy in this process before it is treated as a protocol failure.
 *
 * The reads that could produce an unbounded frame are bounded at the source now, which is where a
 * policy bound belongs — this is not that. It is the backstop for the case the source bound cannot
 * cover: a child that is broken, wedged mid-write, or newer than this host. Deliberately far above
 * any legitimate answer (a synthesized brief, a page of artifacts with their bodies), because the
 * cost of cutting a real answer short is a failed call and the cost of not cutting a runaway one is
 * the window.
 *
 * The child's own page ceilings were set independently of this number, and its worst legal
 * `runEventsSince` answer was twice it — a legitimate page killed as an oversized frame, respawning
 * the broker on every page of a replay. `tests/integration/studio-broker-frame-budget.test.ts`
 * asserts the relation, so a bump here reds a test naming the child's constants and vice versa.
 */
export const DEFAULT_MAX_FRAME_CHARS = 64 * 1024 * 1024;
