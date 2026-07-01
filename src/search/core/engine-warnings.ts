// Promote per-engine error telemetry into a top-level
// `engine_warnings` list on the search response.
//
// WHY: 401 / 400 / 5xx engine failures were only visible
// when callers opted into the debug-shaped `include_engine_outcomes` flag.
// That made lobsters 400 and github-code 401 silently invisible to every
// normal caller — the response looked successful while one engine was
// completely broken. Promoting these errors to a default-emitted top-level
// field restores user trust and gives clients a stable hook for retry /
// alerting logic.
//
// The mapping keeps codes stable so callers can match-case on them:
//   * 'http_<code>'  — extracted from the engine's error message when the
//                      engine raised an explicit HTTP status (the existing
//                      engine adapters all do `throw new Error("X returned 401")`).
//   * 'error'        — generic catch-all for non-HTTP failures (DNS, abort,
//                      timeout, JSON parse).
//
// 401 → env hint table: engines that document an API-key env var get the
// var name attached as an actionable next step. Today this is just the
// GitHub code adapter (`WIGOLO_GITHUB_TOKEN`), but the registry is here so
// future API-key-requiring engines drop in trivially.

import type { EngineTelemetry, EngineWarning } from '../../types.js';

/**
 * Engine env-var hints. Keyed by engine name (matches EngineTelemetry.name).
 * When an engine returns 401 (or 403 — some APIs use 403 for missing auth),
 * the corresponding env-var hint is attached to the warning so users know
 * the fix shape without having to dig into adapter source.
 */
const ENGINE_AUTH_HINTS: Record<string, string> = {
  // GitHub code search returns 401 (or 403 for rate-limit-with-auth) when
  // the request is unauthenticated against private orgs or hits a hard
  // search limit. The token is read by the existing adapter; the hint names
  // the env var so users can set it in their MCP host config.
  'github-code': 'set WIGOLO_GITHUB_TOKEN to lift GitHub API rate limits',
  // Brave Image is gated behind the same key as the Brave web
  // engine. When the orchestrator dispatches the adapter and the key is
  // missing, the adapter raises `BRAVE_API_KEY not set ...` which we
  // detect below and convert to a `needs_key` warning code.
  'brave-image': 'set BRAVE_API_KEY to enable Brave image search',
  brave: 'set BRAVE_API_KEY to enable the Brave web engine',
};

/**
 * Pattern that flags an engine error as a "missing API key" failure. The
 * legacy 401/403 path catches token-rejected calls; this catches the case
 * where the adapter refuses to dispatch at all because no key is configured
 * (a more honest signal than letting the call leave the box with no token).
 */
const MISSING_KEY_PATTERN = /\b([A-Z][A-Z0-9_]+_API_KEY|GITHUB_TOKEN|BRAVE_API_KEY)\b.*not set\b|\bnot set\b.*\b([A-Z][A-Z0-9_]+_API_KEY|GITHUB_TOKEN|BRAVE_API_KEY)\b|set\s+([A-Z][A-Z0-9_]+_API_KEY|GITHUB_TOKEN|BRAVE_API_KEY)/;

/**
 * Extract a stable failure code from an engine's error message. Engines
 * raise strings like "GitHub code returned 401" or "Lobsters returned 400"
 * — we pull the numeric status out so callers can match on it. Falls back
 * to `'error'` when no HTTP-status pattern is found (DNS, timeout, abort).
 *
 * Adds `needs_key` for messages naming a missing API-key env
 * var (e.g. `"BRAVE_API_KEY not set"`). HTTP status detection takes
 * precedence so a 401 from a configured-but-rejected key still surfaces
 * as `http_401` and the env-hint comes from the auth-hint table.
 */
function classifyError(message: string | undefined): { code: string; httpStatus: number | null } {
  if (typeof message !== 'string' || message.length === 0) {
    return { code: 'error', httpStatus: null };
  }
  const httpMatch = message.match(/\b(\d{3})\b/);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status >= 400 && status < 600) {
      return { code: `http_${status}`, httpStatus: status };
    }
  }
  // Missing API key — the adapter refused to dispatch because the env var
  // was unset. Distinct from a 401 (key present but rejected) so callers
  // can branch on the remediation: a 401 means rotate / re-issue the key,
  // a `needs_key` means set it.
  if (MISSING_KEY_PATTERN.test(message)) {
    return { code: 'needs_key', httpStatus: null };
  }
  // Common non-HTTP shapes the adapters surface.
  if (/timeout|aborted|abort/i.test(message)) {
    return { code: 'timeout', httpStatus: null };
  }
  if (/dns|ENOTFOUND|getaddrinfo/i.test(message)) {
    return { code: 'dns', httpStatus: null };
  }
  return { code: 'error', httpStatus: null };
}

/**
 * Build the top-level `engine_warnings` array from `engine_telemetry`.
 *
 * Contract:
 *   - One warning per engine with outcome === 'error'. We do NOT emit
 *     warnings for outcome === 'skipped' (that's a deliberate cache-only
 *     path or a non-applicable vertical, not a failure).
 *   - The returned array is always defined — empty when no engine errored
 *     so callers can branch on `engine_warnings.length` without optional
 *     chaining gymnastics.
 *   - For 401 / 403 outcomes on an engine listed in ENGINE_AUTH_HINTS,
 *     the warning carries `hint` so users see the env-var fix shape.
 */
export function buildEngineWarnings(
  telemetry: EngineTelemetry[] | undefined,
): EngineWarning[] {
  if (!telemetry || telemetry.length === 0) return [];
  const warnings: EngineWarning[] = [];
  for (const t of telemetry) {
    if (t.outcome !== 'error') continue;
    const { code, httpStatus } = classifyError(t.error);
    const warning: EngineWarning = {
      engine: t.name,
      code,
      ...(t.error ? { message: t.error } : {}),
    };
    // Auth-shaped failures get the documented env-var hint when the engine
    // appears in the registry. Stick to 401/403 for HTTP outcomes — other
    // 4xx codes are usually engine-side bugs we can't help with.
    if ((httpStatus === 401 || httpStatus === 403) && ENGINE_AUTH_HINTS[t.name]) {
      warning.hint = ENGINE_AUTH_HINTS[t.name];
    }
    // `needs_key` failures always attach the hint (when registered) — the
    // whole point of the code is to name the missing env var.
    if (code === 'needs_key' && ENGINE_AUTH_HINTS[t.name]) {
      warning.hint = ENGINE_AUTH_HINTS[t.name];
    }
    warnings.push(warning);
  }
  return warnings;
}
