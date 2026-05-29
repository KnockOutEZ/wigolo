import type { CategoryDef } from '../schema/types.js';

export interface PaletteEntry {
  id: string;
  label: string;
  path?: string;
  kind: 'field' | 'action' | 'category';
  keywords: string[];
}

export interface BuildPaletteIndexInput {
  catalog: ReadonlyArray<CategoryDef>;
  actionLabels: string[];
}

export function buildPaletteIndex({ catalog, actionLabels }: BuildPaletteIndexInput): PaletteEntry[] {
  const entries: PaletteEntry[] = [];

  for (const cat of catalog) {
    entries.push({
      id: cat.id,
      label: cat.label,
      kind: 'category',
      keywords: [cat.label, cat.description, cat.id],
    });

    for (const field of cat.fields) {
      entries.push({
        id: field.key,
        label: `${cat.label} › ${field.label}`,
        path: cat.id,
        kind: 'field',
        keywords: [field.label, cat.label, field.key, field.help ?? ''],
      });
    }
  }

  for (const label of actionLabels) {
    const id = label.toLowerCase();
    entries.push({
      id,
      label,
      kind: 'action',
      keywords: [label, id],
    });
  }

  return entries;
}

export function fuzzyScore(query: string, candidate: string): number {
  if (!query) return 1;
  const q = query.toLowerCase().replace(/\s+/g, '');
  const cRaw = candidate.toLowerCase();
  // Strip spaces from both sides of the substring check so multi-word queries
  // like "llm key" (→ "llmkey") match "LLM provider › API key" (→ "llmprovider›apikey").
  const c = cRaw.replace(/\s+/g, '');

  let i = 0;
  for (const ch of c) {
    if (ch === q[i]) i++;
    if (i === q.length) break;
  }
  if (i < q.length) return 0;

  let score = 1;
  if (c.includes(q)) score += 10;

  const tokens = candidate.split(/[\s›\W_]+/);
  for (const t of tokens) {
    if (t.toLowerCase().startsWith(q[0] ?? '')) score += 2;
  }

  return score;
}
