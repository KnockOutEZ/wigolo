// The one-shot local-LLM seam published on `wigolo/llm` (SD9-C2, mini-spec §2).
//
// Composition only. It resolves the LOCAL rung of the shipped ladder
// (`resolveLocalModelTier`) and, when that rung answers, routes exactly one
// prompt -> text call to it through `runLlmText`'s explicit per-call `backend`
// override. No rung default moves, no provider behaviour is added, and no
// ambient `process.env` is read or written on the local path: the override is
// self-contained, so a concurrent caller can never re-route this call.
//
// The honesty law it exists to enforce (A-420-6): a caller either gets
// `backend: 'local'` or a typed `backend: 'unavailable'`. It NEVER falls
// through to a cloud provider resolved from ambient configuration. The
// BYOK rung lives ABOVE this seam, in the consumer, where the user can see it
// and where its cost is recorded — a silent cloud call under a "local model ·
// free" badge is the exact defect this shape prevents.
//
// Tool calling is deliberately absent: this is one-shot text only.

import { resolveLocalModelTier, type ResolveLocalModelTierOpts } from './local-tier.js';
import { runLlmText } from './run.js';

/**
 * Why the local rung could not answer.
 *
 *   - `no-local-model` : the tier is off, or nothing answered its probe. No
 *                        prompt left the process.
 *   - `call-failed`    : a server WAS resolved and the completion against it
 *                        failed (transport, non-2xx after retries, empty body).
 */
export type LocalCompletionUnavailableReason = 'no-local-model' | 'call-failed';

export interface LocalCompletionRequest {
  /** The user-turn prompt. */
  prompt: string;
  /**
   * Optional instruction text. Folded into the prompt here rather than sent as
   * a separate role, so this seam adds no message-shape behaviour to the
   * adapters it composes.
   */
  system?: string;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Local-rung resolution overrides (flag value, model, probe, picker). Injected
   * by tests; production callers pass nothing and get the configured ladder.
   */
  tier?: ResolveLocalModelTierOpts;
}

/** A completion that really ran on the user's own machine. */
export interface LocalCompletionOk {
  backend: 'local';
  text: string;
  /** The model the local server was asked for. */
  model: string;
  /** Base URL of the local server that answered. */
  endpoint: string;
  latencyMs: number;
  /** The local rung runs on the user's hardware: the call costs nothing. */
  costUsd: 0;
}

/** An honest refusal. Never a cloud call wearing a local label. */
export interface LocalCompletionUnavailable {
  backend: 'unavailable';
  reason: LocalCompletionUnavailableReason;
  /** Human-readable cause for `call-failed`; absent for `no-local-model`. */
  detail?: string;
}

export type LocalCompletionResult = LocalCompletionOk | LocalCompletionUnavailable;

/**
 * One-shot text completion against the local model ladder, or a typed
 * unavailability. Never throws for an absent or failing local server, and never
 * substitutes a cloud provider for one.
 */
export async function runLocalLlmText(
  req: LocalCompletionRequest,
): Promise<LocalCompletionResult> {
  const tier = await resolveLocalModelTier(req.tier ?? {});
  if (!tier) return { backend: 'unavailable', reason: 'no-local-model' };

  const prompt = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt;
  try {
    const result = await runLlmText({
      prompt,
      maxTokens: req.maxTokens,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      // Explicit endpoint + model: `runLlmText` takes the custom-backend branch
      // and reads nothing from env, so the cloud branch is unreachable here.
      backend: { url: tier.endpoint, model: tier.model },
    });
    return {
      backend: 'local',
      text: result.text,
      model: result.model,
      endpoint: tier.endpoint,
      latencyMs: result.latencyMs,
      costUsd: 0,
    };
  } catch (err) {
    return {
      backend: 'unavailable',
      reason: 'call-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
