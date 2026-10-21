import type { CategoryDef } from './types.js';

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
      key: 'WIGOLO_RERANKER',
      settingsPath: 'reranker',
      label: 'Reranker',
      kind: 'select',
      options: [
        { value: 'onnx', label: 'On-device ONNX' },
        { value: 'remote', label: 'Remote endpoint' },
        { value: 'none', label: 'Disabled' },
      ],
      default: 'onnx',
      help: 'Result reranking backend',
    },
    {
      key: 'WIGOLO_RERANKER_MODEL',
      settingsPath: 'rerankerModel',
      label: 'Reranker model',
      kind: 'text',
      default: 'bge-reranker-v2-m3',
      help: 'Remote rerank model name (ONNX uses its bundled model)',
    },
    {
      key: 'WIGOLO_RERANK_API_BASE',
      settingsPath: 'rerankApiBase',
      label: 'Remote rerank base URL',
      kind: 'text',
      help: 'Base URL ending in /v1; Wigolo sends POST /rerank',
      visible: (ctx) => (ctx.pending.reranker ?? ctx.current.reranker) === 'remote',
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
