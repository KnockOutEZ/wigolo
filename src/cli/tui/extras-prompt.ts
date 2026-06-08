import { select, input, password } from '@inquirer/prompts';
import { saveInitConfig, readInitConfig } from './utils/config-writer.js';
import type { LLMProvider } from '../../integrations/cloud/llm/types.js';

// Providers that have a runtime keystore entry. Keep in sync with the
// llmProvider select options in schema/llm.ts (groq is keystore-capable but
// not offered in the interactive select to match the --provider flag set).
const PROVIDER_CHOICES: ReadonlyArray<{ name: string; value: LLMProvider }> = [
  { name: 'Anthropic (Claude)', value: 'anthropic' },
  { name: 'OpenAI (GPT)', value: 'openai' },
  { name: 'Google Gemini', value: 'gemini' },
];

// Index signature lets us pass an ExtrasChoices straight to saveInitConfig
// (which writes Record<string, unknown>) without an `as` cast.
export interface ExtrasChoices extends Record<string, unknown> {
  engine?: 'v1' | 'searxng';
  rssFeeds?: string[];
  llmEndpoint?: string;
  /** Chosen LLM provider id. The API key is NEVER stored here — it goes to the keychain. */
  llmProvider?: LLMProvider;
}

// Three optional onboarding questions. Each defaults to "skip" so the
// behaviour of users who hit Enter past every prompt is identical to today.
// Persists each set field to ~/.wigolo/config.json; absent fields stay
// untouched (saveInitConfig merges, not replaces).
export async function promptExtras(dataDir: string): Promise<ExtrasChoices> {
  const existing = readInitConfig(dataDir);
  const result: ExtrasChoices = {};

  try {
    const engine = (await select({
      message: 'Search engine? (v1 = direct engines + verticals, searxng = legacy)',
      choices: [
        { name: 'skip (keep current setting)', value: 'skip' as const },
        { name: 'v1 (recommended)', value: 'v1' as const },
        { name: 'searxng (legacy)', value: 'searxng' as const },
      ],
      default: 'skip',
    })) as 'skip' | 'v1' | 'searxng';
    if (engine !== 'skip') result.engine = engine;

    const rss = await input({
      message: 'RSS feed URLs to include in the news vertical (comma-separated, blank to skip)',
      default: typeof existing.rssFeeds === 'string' ? existing.rssFeeds : '',
    });
    const feeds = rss
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (feeds.length > 0) result.rssFeeds = feeds;

    const llm = await input({
      message: 'Local LLM endpoint URL for research/extract fallback (blank to skip)',
      default: typeof existing.llmEndpoint === 'string' ? existing.llmEndpoint : '',
    });
    if (llm.trim()) result.llmEndpoint = llm.trim();

    // Optional LLM provider + API key for the research/agent tools. Defaults to
    // "skip" so users who hit Enter past everything keep the prior behaviour.
    // Provider is a non-secret select → persisted to config.json as llmProvider.
    // The key is masked and routed straight to the keychain (storeKey); it is
    // never written to config.json or returned in the choices object.
    const provider = (await select({
      message: 'LLM provider for research/agent tools? (key stored in OS keychain)',
      choices: [{ name: 'skip (configure later)', value: 'skip' as const }, ...PROVIDER_CHOICES],
      default: 'skip',
    })) as 'skip' | LLMProvider;
    if (provider !== 'skip') {
      result.llmProvider = provider;
      const apiKey = await password({
        message: `${provider} API key (blank to skip — set WIGOLO_LLM_API_KEY later)`,
        mask: true,
      });
      if (apiKey.trim()) {
        const { storeKey } = await import('../../security/key-store.js');
        await storeKey(provider, apiKey.trim(), { dataDir });
      }
    }
  } catch (err) {
    // SIGINT (Ctrl-C) or non-TTY surfaces as an error from @inquirer/prompts.
    // Treat as "skip everything" — caller continues without touching config.
    if (err instanceof Error && /ExitPromptError|force closed/i.test(err.message)) {
      return {};
    }
    throw err;
  }

  if (Object.keys(result).length > 0) {
    saveInitConfig(dataDir, result);
  }

  return result;
}
