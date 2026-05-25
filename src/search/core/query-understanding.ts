import {
  classifyIntentDetailed,
  type DateHint,
  type Vertical,
} from './intent-router.js';
import { COMMON_NOUNS } from '../hybrid/common-nouns.js';

export interface QueryUnderstanding {
  intent: Vertical;
  entities: string[];
  date_hint: DateHint | null;
  language: string;
  is_brand_collision_prone: boolean;
  rewrites: string[];
}

export interface BuildQUOptions {
  category?: Vertical;
  language?: string;
  rewrites?: string[];
  now?: Date;
}

function tokenize(query: string): string[] {
  return query.trim().split(/\s+/).filter((t) => t.length > 0);
}

function isBrandCollisionProne(query: string): boolean {
  const tokens = tokenize(query);
  if (tokens.length === 0 || tokens.length > 2) return false;
  return tokens.every((t) => COMMON_NOUNS.has(t.toLowerCase()));
}

function extractEntities(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Acronyms / mixed-case tokens (HNSW, Next.js, pgvector with dot, React)
  const tokenRe = /[A-Za-z][A-Za-z0-9.\-]*[A-Za-z0-9]?/g;
  const matches = query.match(tokenRe) ?? [];
  for (const m of matches) {
    if (m.length < 2) continue;
    const hasUpper = /[A-Z]/.test(m);
    const looksLikeAcronym = /^[A-Z][A-Z0-9]+$/.test(m) && m.length >= 2 && m.length <= 6;
    const isProperNoun = /^[A-Z][a-z]/.test(m);
    const hasDot = m.includes('.');
    if (looksLikeAcronym || isProperNoun || (hasDot && hasUpper)) {
      if (!seen.has(m)) {
        seen.add(m);
        out.push(m);
      }
    }
  }
  return out;
}

export function buildQueryUnderstanding(
  query: string,
  opts: BuildQUOptions = {},
): QueryUnderstanding {
  const classification = classifyIntentDetailed(query, {
    hint: opts.category,
    now: opts.now,
  });
  return {
    intent: classification.vertical,
    entities: extractEntities(query),
    date_hint: classification.dateHint ?? null,
    language: opts.language ?? 'en',
    is_brand_collision_prone: isBrandCollisionProne(query),
    rewrites: opts.rewrites ?? [],
  };
}
