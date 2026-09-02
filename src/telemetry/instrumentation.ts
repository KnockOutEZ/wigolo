/**
 * Shared seam helpers: the pure mappings the instrumentation call sites need to turn a
 * runtime value into a member of the closed dictionary.
 *
 * These live beside the dictionary rather than beside any one seam because five seams
 * across four layers need the same mapping — MCP dispatch, the daemon's REST dispatch, the
 * CLI one-shot, the REPL, and the search circuit breaker — and the alternative to one
 * shared module is either five copies of an eight-branch classifier or a layering
 * inversion where `src/search/` imports from `src/server/`.
 *
 * Every function here is TOTAL and closed-range: it returns a dictionary member or
 * `null`/`'internal'`, never a value derived from the input's text. That is what keeps the
 * Never list unrepresentable at the seams as well as in the schema — a URL, a query or a
 * path can be passed into any of these and cannot come back out.
 */
import { durationBucket, ENGINE_IDS, ERROR_CLASSES, TOOL_NAMES, type EngineId, type ErrorClass, type Surface, type ToolName } from './events.js';
import { emit } from './index.js';

/**
 * Only the ten wigolo tools are reportable. Everything else that reaches a dispatch
 * wrapper — `studio_*` pass-throughs, an unknown name, a hosted provider's tool — maps to
 * `null` and emits nothing, because a tool outside the enum has no representation and a
 * "reported as other" bucket would silently grow with every hosted surface.
 */
export function reportableTool(name: string): ToolName | null {
  // The REPL accepts `find-similar` as well as `find_similar`; the enum spells it one way.
  // Normalising here rather than at that one seam keeps every surface reporting the same
  // tool under the same name, which is the whole point of the enum.
  const normalized = name.replace(/-/g, '_');
  return (TOOL_NAMES as readonly string[]).includes(normalized) ? (normalized as ToolName) : null;
}

/**
 * An engine id degrades to `other` rather than to `null`: the engine roster grows (the RSS
 * engine already sits outside {@link ENGINE_IDS}), and a new engine silently dropping its
 * failures would make the reliability signal quietly wrong in exactly the case — a new,
 * unproven engine — where it matters most.
 */
export function reportableEngine(name: string): EngineId {
  return (ENGINE_IDS as readonly string[]).includes(name) ? (name as EngineId) : 'other';
}

/**
 * HTTP status → class. Only 4xx and 5xx have a class; anything else is not an HTTP-shaped
 * failure and the caller falls back to message classification.
 */
export function httpStatusClass(status: number): ErrorClass | null {
  if (!Number.isInteger(status)) return null;
  if (status >= 400 && status < 500) return 'http_4xx';
  if (status >= 500 && status < 600) return 'http_5xx';
  return null;
}

/**
 * Patterns are matched in a fixed precedence, most specific first, and the FIRST match
 * wins. The order is load-bearing:
 *
 *  1. `blocked` before `http_4xx` — an anti-bot challenge is usually served as a 403, and
 *     "we were blocked" is the fact worth counting; "a 4xx happened" is not.
 *  2. `dns` before `network` — a name that does not resolve is a distinct operator
 *     problem from a connection that was refused.
 *  3. `timeout` before `network` — an abort is not a transport failure.
 *  4. HTTP status last among the specific classes, so an explicit signal always beats a
 *     three-digit number that happens to appear in a message.
 *
 * The message is read ONLY to test these patterns. No part of it is returned, stored, or
 * placed on an event — the return type is the closed enum and nothing else.
 */
const PATTERNS: ReadonlyArray<readonly [ErrorClass, RegExp]> = [
  ['blocked', /\bcloudflare\b|\bcaptcha\b|\bchallenge\b|anti[-\s]?bot|access denied|\bblocked\b|\bforbidden\b|\bperimeterx\b|\bdatadome\b/i],
  ['dns', /\benotfound\b|\beai_again\b|getaddrinfo|\bdns\b/i],
  ['timeout', /\betimedout\b|\btimeout\b|timed out|\baborterror\b|\baborted\b|the operation was aborted/i],
  ['network', /\beconnrefused\b|\beconnreset\b|\beconnaborted\b|\bepipe\b|\behostunreach\b|\benetunreach\b|\benetdown\b|\becanceled\b|socket hang up|network error|fetch failed|premature close/i],
  ['invalid_input', /\binvalid\b|\bmalformed\b|\bmust be\b|\bis required\b|validation failed|\bzoderror\b|unrecognized key/i],
];

/**
 * `unknown` → a member of {@link ERROR_CLASSES}. Total: an input this cannot recognise is
 * `internal`, which is the honest answer rather than a guess.
 *
 * A numeric `status`/`statusCode` on the error object is consulted before the message, but
 * after the explicit block/transport patterns, per the precedence above.
 */
export function classifyErrorClass(err: unknown): ErrorClass {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // Underscores become spaces before matching. Half of what reaches these seams is a
  // snake_case machine code rather than prose (`blocked_by_challenge`,
  // `invalid_input`, `navigation_blocked`), and `\bchallenge\b` does not match inside
  // `by_challenge` because an underscore is a word character — so without this the
  // codes carrying the most reliable signal would all classify as `internal`.
  const message = raw.replace(/_/g, ' ');

  for (const [cls, pattern] of PATTERNS) {
    if (pattern.test(message)) return cls;
  }

  const status = readStatus(err);
  if (status !== null) {
    const fromStatus = httpStatusClass(status);
    if (fromStatus !== null) return fromStatus;
  }

  const inMessage = message.match(/\b([45]\d{2})\b/);
  if (inMessage) {
    const fromMessage = httpStatusClass(Number(inMessage[1]));
    if (fromMessage !== null) return fromMessage;
  }

  return 'internal';
}

/** A status carried as a property on the thrown value, whatever spelling the layer used. */
function readStatus(err: unknown): number | null {
  if (err === null || typeof err !== 'object') return null;
  const record = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'httpStatus'] as const) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return null;
}

/**
 * The one shape all four tool-dispatch seams report through — MCP, the daemon's REST
 * dispatch, the CLI one-shot and the REPL. Only `surface` differs between them, and it is
 * a parameter rather than something each seam derives, so the four can never disagree
 * about what they are calling themselves.
 *
 * Call this only BELOW the activation gate. Every gate is an early return, so a refused
 * call cannot reach a call site of this function — the "refused calls emit nothing"
 * requirement is a property of where the gates sit, which is checked by test, rather than
 * a flag anyone has to remember to pass.
 *
 * A failure emits BOTH events: `tool.run` with `ok: false` keeps the run counts and the
 * duration histogram complete, and `tool.error` adds the class. Emitting only the error
 * would make the two counters disagree about how many calls happened.
 */
export function recordToolTelemetry(
  tool: string,
  surface: Surface,
  ok: boolean,
  durationMs: number,
  failure?: unknown,
): void {
  const name = reportableTool(tool);
  if (name === null) return;
  emit({ name: 'tool.run', props: { tool: name, surface, ok, duration_bucket: durationBucket(durationMs) } });
  if (ok) return;
  emit({ name: 'tool.error', props: { tool: name, surface, error_class: classifyErrorClass(failure) } });
}

/** Re-exported so a seam needs one import, not two, to build an event. */
export { ERROR_CLASSES, type ErrorClass, type EngineId, type Surface, type ToolName };
