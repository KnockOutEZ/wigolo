/**
 * §7 row 11 — "browser closed mid-run → the agent gets a clean tool error, never silence".
 *
 * A run outlives every surface (law 2), and the browser is a surface. When the engine goes away
 * under a live host — its process dies, the window is closed, the tab group is destroyed — the
 * in-flight call has no page to answer from. What the agent must NOT get is what it got before:
 * an escaping exception that surfaces as a transport-level failure naming no run, or worse, a call
 * that never returns. What it gets instead is this: a structured, named, run-addressed error it can
 * act on, with the §4.4 footer attached by the dispatch exit so the watch link rides along.
 *
 * DISTINCT FROM `studio_host_unreachable`. That one means the HOST process is gone (a stale
 * handle, a dead endpoint) and is raised on the stdio side. This one means the host is alive and
 * answering, and the BROWSER under it is not — a different fact, a different remedy, so a different
 * code (mini-spec §4.3).
 *
 * CLASSIFICATION IS DELIBERATELY NARROW. The signatures below are the engine's own words for
 * "there is no page any more". Anything wider — a bare `ECONNRESET`, any error containing "closed"
 * — would relabel ordinary failures as a dead browser and send the agent to re-open a browser that
 * never closed. An unmatched error keeps its old behaviour (it propagates), which is the honest
 * degradation: a mislabelled cause is worse than an unlabelled one.
 *
 * Reversal condition: if a real browser-death signature is observed in the wild that this list does
 * not carry, add the signature — never widen to a substring like "closed".
 *
 * Capability language: every user-facing string here says "browser engine". No engine, library or
 * protocol name reaches the agent.
 */
import type { StudioToolError } from './studio-dispatch.js';

/** The stable machine code, never a sentence — same contract as every other `error_reason`. */
export const BROWSER_CLOSED = 'browser_closed';

/**
 * The engine's own vocabulary for a page/context/browser that no longer exists, lowercased. Each
 * entry is a phrase an engine emits verbatim; matching is substring-on-phrase, not on a single word.
 *
 * TWO ENGINES, ONE LIST. The first group is what the CLI host's engine says. The second is what the
 * desktop app's engine says, and it was missing for the whole of SD2: an app session that goes away
 * mid-run raises `Object has been destroyed` or `No target available`, neither of which contains the
 * word "closed" at all, so every one of them propagated as a raw internal error instead of the
 * §4.3 shape — silence where row 11 requires a clean tool error. The phrases below were read out of
 * the shipped engine binary rather than recalled, which is the only way a signature list stays true.
 */
const CLOSED_SIGNATURES: readonly string[] = Object.freeze([
  'target page, context or browser has been closed',
  'browser has been closed',
  'browser has disconnected',
  'browser closed unexpectedly',
  'target page or service worker has been closed',
  'page has been closed',
  'session closed',
  'target closed',
  'the browser engine closed',
  // The desktop app's engine. `object has been destroyed` is what it raises for any call onto a
  // window, view or web-contents handle that no longer exists; `no target available` is its
  // debugging channel answering for a target that has gone. The other two name the same fact one
  // layer down, and `render frame was disposed` is the shared prefix of both messages that carry it.
  'object has been destroyed',
  'no target available',
  'webcontents was destroyed',
  'render frame was disposed',
]);

/** Error classes an engine raises for the same fact without a matching message. */
const CLOSED_ERROR_NAMES: readonly string[] = Object.freeze(['targetclosederror', 'browserclosederror']);

/** Follow `cause` chains: engines wrap the close in a call-site error more often than not. */
const MAX_CAUSE_DEPTH = 5;

export function isBrowserClosedError(err: unknown, depth = 0): boolean {
  if (err === null || err === undefined || depth > MAX_CAUSE_DEPTH) return false;

  if (typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.name === 'string' && CLOSED_ERROR_NAMES.includes(e.name.toLowerCase())) return true;
    if (typeof e.message === 'string' && matchesSignature(e.message)) return true;
    if (e.cause !== undefined && isBrowserClosedError(e.cause, depth + 1)) return true;
    return false;
  }

  return typeof err === 'string' && matchesSignature(err);
}

function matchesSignature(text: string): boolean {
  const lowered = text.toLowerCase();
  return CLOSED_SIGNATURES.some((signature) => lowered.includes(signature));
}

/**
 * The §4.3 wire shape. `run` is present whenever the call resolved to one — an agent that knows the
 * run id can watch it, resume it or end it; an agent handed only "closed" can do none of those.
 */
export function browserClosedError(runId?: string): StudioToolError {
  const run = runId?.trim();
  return {
    error_reason: BROWSER_CLOSED,
    ...(run ? { run } : {}),
    hint: run
      ? `The browser engine closed while run ${run} was in flight. The run and its log survive; results so far are at the watch link. Re-open the browser and resume, or end the run.`
      : 'The browser engine closed while this call was in flight. The run and its log survive; results so far are at the watch link. Re-open the browser and resume, or end the run.',
  };
}
