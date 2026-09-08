/**
 * What registration UNLOCKS, and the one nudge that says so (PX brief §0a.1–3,
 * CEO consulting pass 2026-09-03).
 *
 * PX2 shipped a hard gate: an unregistered core install could not execute a tool
 * on any surface. The amendment made that gate Studio-only, which leaves core
 * with the opposite problem — an account now buys something rather than lifting
 * a wall, and nothing in the product said what. This file is that answer, and it
 * is deliberately the ONLY place the answer is written: the MCP footer, the
 * per-session instructions notice and both `init` paths render this list, so a
 * new unlock is one edit and the three surfaces cannot drift apart.
 *
 * CAPABILITY LANGUAGE, NOT PRODUCT NAMES. Each line names what the user gets to
 * do, never the mechanism that does it — the same rule the tool descriptions
 * follow, for the same reason: the mechanism is ours to change and the
 * capability is what was promised.
 *
 * NO TIER ADJECTIVES. There is no "free", "pro" or "premium" here. Which grants
 * an account carries is a server-side row the entitlement schema exists to let
 * the CEO change without shipping code (PX brief §3), so compiling a tier name
 * into a string would be publishing a decision this file does not own.
 */

/**
 * The unlock list, in the order it renders everywhere.
 *
 * Kept short on purpose: this is a footer on somebody else's result, not a
 * pricing page. Four lines is what fits under a tool result without becoming
 * the thing the reader is looking at.
 */
export const REGISTRATION_UNLOCKS: readonly string[] = Object.freeze([
  'sync — your cache, settings and watches across machines',
  'marketplace — publish and install skills and plugins',
  'higher pacing and watch limits',
  'managed cloud runs, when they land',
]);

/** The one sentence that must be true of core after §0a.1: nothing is walled. */
export const UNREGISTERED_RUNS_LINE =
  'wigolo runs fully without an account — registering only adds to it.';

/**
 * The telemetry claim, verbatim per PX brief §0a.4.
 *
 * It lives here rather than being retyped per surface because §0a.4 pins the
 * WORDING, not the gist: "nothing leaves your machine" was retired precisely
 * because six surfaces each said the privacy story slightly differently and one
 * of them was false. A single exported constant is what makes "the claim is the
 * same everywhere" checkable by a test instead of by reading.
 */
export const TELEMETRY_CLAIM =
  'no page content, URLs, or credentials leave your machine; usage stats do, off with one flag';

/** Bulleted unlock lines, ready to print under a heading. */
export function unlockLines(bullet = '·'): string[] {
  return REGISTRATION_UNLOCKS.map((u) => `${bullet} ${u}`);
}

/**
 * The registration nudge, as the block every surface renders.
 *
 * One block, one call to action, and the first line says the install already
 * works — because the reader is looking at a successful result when they see
 * it, and a prompt that implies otherwise reads as a wall being announced late.
 */
export function registrationNudgeLines(): string[] {
  return [
    UNREGISTERED_RUNS_LINE,
    '`wigolo register` unlocks:',
    ...unlockLines().map((l) => `  ${l}`),
    `Telemetry: ${TELEMETRY_CLAIM} (WIGOLO_TELEMETRY=off).`,
    'Shown once. It will not appear again.',
  ];
}

/** The nudge as one text block — the MCP footer and the CLI line share it. */
export function registrationNudgeText(): string {
  return registrationNudgeLines().join('\n');
}
