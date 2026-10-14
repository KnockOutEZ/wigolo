/**
 * Arabic canonical-name extractor — pulls a real name out of a descriptive
 * epithet using regex patterns + search-result evidence.
 *
 * This module is the **Wigolo-side** mirror of the NEXUS canonical extractor.
 * Where NEXUS only extracts patronymic chains ("أسماء بنت أبي بكر") from
 * Wigolo evidence, this module extends Wigolo itself to also recognize:
 *
 *   Pattern 1:  "[NAME] هو [EPITHET]"        → محمد علي باشا هو مؤسس...
 *   Pattern 2:  "[NAME] (YYYY-YYYY)"          → أحمد زويل (1946-2016)
 *   Pattern 3:  "[NAME] الذي/التي [ROLE]"      → طه حسين الذي فقد بصره
 *   Pattern 4:  "يُعتبر [NAME] [EPITHET]"      → يعتبر محمد علي مؤسس...
 *   Pattern 5:  "تُعرف بـ [NAME]"              → تعرف بـ أم كلثوم
 *   Pattern 6:  patronymic chains             → أسماء بنت أبي بكر
 *
 * The extractor is pure-string in/JSON out; no LLM call. It runs on the
 * (already-fetched) Wigolo search results, so it adds ~1ms of latency per
 * query, not a network round-trip.
 */

// ---------------------------------------------------------------------------
// Helper: normalize Arabic text for matching (compatible with NEXUS's
// query_expansion._norm())
// ---------------------------------------------------------------------------

const DIACRITICS_RE = /[\u064B-\u065F\u0670\u0640]/g;

export function normalizeArabic(text: string): string {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(DIACRITICS_RE, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compacted key used for de-duplication and substring checks. */
function compactKey(text: string): string {
  return normalizeArabic(text).replace(/[^\u0621-\u064a\u0660-\u0669]/g, "");
}

// ---------------------------------------------------------------------------
// Common Arabic name building blocks
// ---------------------------------------------------------------------------

// An Arabic name token: 2+ letters (excluding diacritics, which are already
// stripped by normalizeArabic). Allow optional leading "ال" (the definite
// article) since many historical names use it (e.g. "السادات").
const NAME_TOKEN = "[إلأآا-ي]+";

// 1-4 name tokens joined by spaces. Kept conservative to avoid matching
// whole paragraphs. The leading word-boundary lookbehind is enforced by
// the caller (the patterns are wrapped in lookbehinds so we don't start
// matches mid-word).
const NAME_PATTERN = `(?:${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){0,3})`;

// Patronymic indicator: بن / بنت / ابن / أبو / ابو
const PATRONYMIC_INDICATOR = "(?:بن|بنت|ابن|أبو|ابو)";

// Years in parentheses: "(1946-2016)" or "(1946 - 2016)" or "(١٩٤٦-٢٠١٦)"
// with optional Arabic-Indic digits.
const YEAR_RANGE = "\\(?\\s*(?:[0-9\\u0660-\\u0669]{4})\\s*-\\s*(?:[0-9\\u0660-\\u0669]{4})\\s*\\)?";

// Epithet keywords that follow a name in Pattern 1 / 4. These are common
// roles that signal "the preceding name is the canonical entity".
const EPITHET_KEYWORDS = [
  "مؤسس", "بطل", "رائد", "أول", "صاحب", "مبتكر", "مكتشف", "قائد", "زعيم",
  "أبو", "أم", "ملك", "رئيس", "وزير", "قائمقام", "باشا", "الزعيم",
  "النجم", "الكوكب", "العميد", "الشيخ", "الإمام", "الأمير",
].join("|");

// Copulas that link a name to an epithet in Pattern 1.
const COPULAS = "(?:هو|هي|يُعتبر|تُعتبر|يعتبر|تعتبر|يعد|تعد|يُعد|تُعد|يُعرف|تُعرف)";

// Relative pronouns for Pattern 3.
const RELATIVE_PRONOUNS = "(?:الذي|التي|الذين|اللذان|اللتان|اللاتي|اللائي)";

// "Known as" prefix for Pattern 5.
const KNOWN_AS_PREFIX = "(?:تُعرف\\s+بـ?|يُعرف\\s+بـ?|تسمى\\s+بـ?|يطلق\\s+عليها\\s+اسم\\s+|يطلق\\s+عليه\\s+اسم\\s+)";

// ---------------------------------------------------------------------------
// Patterns. Each pattern is anchored at a word boundary by a negative
// lookbehind for Arabic letters, so we don't start mid-word.
// ---------------------------------------------------------------------------

interface Pattern {
  name: string;
  regex: RegExp;
  /** Given a regex match, return the extracted name. */
  extract: (match: RegExpExecArray) => string;
}

const PATTERNS: Pattern[] = [
  // Pattern 1: "[NAME] هو/هي/يُعتبر [EPITHET]"
  //   → "محمد علي باشا هو مؤسس الجيش المصري الحديث"
  //   → "محمد علي باشا يعتبر مؤسس..."
  {
    name: "name_is_epithet",
    regex: new RegExp(
      `(?<![\\u0621-\\u064a])` +
      `(${NAME_PATTERN})\\s+${COPULAS}\\s+(${EPITHET_KEYWORDS})`,
      "g",
    ),
    extract: (m) => m[1].trim(),
  },
  // Pattern 4: "يُعتبر [NAME] [EPITHET]"
  //   → "يعتبر محمد علي باشا مؤسس..."
  //   → "يعد أحمد عرابي بطلاً..."
  {
    name: "is_considered_name_epithet",
    regex: new RegExp(
      `(?<![\\u0621-\\u064a])` +
      `(?:يُعتبر|تُعتبر|يعتبر|تعتبر|يعد|تعد|يُعد|تُعد)\\s+` +
      `(${NAME_PATTERN})\\s+(${EPITHET_KEYWORDS})`,
      "g",
    ),
    extract: (m) => m[1].trim(),
  },
  // Pattern 3: "[NAME] الذي/التي [ROLE]"
  //   → "طه حسين الذي فقد بصره"
  //   → "أم كلثوم التي غنت..."
  {
    name: "name_relative_clause",
    regex: new RegExp(
      `(?<![\\u0621-\\u064a])` +
      `(${NAME_PATTERN})\\s+${RELATIVE_PRONOUNS}\\s+`,
      "g",
    ),
    extract: (m) => m[1].trim(),
  },
  // Pattern 5: "تُعرف بـ [NAME]" / "يُعرف بـ [NAME]"
  //   → "تعرف بـ أم كلثوم"
  //   → "يُعرف بـ موسيقار الأجيال"
  {
    name: "known_as_name",
    regex: new RegExp(
      `${KNOWN_AS_PREFIX}\\s*(${NAME_PATTERN})`,
      "g",
    ),
    extract: (m) => m[1].trim(),
  },
  // Pattern 2: "[NAME] (YYYY-YYYY)"
  //   → "أحمد زويل (1946-2016)"
  //   → "نجيب محفوظ (1911-2006)"
  {
    name: "name_year_range",
    regex: new RegExp(
      `(?<![\\u0621-\\u064a])` +
      `(${NAME_PATTERN})\\s*${YEAR_RANGE}`,
      "g",
    ),
    extract: (m) => m[1].trim(),
  },
  // Pattern 6: patronymic chains — "أسماء بنت أبي بكر", "سعد بن أبي وقاص",
  // "عبد الله بن الزبير". This is the original pattern NEXUS uses; kept
  // here so Wigolo can extract the same chains even when NEXUS isn't running.
  // We capture the FULL chain (name + bin + name) as the canonical, because
  // "أسماء" alone is a partial name — the full "أسماء بنت أبي بكر" is the
  // canonical form that matches Wikipedia article titles.
  {
    name: "patronymic_chain",
    regex: new RegExp(
      `(?<![\\u0621-\\u064a])` +
      `(${NAME_PATTERN})\\s+${PATRONYMIC_INDICATOR}\\s+${NAME_PATTERN}`,
      "g",
    ),
    extract: (m) => m[0].trim(),  // Capture the full chain, not just the first name.
  },
];

// ---------------------------------------------------------------------------
// Generic stopwords that should never appear as the leading token of an
// extracted name (these signal we matched a sentence clause, not a name).
// ---------------------------------------------------------------------------

const STOPWORD_PREFIXES = new Set([
  "تعرف", "هو", "هي", "هذا", "هذه", "الذي", "التي", "قال", "قالت",
  "كان", "كانت", "وكان", "زواج", "قرار", "معلومات", "تفاصيل",
  "في", "من", "عن", "على", "إلى", "الى", "مع", "بعد", "قبل", "خلال",
  "ترجمة", "سيرة", "نبذة", "حياة", "قصة", "وفي", "ثم", "وقد",
  "هام", "مهم", "فيه", "فيها", "عليه", "عليها",
  "وذكر", "وذكرت", "روي", "رويت", "ذكر",
  // Demonstrative / relative pronouns that the pattern might capture as
  // the first token.
  "الذين", "اللذان", "اللاتي", "اللائي",
  // Common temporal adverbs that look like sentence openers.
  "ثم", "وبعد", "فبعد", "قبل",
  // Prepositions / verbs that commonly precede a name in a snippet
  // sentence (e.g. "تعرف على أسماء بنت أبي بكر" — the lookbehind can't
  // see past the space between "على" and "أسماء", so we have to filter
  // these tokens here).
  "بـ", "بِـ", "وفي", "وفيه", "وفيها", "وعن",
  // Demonstratives.
  "هذا", "هذه", "ذلك", "تلك",
]);

function stripLeadingStopwords(name: string): string {
  // Strip leading stopword tokens (e.g. "تعرف على أسماء بنت أبي بكر" → "أسماء
  // بنت أبي بكر"). We strip up to 3 leading stopwords because typical Arabic
  // snippet openers ("تعرف على ...") have 1-3 stopword tokens before the
  // actual name. We refuse to strip more than that, to avoid eating real
  // names like "عبد الرحمن" (where "عبد" might look like a stopword but
  // isn't). We require at least 2 tokens to remain after stripping so we
  // don't reduce "على أسماء" to just "أسماء" by accident when "أسماء" alone
  // would be a partial name.
  const tokens = name.split(/\s+/).filter(Boolean);
  let stripped = 0;
  while (stripped < 3 && tokens.length > 2 && STOPWORD_PREFIXES.has(tokens[0])) {
    tokens.shift();
    stripped++;
  }
  return tokens.join(" ").trim();
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ExtractedCanonical {
  /** The extracted canonical name (e.g. "محمد علي باشا"). */
  name: string;
  /** Which pattern produced this match. */
  pattern: string;
  /** The original text snippet that contained the match (for debugging /
   *  telemetry). */
  matchedText: string;
  /** Which Wigolo result index (0-based) produced this match. */
  resultIndex: number;
  /** Whether the query subject co-occurs in the same result (filtered at
   *  extraction time — non-co-occurring matches are dropped). */
  coOccurs: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  snippet: string;
  url?: string;
  [key: string]: unknown;
}

/**
 * Extract canonical-name candidates from a list of search results, given
 * the user's cleaned query subject.
 *
 * Returns 0-N candidates, ranked by:
 *   1. Co-occurrence with the subject (co-occurring first)
 *   2. Pattern specificity (patronymic > name_is_epithet > known_as > year_range > relative_clause)
 *   3. Match position in the result list (earlier first)
 *
 * The caller (Wigolo's rerank pipeline) typically takes only the top 1-3
 * candidates and passes them back to NEXUS as canonical hints.
 *
 * Notes:
 *   - The function NEVER invents a canonical name when no pattern matches.
 *     An empty array means "no canonical candidate found".
 *   - Co-occurrence is checked against the user's cleaned subject (or its
 *     first 2-3 words if the subject is long). This prevents extracting a
 *     name from a snippet that's actually about a completely different
 *     topic.
 *   - Stopword-prefixed matches are dropped (e.g. "تعرف على أسماء بنت أبي
 *     بكر" — the regex would capture "تعرف" as the leading token; we drop
 *     that and let the next iteration capture "أسماء" instead, because
 *     the regex is wrapped in a negative lookbehind).
 */
export function extractCanonicalCandidates(
  results: SearchResult[],
  subject: string,
  options: { max?: number } = {},
): ExtractedCanonical[] {
  const max = options.max ?? 5;
  if (!results || results.length === 0 || !subject) return [];

  const subjectKey = compactKey(subject);
  if (subjectKey.length < 4) return [];

  // Build subject-key variants for co-occurrence: full subject + first 2-3
  // words. This handles the case where the snippet contains the core
  // epithet only (e.g. "ذات النطاقين") and not the full question.
  const subjectWords = subject.split(/\s+/);
  const subjectKeyVariants = new Set<string>([subjectKey]);
  for (const n of [3, 2, 4]) {
    if (n > 0 && n < subjectWords.length) {
      const core = subjectWords.slice(0, n).join(" ");
      const key = compactKey(core);
      if (key) subjectKeyVariants.add(key);
    }
  }

  const candidates: ExtractedCanonical[] = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < results.length && candidates.length < max; i++) {
    const result = results[i];
    // Strip diacritics before matching — Arabic copulas sometimes come
    // with harakat (e.g. "يُعتبر" vs "يعتبر") and the regex alternation
    // handles both forms but only when the input is diacritic-free.
    const title = String(result.title || "").replace(DIACRITICS_RE, "");
    const snippet = String(result.snippet || "").replace(DIACRITICS_RE, "");
    const combined = `${title}\n${snippet}`;
    const combinedKey = compactKey(combined);

    // Co-occurrence check: ANY subject-key variant must appear in the
    // result's title+snippet. Skip if absent — extracting a name from an
    // unrelated snippet would be noise.
    let coOccurs = false;
    for (const key of subjectKeyVariants) {
      if (key && combinedKey.includes(key)) {
        coOccurs = true;
        break;
      }
    }
    if (!coOccurs) continue;

    for (const pattern of PATTERNS) {
      // Reset lastIndex for stateful global regexes.
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(combined)) !== null) {
        let name = pattern.extract(match);
        if (!name || name.length < 3) continue;
        // Strip leading stopword tokens (e.g. "تعرف على أسماء" → "أسماء").
        name = stripLeadingStopwords(name);
        if (!name || name.length < 3) continue;

        const key = compactKey(name);
        if (!key || seenKeys.has(key)) continue;

        // Filter out matches whose compact key contains the subject's
        // compact key — that means we extracted the subject itself (or a
        // longer version of it), not a canonical name.
        let isSubjectItself = false;
        for (const subjectVariant of subjectKeyVariants) {
          if (subjectVariant && key.includes(subjectVariant)) {
            isSubjectItself = true;
            break;
          }
        }
        if (isSubjectItself) continue;

        seenKeys.add(key);
        candidates.push({
          name: name.slice(0, 120),
          pattern: pattern.name,
          matchedText: match[0].slice(0, 200),
          resultIndex: i,
          coOccurs: true,
        });
        if (candidates.length >= max) break;
      }
    }
  }

  return candidates;
}
