import type { CategoryDef } from './types.js';

const usesApiKey = (ctx: Parameters<NonNullable<CategoryDef['fields'][number]['visible']>>[0]): boolean =>
  (ctx.pending.llmProvider ?? ctx.current.llmProvider) !== 'ollama';

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
        {
          value: 'ollama',
          label: 'Ollama (local LLM server)',
          hint: 'Keyless — runs against a local Ollama server, no API key needed',
        },
      ],
      default: 'anthropic',
      required: true,
    },
    {
      key: 'WIGOLO_LLM_API_KEY',
      settingsPath: 'llmApiKey',
      label: 'API key',
      kind: 'masked',
      secret: true,
      propagateToAgents: true,
      required: usesApiKey,
      help: 'Stored in OS keychain when available; never written to config.json.',
      // Ollama is keyless — hide the API-key field when it's the chosen provider
      // so the wizard never prompts for a credential the local server ignores.
      visible: usesApiKey,
    },
  ],
};
