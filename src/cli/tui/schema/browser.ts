import type { CategoryDef } from './types.js';
import { field } from './from-registry.js';

export const browserCategory: CategoryDef = {
  id: 'browser',
  label: 'Browser',
  description: 'Engine used for JS-rendered pages',
  fields: [
    field('browserTypes', {
      label: 'Engine',
      kind: 'select',
      options: [{ value: 'chromium', label: 'Chromium', hint: 'default' }],
      futureNote: 'More engines coming soon (Firefox, WebKit).',
      help: 'Browser engine used by fetch/crawl when JS rendering is needed.',
    }),
    field('maxBrowsers', {
      label: 'Max concurrent',
      min: 1,
      max: 16,
      help: 'Concurrent browser instances. Higher = faster but more RAM.',
    }),
    field('browserIdleTimeoutMs', {
      label: 'Idle timeout (ms)',
      min: 1000,
      max: 600000,
    }),
  ],
};
