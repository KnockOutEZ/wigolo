export type Vertical = 'general' | 'news' | 'code' | 'docs' | 'papers';

export const VERTICALS: readonly Vertical[] = [
  'general',
  'news',
  'code',
  'docs',
  'papers',
] as const;

export interface ClassifyOptions {
  /** Override classifier (e.g., from `category` input on search tool). */
  hint?: Vertical;
  /** When date filters are present in the search input, push toward 'news'. */
  hasDateBound?: boolean;
}

const PAPERS_RE = /\b(arxiv|paper|cite|citation|doi|preprint|whitepaper|journal|pubmed|proceedings)\b/i;

const CODE_HARD_RE = /\b(github|pull request|pr #|commit|stack overflow|stackoverflow|compile error|typeerror|traceback|exception)\b/i;

const LANG_TOKEN_RE = /\b(python|typescript|javascript|rust|go|c\+\+|npm|cargo|pip|regex|sql|bash)\b/i;
const HOWTO_VERB_RE = /\b(error|fix|debug|compile)\b/i;

const DOCS_PHRASE_RE = /(\bhow to\b|\btutorial\b|\breference\b|\bapi\b|\bdocumentation\b|\bdocs for\b|\bmdn\b|\bdevdocs\b|\bguide\b|\bgetting started\b)/i;

const NEWS_RE = /\b(latest|today|yesterday|this week|news|breaking|2024|2025|2026|recent|update|announcement)\b/i;

export function classifyIntent(query: string, opts?: ClassifyOptions): Vertical {
  if (opts?.hint) {
    return opts.hint;
  }

  const q = query ?? '';
  const trimmed = q.trim();
  if (trimmed.length === 0) {
    return 'general';
  }

  if (PAPERS_RE.test(trimmed)) {
    return 'papers';
  }

  if (CODE_HARD_RE.test(trimmed)) {
    return 'code';
  }

  if (LANG_TOKEN_RE.test(trimmed) && HOWTO_VERB_RE.test(trimmed)) {
    return 'code';
  }

  if (DOCS_PHRASE_RE.test(trimmed) || /\blearn\b/i.test(trimmed)) {
    return 'docs';
  }

  if (opts?.hasDateBound || NEWS_RE.test(trimmed)) {
    return 'news';
  }

  return 'general';
}
