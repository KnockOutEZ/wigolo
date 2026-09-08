import type { CategoryDef } from './types.js';
import { field } from './from-registry.js';

export const llmCategory: CategoryDef = {
  id: 'llm',
  label: 'LLM Provider',
  description: 'Provider + API key for research/agent tools',
  fields: [
    field('llmProvider', {
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
    }),
    field('llmApiKey', {
      label: 'API key',
      propagateToAgents: true,
      help: 'Stored in OS keychain when available; never written to config.json.',
      // Ollama is keyless — hide the API-key field when it's the chosen provider
      // so the wizard never prompts for a credential the local server ignores.
      visible: (ctx) => (ctx.pending.llmProvider ?? ctx.current.llmProvider) !== 'ollama',
    }),
  ],
};
