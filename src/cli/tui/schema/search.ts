import type { CategoryDef } from './types.js';
import { validateNewTabSearchEngine } from '../../../config.js';

export const searchCategory: CategoryDef = {
  id: 'search',
  label: 'Search',
  description: 'Search backend, reranker, and embedding model',
  fields: [
    {
      key: 'WIGOLO_SEARCH',
      settingsPath: 'searchBackend',
      label: 'Backend',
      kind: 'select',
      options: [
        { value: 'core', label: 'Core', hint: 'direct engines + RRF + ML rerank' },
        { value: 'searxng', label: 'SearXNG', hint: 'legacy aggregator' },
        { value: 'hybrid', label: 'Hybrid', hint: 'core with smart fallback' },
      ],
      default: 'core',
      help: 'Search backend',
    },
    {
      key: 'WIGOLO_NEW_TAB_SEARCH_ENGINE',
      settingsPath: 'newTabSearchEngine',
      label: 'New-tab search engine',
      kind: 'text',
      default: 'google',
      help: 'google, duckduckgo, bing, wigolo, or an HTTPS URL containing {searchTerms}',
      validate: (value) => {
        const result = validateNewTabSearchEngine(value);
        return result.valid ? null : result.message;
      },
      propagateToAgents: false,
    },
    {
      key: 'WIGOLO_RERANKER',
      settingsPath: 'reranker',
      label: 'Reranker',
      kind: 'toggle',
      default: true,
      help: 'Use ML reranker for results',
    },
    {
      key: 'WIGOLO_RERANKER_MODEL',
      settingsPath: 'rerankerModel',
      label: 'Reranker model',
      kind: 'text',
      default: 'ms-marco-MiniLM-L-12-v2',
      help: 'FlashRank model name',
    },
    {
      key: 'WIGOLO_EMBEDDING_MODEL',
      settingsPath: 'embeddingModel',
      label: 'Embedding model',
      kind: 'text',
      default: 'all-MiniLM-L6-v2',
      help: 'Sentence-transformers model name',
    },
  ],
};
