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
  /** Inject a clock for deterministic relative-date parsing in tests. */
  now?: Date;
}

export interface DateHint {
  fromDate?: string;
  toDate?: string;
}

export interface DetailedClassification {
  vertical: Vertical;
  dateHint?: DateHint;
}

const PAPERS_RE = /\b(arxiv|paper|cite|citation|doi|preprint|whitepaper|journal|pubmed|proceedings)\b/i;

const CODE_HARD_RE = /\b(github|pull request|pr #|commit|stack overflow|stackoverflow|compile error|typeerror|traceback|exception)\b/i;

const LANG_TOKEN_RE = /\b(python|typescript|javascript|rust|go|c\+\+|npm|cargo|pip|regex|sql|bash)\b/i;
const HOWTO_VERB_RE = /\b(error|fix|debug|compile)\b/i;

const DOCS_PHRASE_RE = /(\bhow to\b|\btutorial\b|\breference\b|\bapi\b|\bdocumentation\b|\bdocs for\b|\bmdn\b|\bdevdocs\b|\bguide\b|\bgetting started\b)/i;

// Year tokens were previously in this regex (2024|2025|2026), but bare years
// drive far too many false-positive news routings ("vector database choice
// 2026" → bing_news → BEST Express Vietnam logistics). Years now only count
// as news when an explicit news keyword is present elsewhere in the query.
const NEWS_RE = /\b(latest|today|yesterday|this week|news|breaking|recent|update|announcement)\b/i;

const MIN_YEAR = 1990;
const MAX_YEAR = 2099;
const MS_PER_DAY = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shiftDays(now: Date, days: number): string {
  return isoDate(new Date(now.getTime() - days * MS_PER_DAY));
}

function validYear(y: number): boolean {
  return y >= MIN_YEAR && y <= MAX_YEAR;
}

function withUnit(now: Date, n: number, unit: string): DateHint | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const u = unit.toLowerCase();
  if (u.startsWith('day')) return { fromDate: shiftDays(now, n) };
  if (u.startsWith('week')) return { fromDate: shiftDays(now, 7 * n) };
  if (u.startsWith('month')) return { fromDate: shiftDays(now, 30 * n) };
  if (u.startsWith('year')) return { fromDate: shiftDays(now, 365 * n) };
  return undefined;
}

export function parseDateHint(query: string, now: Date = new Date()): DateHint | undefined {
  if (!query) return undefined;
  const q = query;

  // 1. between YYYY and YYYY
  const between = q.match(/\bbetween\s+(\d{4})\s+and\s+(\d{4})\b/i);
  if (between) {
    const y1 = Number(between[1]);
    const y2 = Number(between[2]);
    if (validYear(y1) && validYear(y2) && y1 <= y2) {
      return { fromDate: `${y1}-01-01`, toDate: `${y2}-12-31` };
    }
    return undefined;
  }

  // 2. from YYYY to YYYY
  const fromTo = q.match(/\bfrom\s+(\d{4})\s+to\s+(\d{4})\b/i);
  if (fromTo) {
    const y1 = Number(fromTo[1]);
    const y2 = Number(fromTo[2]);
    if (validYear(y1) && validYear(y2) && y1 <= y2) {
      return { fromDate: `${y1}-01-01`, toDate: `${y2}-12-31` };
    }
    return undefined;
  }

  // 3. since YYYY
  const since = q.match(/\bsince\s+(\d{4})\b/i);
  if (since) {
    const y = Number(since[1]);
    if (validYear(y)) return { fromDate: `${y}-01-01` };
    return undefined;
  }

  // 4. in/after/starting YYYY
  const inAfter = q.match(/\b(?:in|after|starting)\s+(\d{4})\b/i);
  if (inAfter) {
    const y = Number(inAfter[1]);
    if (validYear(y)) return { fromDate: `${y}-01-01` };
    return undefined;
  }

  // 5. before YYYY
  const before = q.match(/\bbefore\s+(\d{4})\b/i);
  if (before) {
    const y = Number(before[1]);
    if (validYear(y)) return { toDate: `${y - 1}-12-31` };
    return undefined;
  }

  // 6-9. last N <unit>
  const last = q.match(/\blast\s+(\d+)\s+(days?|weeks?|months?|years?)\b/i);
  if (last) {
    const hint = withUnit(now, Number(last[1]), last[2]);
    if (hint) return hint;
  }

  // 10. past N <unit>
  const past = q.match(/\bpast\s+(\d+)\s+(days?|weeks?|months?|years?)\b/i);
  if (past) {
    const hint = withUnit(now, Number(past[1]), past[2]);
    if (hint) return hint;
  }

  // 11. today
  if (/\btoday\b/i.test(q)) {
    const d = shiftDays(now, 0);
    return { fromDate: d, toDate: d };
  }

  // 12. yesterday
  if (/\byesterday\b/i.test(q)) {
    const d = shiftDays(now, 1);
    return { fromDate: d, toDate: d };
  }

  // 13. this week
  if (/\bthis\s+week\b/i.test(q)) {
    return { fromDate: shiftDays(now, 7) };
  }

  // 14. this month
  if (/\bthis\s+month\b/i.test(q)) {
    return { fromDate: shiftDays(now, 30) };
  }

  // 15. this year
  if (/\bthis\s+year\b/i.test(q)) {
    return { fromDate: `${now.getUTCFullYear()}-01-01` };
  }

  return undefined;
}

export function classifyIntentDetailed(
  query: string,
  opts?: ClassifyOptions,
): DetailedClassification {
  const q = query ?? '';
  const dateHint = parseDateHint(q, opts?.now);

  if (opts?.hint) {
    return dateHint ? { vertical: opts.hint, dateHint } : { vertical: opts.hint };
  }

  const trimmed = q.trim();
  if (trimmed.length === 0) {
    return { vertical: 'general' };
  }

  let vertical: Vertical;
  if (PAPERS_RE.test(trimmed)) {
    vertical = 'papers';
  } else if (CODE_HARD_RE.test(trimmed)) {
    vertical = 'code';
  } else if (LANG_TOKEN_RE.test(trimmed) && HOWTO_VERB_RE.test(trimmed)) {
    vertical = 'code';
  } else if (DOCS_PHRASE_RE.test(trimmed) || /\blearn\b/i.test(trimmed)) {
    vertical = 'docs';
  } else if (opts?.hasDateBound || NEWS_RE.test(trimmed) || !!dateHint) {
    vertical = 'news';
  } else {
    vertical = 'general';
  }

  return dateHint ? { vertical, dateHint } : { vertical };
}

export function classifyIntent(query: string, opts?: ClassifyOptions): Vertical {
  return classifyIntentDetailed(query, opts).vertical;
}
