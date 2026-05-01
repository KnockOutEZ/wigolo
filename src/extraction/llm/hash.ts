import { createHash } from 'node:crypto';

export function hashPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

export function hashSchema(schema: unknown): string {
  return createHash('sha256').update(stableStringify(schema)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) =>
      JSON.stringify(k) +
      ':' +
      stableStringify((value as Record<string, unknown>)[k]),
  );
  return '{' + parts.join(',') + '}';
}
