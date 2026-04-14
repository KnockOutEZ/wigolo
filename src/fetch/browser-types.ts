import type { BrowserType } from '../types.js';

const VALID_BROWSER_TYPES: ReadonlySet<string> = new Set(['chromium', 'firefox', 'webkit']);

const DEFAULT_BROWSER_TYPES: BrowserType[] = ['chromium'];

function warn(msg: string, data: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, module: 'fetch', data });
  process.stderr.write(line + '\n');
}

export function parseBrowserTypes(input: string | undefined | null): BrowserType[] {
  if (!input || typeof input !== 'string') {
    return [...DEFAULT_BROWSER_TYPES];
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return [...DEFAULT_BROWSER_TYPES];
  }

  const parts = trimmed
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (parts.length === 0) {
    return [...DEFAULT_BROWSER_TYPES];
  }

  const seen = new Set<string>();
  const valid: BrowserType[] = [];
  const invalid: string[] = [];

  for (const part of parts) {
    if (!VALID_BROWSER_TYPES.has(part)) {
      invalid.push(part);
      continue;
    }
    if (seen.has(part)) {
      continue;
    }
    seen.add(part);
    valid.push(part as BrowserType);
  }

  if (invalid.length > 0) {
    warn('ignored invalid browser types', { invalid, valid: [...valid] });
  }

  if (valid.length === 0) {
    warn('no valid browser types found, falling back to chromium', { input });
    return [...DEFAULT_BROWSER_TYPES];
  }

  return valid;
}
