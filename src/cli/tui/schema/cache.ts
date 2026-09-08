import type { CategoryDef } from './types.js';
import { field } from './from-registry.js';

export const cacheCategory: CategoryDef = {
  id: 'cache',
  label: 'Cache',
  description: 'Local data directory and cache TTLs',
  fields: [
    field('dataDir', {
      label: 'Data directory',
      propagateToAgents: false,
      help: 'Wigolo data + cache directory',
    }),
    field('cacheTtlSearch', {
      label: 'Search cache TTL (s)',
      min: 60,
      max: 604800,
      help: 'Search cache TTL (seconds)',
    }),
    field('cacheTtlContent', {
      label: 'Content cache TTL (s)',
      min: 60,
      max: 2592000,
      help: 'Page-content cache TTL (seconds)',
    }),
  ],
};
