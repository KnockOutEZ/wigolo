export type LLMProvider = 'anthropic' | 'openai' | 'gemini' | 'groq';

export interface LLMExtractResult {
  values: Record<string, unknown>;
  provider: LLMProvider;
  model: string;
  cached: boolean;
  latencyMs: number;
  warnings?: string[];
}

export interface LLMCallRecord {
  modelId: string;
  promptHash: string;
  schemaHash: string;
  response: string;
  createdAt: number;
  expiresAt: number;
}

export interface LLMCallOpts {
  prompt: string;
  jsonSchema: Record<string, unknown>;
  modelOverride?: string;
  signal?: AbortSignal;
}
