import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';

export function saveInitConfig(dataDir: string, config: Record<string, unknown>): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'config.json');
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
  writeFileSync(path, JSON.stringify({ ...existing, ...config }, null, 2));
}

export function readInitConfig(dataDir: string): Record<string, unknown> {
  const path = join(dataDir, 'config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}
