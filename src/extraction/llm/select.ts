import type { LLMProvider } from './types.js';

const PROVIDER_ORDER: LLMProvider[] = ['anthropic', 'openai', 'gemini', 'groq'];

const PROVIDER_ENV: Record<LLMProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  groq: 'GROQ_API_KEY',
};

export function selectProvider(
  env: Record<string, string | undefined>,
): LLMProvider | null {
  const override = env.WIGOLO_LLM_PROVIDER;
  if (override && (PROVIDER_ORDER as string[]).includes(override)) {
    const p = override as LLMProvider;
    if (env[PROVIDER_ENV[p]]) return p;
  }
  for (const p of PROVIDER_ORDER) {
    if (env[PROVIDER_ENV[p]]) return p;
  }
  return null;
}

export function providerEnvVar(p: LLMProvider): string {
  return PROVIDER_ENV[p];
}

export function allProviders(): readonly LLMProvider[] {
  return PROVIDER_ORDER;
}
