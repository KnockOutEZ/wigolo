import type { CategoryDef } from './types.js';
import { field } from './from-registry.js';
import { validateNewTabSearchEngine } from '../../../config.js';

export const searchCategory: CategoryDef = {
  id: 'search',
  label: 'Search',
  description: 'Search backend, reranker, and embedding model',
  fields: [
    field('searchBackend', {
      label: 'Backend',
      kind: 'select',
      options: [
        { value: 'core', label: 'Core', hint: 'direct engines + RRF + ML rerank' },
        { value: 'searxng', label: 'Aggregator', hint: 'legacy metasearch aggregator' },
        { value: 'hybrid', label: 'Hybrid', hint: 'core with smart fallback' },
      ],
      help: 'Search backend',
    }),
    field('newTabSearchEngine', {
      label: 'New-tab search engine',
      kind: 'text',
      help: 'google, duckduckgo, bing, wigolo, or an HTTPS URL containing {searchTerms}',
      validate: (value) => {
        const result = validateNewTabSearchEngine(value);
        return result.valid ? null : result.message;
      },
      propagateToAgents: false,
    }),
    field('reranker', {
      // Not a toggle: the resolver reads three values and ignores a boolean
      // outright (`envStr` drops a non-string persisted value), so the shipped
      // on/off switch wrote a setting that could never take effect.
      label: 'Reranker',
      kind: 'select',
      options: [
        { value: 'onnx', label: 'ML reranker', hint: 'default — local cross-encoder' },
        { value: 'none', label: 'Off', hint: 'engine order, no rerank' },
        { value: 'custom', label: 'Custom', hint: 'supplied by a plugin' },
      ],
      help: 'Which reranker orders search results',
    }),
    field('rerankerModel', {
      label: 'Reranker model',
      kind: 'text',
      help: 'Reranker model name',
    }),
    field('embeddingModel', {
      label: 'Embedding model',
      kind: 'text',
      help: 'Embedding model name',
    }),
  ],
};
