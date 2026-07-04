// Opt-in auto-detect ladder for a local language model server.
//
// This is the ADD-ALONGSIDE seam consumed by the extract / research / agent
// slices (C1/C2). It does NOT change the existing keyless / cloud LLM path:
// `isLlmConfigured()` and `resolveCustomBackend()` are untouched. When the
// `WIGOLO_LOCAL_LLM` knob is off (the default) this resolver returns null and
// makes zero network calls, so the keyless benchmark is byte-for-byte identical.
//
// Ladder ordering a consumer should express (this module only reports the local
// rung; C1/C2 implement the surrounding fallback):
//
//   host-sampling  >  local model (this tier)  >  deterministic
//
// i.e. prefer the host's MCP sampling when available; otherwise, when this tier
// reports `available`, route synthesis through the local model; otherwise fall
// back to the deterministic keyless path.

import { getConfig } from '../../../config.js';
import { probeOllama } from '../../../cli/ollama-probe.js';
import { pickOllamaModel, DEFAULT_OLLAMA_BASE_URL } from './custom-backend.js';

/**
 * A reachable local language model server. `available` is always `true` — the
 * resolver returns `null` (not `{ available: false }`) when nothing is usable,
 * so a consumer can branch on a simple truthiness check.
 *
 *   - `endpoint` : base URL to reach the server (no `/v1/...` suffix).
 *   - `model`    : the model name to request (explicit knob, else auto-picked).
 *   - `source`   : `'auto'` when discovered via the default endpoint, or
 *                  `'endpoint'` when an explicit endpoint value was configured.
 */
export interface LocalModelTier {
  available: true;
  endpoint: string;
  model: string;
  source: 'auto' | 'endpoint';
}

type ProbeFn = (baseUrl: string, fetchImpl?: typeof fetch) => Promise<{ reachable: boolean }>;
type PickModelFn = (baseUrl: string, fetchImpl?: typeof fetch, signal?: AbortSignal) => Promise<string>;

export interface ResolveLocalModelTierOpts {
  /** `WIGOLO_LOCAL_LLM`: 'off' (default) | 'auto' | explicit http(s) endpoint. */
  localLlm?: string;
  /** `WIGOLO_LOCAL_LLM_MODEL`: preferred model; null/undefined ⇒ auto-pick. */
  localLlmModel?: string | null;
  /** Reachability probe; injected for tests. Defaults to the shared probe. */
  probe?: ProbeFn;
  /** Model picker; injected for tests. Defaults to the installed-model picker. */
  pickModel?: PickModelFn;
}

// Process-lifetime resolution cache keyed by the resolved endpoint. A negative
// (null) is cached just like a positive, so a missing server costs at most ONE
// fast probe for the whole process and never a per-call latency penalty.
const resolutionCache = new Map<string, LocalModelTier | null>();

/** Clear the process-lifetime cache. For tests only. */
export function resetLocalModelTierCache(): void {
  resolutionCache.clear();
}

/**
 * Resolve the auto endpoint for `WIGOLO_LOCAL_LLM=auto`: a dedicated
 * `WIGOLO_LOCAL_LLM_BASE_URL` wins, then the shared `WIGOLO_LLM_BASE_URL`
 * (already honored by the custom backend), then the default local server.
 */
function resolveAutoEndpoint(env: Record<string, string | undefined>): string {
  return env.WIGOLO_LOCAL_LLM_BASE_URL ?? env.WIGOLO_LLM_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
}

/**
 * Given the local-LLM config, report whether a local model is available and how
 * to reach it — the reusable contract C1/C2 consume. Returns `null` when the
 * tier is off, when no server answers, or on any probe error (never throws).
 *
 * The endpoint + `source` are derived from the flag value:
 *   - 'auto'            → default (or *_BASE_URL) endpoint, source 'auto'.
 *   - an http(s):// URL → that endpoint verbatim, source 'endpoint'.
 *   - anything else     → off (null, no probe).
 *
 * The result is cached per endpoint for the process lifetime.
 */
export async function resolveLocalModelTier(
  opts: ResolveLocalModelTierOpts = {},
): Promise<LocalModelTier | null> {
  const cfg = safeConfig();
  const localLlm = opts.localLlm ?? cfg?.localLlm ?? 'off';

  let endpoint: string;
  let source: 'auto' | 'endpoint';
  if (localLlm === 'auto') {
    endpoint = resolveAutoEndpoint(process.env);
    source = 'auto';
  } else if (localLlm.startsWith('http://') || localLlm.startsWith('https://')) {
    endpoint = localLlm;
    source = 'endpoint';
  } else {
    // 'off' or any unrecognized value → disabled, no probe.
    return null;
  }

  if (resolutionCache.has(endpoint)) return resolutionCache.get(endpoint) ?? null;

  const probe = opts.probe ?? probeOllama;
  const pickModel = opts.pickModel ?? pickOllamaModel;
  const preferredModel = opts.localLlmModel ?? cfg?.localLlmModel ?? undefined;

  let resolved: LocalModelTier | null = null;
  try {
    const { reachable } = await probe(endpoint);
    if (reachable) {
      const model = preferredModel ?? (await pickModel(endpoint));
      resolved = { available: true, endpoint, model, source };
    }
  } catch {
    // Absent / slow / malformed server — degrade to null. Never throw, never
    // spam the log: absence is a normal state, not an error.
    resolved = null;
  }

  resolutionCache.set(endpoint, resolved);
  return resolved;
}

/** getConfig() reads disk; guard so a config failure never breaks the resolver. */
function safeConfig(): { localLlm: string; localLlmModel: string | null } | null {
  try {
    const c = getConfig();
    return { localLlm: c.localLlm, localLlmModel: c.localLlmModel };
  } catch {
    return null;
  }
}
