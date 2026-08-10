import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { LLMCallOpts, LLMExtractResult } from './types.js';

const DEFAULT_MODEL = 'claude-haiku-4-5';
const TOOL_NAME = 'extract';

export async function callAnthropic(
  opts: LLMCallOpts,
  apiKey: string,
): Promise<LLMExtractResult> {
  // Loaded on use, not at import. Core search/fetch/crawl/extract/cache are
  // keyless, and this module sits on the extract path, so a static import put
  // the vendor SDK on the startup graph of users who never call a model.
  // The specifier is a literal: esbuild drops import(variable), and the
  // provider would then resolve in tests and dev but not in the packaged binary.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const model = opts.modelOverride ?? DEFAULT_MODEL;
  const start = Date.now();

  const response = await client.messages.create(
    {
      model,
      max_tokens: 2048,
      tools: [
        {
          name: TOOL_NAME,
          description: 'Return the extracted fields as structured JSON.',
          input_schema: opts.jsonSchema as Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: opts.prompt }],
    },
    { signal: opts.signal },
  );

  const block = (response.content ?? []).find(
    (b: { type: string }) => b.type === 'tool_use',
  ) as { type: 'tool_use'; name: string; input: Record<string, unknown> } | undefined;

  if (!block) {
    throw new Error('anthropic: no tool_use block in response');
  }

  return {
    values: block.input,
    provider: 'anthropic',
    model: response.model ?? model,
    cached: false,
    latencyMs: Date.now() - start,
  };
}
