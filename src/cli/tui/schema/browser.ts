import type { CategoryDef } from './types.js';

export const browserCategory: CategoryDef = {
  id: 'browser',
  label: 'Browser',
  description: 'Engine used for JS-rendered pages',
  fields: [
    {
      key: 'WIGOLO_BROWSER_TYPES',
      settingsPath: 'browserTypes',
      label: 'Engine',
      kind: 'select',
      options: [{ value: 'chromium', label: 'Chromium', hint: 'default' }],
      default: 'chromium',
      futureNote: 'More engines coming soon (Firefox, WebKit).',
      help: 'Headless browser used by fetch/crawl when JS rendering is needed.',
    },
    {
      key: 'WIGOLO_MAX_BROWSERS',
      settingsPath: 'maxBrowsers',
      label: 'Max concurrent',
      kind: 'number',
      default: 3,
      min: 1,
      max: 16,
      help: 'Concurrent browser instances. Higher = faster but more RAM.',
    },
    {
      key: 'WIGOLO_BROWSER_IDLE_TIMEOUT_MS',
      settingsPath: 'browserIdleTimeoutMs',
      label: 'Idle timeout (ms)',
      kind: 'number',
      default: 30000,
      min: 1000,
      max: 600000,
    },
    {
      key: 'PLAYWRIGHT_LOAD_TIMEOUT_MS',
      settingsPath: 'playwrightLoadTimeoutMs',
      label: 'Page load timeout (ms)',
      kind: 'number',
      default: 15000,
      min: 1000,
      max: 120000,
      help: 'How long the browser tier waits for a page to reach network idle after navigation.',
    },
  ],
};
