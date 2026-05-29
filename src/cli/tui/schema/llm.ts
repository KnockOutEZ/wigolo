import type { CategoryDef, Ctx } from './types.js';

export const llmCategory: CategoryDef = {
  id: 'llm',
  label: 'LLM Provider',
  description: 'Provider + API key for research/agent tools',
  fields: [
    {
      key: 'WIGOLO_LLM_PROVIDER',
      settingsPath: 'llmProvider',
      label: 'Provider',
      kind: 'select',
      options: [
        { value: 'anthropic', label: 'Anthropic (Claude)' },
        { value: 'openai', label: 'OpenAI (GPT)' },
        { value: 'gemini', label: 'Google Gemini' },
        { value: 'custom', label: 'Custom (OpenAI-compatible)' },
      ],
      default: 'anthropic',
    },
    {
      key: 'WIGOLO_LLM_API_KEY',
      settingsPath: 'llmApiKey',
      label: 'API key',
      kind: 'masked',
      secret: true,
      propagateToAgents: true,
      help: 'Stored in OS keychain when available; never written to config.json.',
    },
    {
      key: 'WIGOLO_LLM_BASE_URL',
      settingsPath: 'llmBaseUrl',
      label: 'Endpoint URL',
      kind: 'text',
      visible: (ctx: Ctx) =>
        (ctx.pending.llmProvider ?? ctx.current.llmProvider) === 'custom',
      help: 'Required for custom providers (Ollama, LM Studio, etc).',
    },
  ],
};
