// Resolve the model name to use for a given provider. Precedence:
//   1. caller-supplied override (synthesis vs extract may differ)
//   2. provider-specific env (e.g. WIGOLO_LLM_MODEL_GEMINI)
//   3. universal env (WIGOLO_LLM_MODEL) — applies to whichever provider is active
//   4. provider default (per adapter)

import type { LLMProvider } from './types.js';

const PROVIDER_DEFAULTS: Record<LLMProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash-lite',
  groq: 'llama-3.3-70b-versatile',
};

const PROVIDER_ENV: Record<LLMProvider, string> = {
  anthropic: 'WIGOLO_LLM_MODEL_ANTHROPIC',
  openai: 'WIGOLO_LLM_MODEL_OPENAI',
  gemini: 'WIGOLO_LLM_MODEL_GEMINI',
  groq: 'WIGOLO_LLM_MODEL_GROQ',
};

export function resolveModel(
  provider: LLMProvider,
  callerOverride?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (callerOverride) return callerOverride;
  const providerSpecific = env[PROVIDER_ENV[provider]];
  if (providerSpecific) return providerSpecific;
  const universal = env.WIGOLO_LLM_MODEL;
  if (universal) return universal;
  return PROVIDER_DEFAULTS[provider];
}

export function providerModelEnvVar(provider: LLMProvider): string {
  return PROVIDER_ENV[provider];
}

export function providerDefaultModel(provider: LLMProvider): string {
  return PROVIDER_DEFAULTS[provider];
}
