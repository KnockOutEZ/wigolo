export type FreshnessConfidence =
  | 'extracted'
  | 'inferred-url'
  | 'inferred-html'
  | 'inferred-llm'
  | 'unknown';

export interface FreshnessSignal {
  published_date?: string;
  inferred: boolean;
  confidence: FreshnessConfidence;
}

const URL_DATE_RE = /\/(\d{4})\/(\d{2})(?:\/(\d{2}))?(?:\/|$|[?#])/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function inferFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const m = u.pathname.match(URL_DATE_RE);
    if (!m) return undefined;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = m[3] !== undefined ? Number(m[3]) : 1;
    if (!Number.isFinite(year) || !Number.isFinite(month)) return undefined;
    if (year < 1990 || year > 2099 || month < 1 || month > 12) return undefined;
    if (day < 1 || day > 31) return undefined;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  } catch {
    return undefined;
  }
}

export function computeFreshnessSignal(
  url: string,
  publishedDate: string | undefined,
): FreshnessSignal {
  if (publishedDate) {
    return {
      published_date: publishedDate,
      inferred: false,
      confidence: 'extracted',
    };
  }
  const urlDate = inferFromUrl(url);
  if (urlDate) {
    return {
      published_date: urlDate,
      inferred: true,
      confidence: 'inferred-url',
    };
  }
  return { inferred: false, confidence: 'unknown' };
}
