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

// Slice 8 / M6: lowercase lexicon for queries that arrive downcased.
// Lowercase queries are common (many agents normalize input) and the
// casing-only extractor below returns [] for them. The lexicon recovers
// the high-value named entities (companies, products, frameworks, AI
// models) that callers actually care about — kept small so the cost
// of one membership check per token stays trivial.
const LOWERCASE_ENTITY_LEXICON = new Set([
  // AI companies + assistants
  'anthropic', 'openai', 'claude', 'gpt', 'chatgpt', 'gemini', 'mistral',
  'llama', 'perplexity', 'cohere', 'huggingface', 'deepseek',
  // Major tech companies
  'google', 'microsoft', 'apple', 'amazon', 'meta', 'facebook', 'tesla',
  'nvidia', 'intel', 'oracle', 'salesforce', 'ibm', 'netflix', 'spotify',
  'uber', 'airbnb', 'github', 'gitlab', 'shopify', 'stripe', 'cloudflare',
  'vercel', 'supabase', 'twilio', 'datadog', 'snowflake', 'mongodb',
  // Frameworks / runtimes / databases
  'react', 'angular', 'vue', 'svelte', 'nextjs', 'nuxt', 'remix',
  'astro', 'vite', 'webpack', 'rollup', 'turbo', 'pnpm', 'bun', 'deno',
  'node', 'nodejs', 'rust', 'golang', 'python', 'django', 'flask',
  'fastapi', 'tornado', 'rails', 'sinatra', 'express', 'kotlin',
  'swift', 'typescript', 'javascript', 'wasm', 'webassembly',
  'postgres', 'postgresql', 'mysql', 'sqlite', 'redis', 'mongodb',
  'cassandra', 'kafka', 'elasticsearch', 'opensearch', 'clickhouse',
  'duckdb', 'pinecone', 'pgvector', 'weaviate', 'qdrant', 'milvus',
  // Cloud / infra
  'kubernetes', 'docker', 'terraform', 'ansible', 'pulumi',
  'aws', 'gcp', 'azure', 'vercel', 'fly', 'render', 'heroku',
  // Roles / common-prose entities the audit's test names
  'ceo', 'cto', 'cfo', 'coo', 'cmo',
]);

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
      continue;
    }
    // Slice 8 / M6: fall-through path for all-lowercase tokens against a
    // known-entity lexicon. Keeps the case-sensitive path authoritative
    // (preserves original casing) while still recovering entities from
    // downcased queries.
    const lower = m.toLowerCase();
    if (LOWERCASE_ENTITY_LEXICON.has(lower) && !seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
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
