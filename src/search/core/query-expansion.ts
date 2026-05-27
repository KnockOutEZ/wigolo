// Low-recall query expansion — static, deterministic, no LLM.
//
// When the orchestrator returns very few deduped results (<= LOW_RECALL_THRESHOLD)
// the provider tries ONE auto-rewrite using the synonym map below. The rewrite
// is exposed to callers via query_understanding.rewrites so the auto-fired
// query is visible (it must not look like user-supplied input).
//
// The map is intentionally small and high-precision: well-known acronyms,
// multi-word identifier joins (use state -> useState), and a final fallback
// of "pluralize the longest singular content token" when nothing else
// matched. The brief explicitly bars an LLM call here.
//
// Rules:
//   - first-match wins; we don't apply multiple rewrites at once.
//   - synonyms expand the acronym INLINE (RAG -> RAG (retrieval augmented
//     generation)) so the original token still helps engines that index by
//     the acronym, while the expanded form unlocks long-tail recall.
//   - the catch-all pluralization only fires when no other synonym matched.
//   - case is preserved on the source token; the expansion uses the canonical
//     lowercase form so search engines normalise both consistently.

export const LOW_RECALL_THRESHOLD = 3;

// Acronyms and short-form -> expansion. Case-insensitive match against
// individual whitespace-delimited tokens.
const ACRONYMS: Record<string, string> = {
  rag: 'retrieval augmented generation',
  k8s: 'kubernetes',
  ml: 'machine learning',
  llm: 'large language model',
  ci: 'continuous integration',
  cd: 'continuous deployment',
  api: 'application programming interface',
  ssr: 'server side rendering',
  csr: 'client side rendering',
  ssg: 'static site generation',
  ide: 'integrated development environment',
  jwt: 'json web token',
  cors: 'cross origin resource sharing',
  dom: 'document object model',
  npm: 'node package manager',
};

// Multi-word -> single-identifier collapses for common framework APIs.
// Matched against the lowercased query as a single substring; the first
// match wins.
const PHRASE_COLLAPSE: Array<[RegExp, string]> = [
  [/\buse state\b/gi, 'useState'],
  [/\buse effect\b/gi, 'useEffect'],
  [/\buse ref\b/gi, 'useRef'],
  [/\buse memo\b/gi, 'useMemo'],
  [/\buse callback\b/gi, 'useCallback'],
  [/\buse context\b/gi, 'useContext'],
  [/\buse reducer\b/gi, 'useReducer'],
  [/\bnext js\b/gi, 'nextjs'],
  [/\bnode js\b/gi, 'nodejs'],
  [/\bnest js\b/gi, 'nestjs'],
  [/\bnuxt js\b/gi, 'nuxtjs'],
];

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
  'the', 'to', 'was', 'were', 'will', 'with',
]);

// High-precision pluralization. We only rewrite tokens that have a known
// irregular plural — generic "append s" is too noisy and would fire on every
// query, drowning out the auto-rewrite signal in query_understanding.rewrites
// and doubling engine cost on most calls. The brief lists "child -> children"
// as the canonical example.
const IRREGULAR_PLURALS: Record<string, string> = {
  child: 'children',
  man: 'men',
  woman: 'women',
  person: 'people',
  mouse: 'mice',
  goose: 'geese',
  foot: 'feet',
  tooth: 'teeth',
  ox: 'oxen',
};

function pluralizeToken(token: string): string | null {
  const lower = token.toLowerCase();
  if (IRREGULAR_PLURALS[lower]) return IRREGULAR_PLURALS[lower];
  return null;
}

function tryAcronymExpansion(query: string): string | null {
  const tokens = query.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    const bare = raw.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (!bare) continue;
    const expansion = ACRONYMS[bare];
    if (expansion) {
      // Inject the expansion AFTER the acronym so both forms reach the engines.
      const rewritten = [...tokens];
      rewritten.splice(i + 1, 0, expansion);
      return rewritten.join(' ');
    }
  }
  return null;
}

function tryPhraseCollapse(query: string): string | null {
  for (const [pattern, replacement] of PHRASE_COLLAPSE) {
    if (pattern.test(query)) {
      pattern.lastIndex = 0;
      return query.replace(pattern, replacement);
    }
  }
  return null;
}

function tryPluralization(query: string): string | null {
  const tokens = query.split(/\s+/);
  // Pluralize the LONGEST non-stop, non-numeric token. Longest-first is a
  // simple heuristic for "the most content-bearing word".
  const candidates: Array<{ idx: number; len: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (!t || STOP_WORDS.has(t)) continue;
    if (!/[a-z]/.test(t)) continue; // skip numbers / symbols
    candidates.push({ idx: i, len: t.length });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.len - a.len);
  for (const c of candidates) {
    const pluralized = pluralizeToken(tokens[c.idx]);
    if (pluralized && pluralized !== tokens[c.idx].toLowerCase()) {
      const rewritten = [...tokens];
      rewritten[c.idx] = pluralized;
      return rewritten.join(' ');
    }
  }
  return null;
}

export function expandQuery(query: string): string | null {
  if (typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;

  // First-match wins: acronyms > phrase collapse > pluralization.
  return (
    tryAcronymExpansion(trimmed) ??
    tryPhraseCollapse(trimmed) ??
    tryPluralization(trimmed)
  );
}
