/**
 * Arabic query preprocessing for search-engine submission.
 *
 * Problem this solves:
 *   When the user types "من هي ذات النطاقين وماذا تعرف عنها؟", Wigolo
 *   previously sent the full question to the search engines. The leading
 *   preposition "من" matched Wikipedia articles about the *letter* "من"
 *   (preposition), pushing the actually-relevant result about "أسماء بنت
 *   أبي بكر" off the top of the result list.
 *
 * What this module does:
 *   1. Strip leading Arabic question scaffolding ("من هو", "مين هي",
 *      "حدثني عن", "ما اسم", ...).
 *   2. Strip trailing question scaffolding ("وماذا تعرف عنها؟",
 *      "وكيف حالك؟", ...).
 *   3. Remove Arabic stopwords from the body, EXCEPT when the resulting
 *      string would be too short (in which case we fall back to the
 *      pre-stopword version so we never send an empty query to a search
 *      engine).
 *   4. Normalize Arabic diacritics, tatweel, and alef/ya/ta-marbuta
 *      variants for matching, but return the original-form text to the
 *      search engine (search engines like Bing/DuckDuckGo handle
 *      orthographic variants themselves; we don't want to corrupt the
 *      user's actual wording).
 *
 * The returned string is what should be sent to the search engines.
 * The original query is preserved for downstream display and for the
 * canonical extractor (which needs to see the epithet as the user typed
 * it).
 */

// ---------------------------------------------------------------------------
// Leading question prefixes (stripped before search)
// ---------------------------------------------------------------------------

const LEADING_QUESTION_PREFIXES = [
  // Direct question forms (specific before generic — the generic "من " rule
  // below would otherwise swallow the opener and leave "فضلك" behind).
  /^من\s+هو\s+/i,
  /^من\s+هي\s+/i,
  /^مين\s+هو\s+/i,
  /^مين\s+هي\s+/i,
  // Polite opener
  /^من\s+فضلك\s+/i,
  /^لو\s+سمحت\s+/i,
  // Tell-me / inform-me forms
  /^حدثني\s+عن\s+/i,
  /^حدثنا\s+عن\s+/i,
  /^حدثيني\s+عن\s+/i,
  /^احكي\s+لي\s+عن\s+/i,
  /^احك\s+لي\s+عن\s+/i,
  /^أخبرني\s+عن\s+/i,
  /^اخبرني\s+عن\s+/i,
  /^اعطني\s+معلومات\s+عن\s+/i,
  /^أعطني\s+معلومات\s+عن\s+/i,
  /^معلومات\s+عن\s+/i,
  /^تفاصيل\s+عن\s+/i,
  /^تحدث\s+عن\s+/i,
  /^تكلم\s+عن\s+/i,
  /^تكلمي\s+عن\s+/i,
  // Definition question
  /^ما\s+المقصود\s+بـ?/i,
  /^المقصود\s+بـ?/i,
  // "ما اسم ..." / "اسم ..."
  /^ما\s+اسم\s+/i,
  /^ما\s+اسم(?:\s+)?/i,
  /^اسم\s+/i,
  /^ما\s+هو\s+/i,
  /^ما\s+هي\s+/i,
  /^إيه\s+هو\s+/i,
  /^ايه\s+هو\s+/i,
  // Generic single-word openers (last, so the specific forms above win).
  /^مين\s+/i,
  /^من\s+/i,
  /^ما\s+/i,
  /^إيه\s+/i,
  /^ايه\s+/i,
];

// ---------------------------------------------------------------------------
// Trailing question scaffolding (the "وماذا تعرف عنها؟" tail)
// ---------------------------------------------------------------------------

const TRAILING_SCAFFOLDING_WORDS = new Set([
  // Question words
  "ماذا", "وماذا",
  "كيف", "وكيف",
  "لماذا", "ولماذا",
  "ليه", "وليه",
  "أين", "وأين",
  // Helper verbs / discourse
  "تعرف", "تعرّف",
  "عن", "وعن",
  "عنها", "عنه", "عنهم", "عنهما",
  "ما", "وما",
  "من", "ومن",
  "معلومات", "ومعلومات",
  "أخبرني", "واخبرني", "وأخبرني",
  "أخبرنا", "واخبرنا", "وأخبرنا",
  "حدثني", "وحدثني",
  "حدثنا", "وحدثنا",
  "تفاصيل", "وتفاصيل",
  "مختصر", "ومختصر",
  "نبذة", "ونبذة",
  "وعلي", "علي",
]);

// ---------------------------------------------------------------------------
// Body stopwords — removed from the body, but kept if removal would
// leave the query too short. These are common Arabic function words that
// search engines handle well on their own and that pollute search
// queries with low-information tokens.
// ---------------------------------------------------------------------------

const ARABIC_STOPWORDS = new Set([
  // Prepositions
  "في", "من", "على", "إلى", "الى", "عن", "مع", "بعد", "قبل", "خلال",
  "أثناء", "اثناء", "حول", "بشأن", "نحو", "بسبب", "بدون",
  // Pronouns
  "هو", "هي", "هم", "هن", "أنا", "نحن", "أنت", "أنتم", "أنتما",
  "هذا", "هذه", "ذلك", "تلك", "ذاك", "تيك",
  // Question words (already stripped from the front, kept here in case
  // they appear mid-sentence)
  "ما", "ماذا", "كيف", "متى", "أين", "أي", "لماذا", "ليه", "إيه", "ايه",
  // Conjunctions
  "و", "أو", "ثم", "لكن", "بل", "إلا", "حتى", "كي",
  // Definite article variants (kept because removing them changes the
  // noun meaning — only common function words here)
  "الذي", "التي", "الذين", "اللاتي", "اللائي", "الذوا",
  // Auxiliaries
  "كان", "كانت", "يكون", "تكون", "يكونوا", "تكونوا",
  "قد", "لقد", "وقد",
  "كل", "بعض", "كثير", "قليل",
  "إذا", "اذا", "إذ", "اذ",
  "أن", "إن", "أنّ", "إنّ", "كي", "لأن", "لأنّ",
]);

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

const DIACRITICS_RE = /[\u064B-\u065F\u0670\u0640]/g;

/** Normalize Arabic text for matching: drop diacritics, normalize alef/ya,
 *  collapse whitespace. Returns lowercased text. */
export function normalizeArabic(text: string): string {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(DIACRITICS_RE, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingPrefix(text: string): string {
  let current = text.trim();
  let previous = "";
  while (current && current !== previous) {
    previous = current;
    for (const re of LEADING_QUESTION_PREFIXES) {
      current = current.replace(re, "").trim();
    }
    // Strip trailing punctuation that gets exposed after a prefix removal
    current = current.replace(/[؟?!.,؛:]+$/g, "").trim();
  }
  return current;
}

function stripTrailingScaffolding(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return text;
  // Scan from the END: only a TRAILING run of question scaffolding is
  // removed. Matching from the front would cut the subject at the first
  // scaffolding word — "تاريخ مصر من الفراعنة إلى اليوم" would collapse to
  // "تاريخ مصر" even though "من الفراعنة" is part of the subject.
  let end = words.length;
  while (end > 0) {
    const word = words[end - 1];
    // Strip a leading "و" (Arabic "and") for the check, because the trailing
    // scaffolding is typically joined with it ("وماذا").
    const stripped = word.startsWith("و") && word.length > 1 ? word.slice(1) : word;
    if (TRAILING_SCAFFOLDING_WORDS.has(stripped) || TRAILING_SCAFFOLDING_WORDS.has(word)) {
      end--;
      continue;
    }
    break;
  }
  const core = words.slice(0, end);
  // If stripping would leave less than 2 words, keep the full text — a
  // 1-word search query is too narrow.
  if (core.length < 2) return text;
  return core.join(" ");
}

function removeStopwords(text: string): string {
  const words = text.split(/\s+/);
  const kept: string[] = [];
  for (const word of words) {
    if (!word) continue;
    if (ARABIC_STOPWORDS.has(word)) continue;
    // Strip leading "و" before the stopword check.
    const stripped = word.startsWith("و") && word.length > 1 ? word.slice(1) : word;
    if (ARABIC_STOPWORDS.has(stripped)) continue;
    kept.push(word);
  }
  return kept.join(" ");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CleanedQuery {
  /** The query string to send to search engines. */
  searchQuery: string;
  /** The core subject (with all scaffolding removed) — useful for the
   *  canonical extractor and for result re-ranking. */
  subject: string;
  /** True if we modified the query. Useful for telemetry. */
  changed: boolean;
}

/**
 * Clean an Arabic search query for submission to search engines.
 *
 * Examples:
 *   "من هي ذات النطاقين وماذا تعرف عنها؟"
 *     → searchQuery: "ذات النطاقين", subject: "ذات النطاقين"
 *   "من هو بطل الحرب والسلام؟"
 *     → searchQuery: "بطل الحرب والسلام", subject: "بطل الحرب والسلام"
 *   "من هو مؤسس الجيش المصري الحديث"
 *     → searchQuery: "مؤسس الجيش المصري الحديث", subject: "مؤسس الجيش المصري الحديث"
 *   "محمد علي باشا"  (already clean)
 *     → searchQuery: "محمد علي باشا", subject: "محمد علي باشا"
 */
export function cleanQueryForSearch(query: string): CleanedQuery {
  const original = String(query || "").trim();
  if (!original) return { searchQuery: "", subject: "", changed: false };

  // Work on the diacritic-free form: a vocalized question
  // ("مَنْ هِيَ ذات النطاقين") must still match the scaffolding patterns.
  // Only the harakat are dropped — the user's spelling (أ/إ/آ) is kept.
  const working = original.replace(DIACRITICS_RE, "");

  // Step 1: strip leading question prefix
  let afterPrefix = stripLeadingPrefix(working);

  // Step 2: strip trailing question scaffolding
  const subject = stripTrailingScaffolding(afterPrefix) || afterPrefix || working;

  // Step 3: remove body stopwords. Keep at most one round so we don't
  // over-strip.
  let withStopwordsRemoved = removeStopwords(subject);

  // Step 4: safety — if stopword removal emptied the string, fall back to
  // the subject (pre-stopword). If even the subject is empty, fall back to
  // the original query so we never send an empty string to a search engine.
  if (!withStopwordsRemoved || withStopwordsRemoved.length < 3) {
    withStopwordsRemoved = subject;
  }
  if (!withStopwordsRemoved || withStopwordsRemoved.length < 3) {
    withStopwordsRemoved = working;
  }

  const changed = withStopwordsRemoved !== original;
  return { searchQuery: withStopwordsRemoved, subject, changed };
}

/**
 * Detect whether a query is Arabic (vs. Latin or numeric). Used by the
 * rerank pipeline to decide whether to apply Arabic-specific boosts.
 */
export function isArabicQuery(query: string): boolean {
  const text = String(query || "");
  if (!text) return false;
  let arabicChars = 0;
  let totalLetters = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (code >= 0x0621 && code <= 0x064a) {
      arabicChars++;
      totalLetters++;
    } else if (/[a-z]/i.test(ch)) {
      totalLetters++;
    }
  }
  return totalLetters > 0 && arabicChars / totalLetters >= 0.5;
}
