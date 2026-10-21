// Pure helpers for turning free-text GitHub profile fields into company keys.
// Kept dependency-free so `node --test` can exercise them directly.

const LEGAL_SUFFIXES =
  /\b(inc|incorporated|ltd|limited|llc|l\.l\.c|gmbh|ag|sa|sas|bv|oy|ab|as|srl|spa|pvt|pte|plc|co|corp|corporation|company|group|holdings|technologies|technology|labs?)\b\.?/g;

// Values that are a status, not an employer.
const NOT_A_COMPANY = new Set([
  "",
  "none",
  "n/a",
  "na",
  "no",
  "-",
  "self",
  "self employed",
  "self-employed",
  "freelance",
  "freelancer",
  "independent",
  "student",
  "home",
  "personal",
  "private",
  "unemployed",
  "open source",
  "opensource",
  "me",
  "myself",
  "github",
  "remote",
  "retired",
  "looking for job",
  "stealth",
  "stealth startup",
  "individual",
  "freedom",
  "null",
  "undefined",
  "company",
  "work",
  "school",
  "university",
  "earth",
  "china",
  "world",
  "internet",
  "nothing",
  "unknown",
  "secret",
  "confidential",
  "startup",
]);

const clean = (s) => s.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const NOT_A_COMPANY_KEYS = new Set([...NOT_A_COMPANY].map(clean));

/** Lower-case, strip punctuation + legal suffixes, collapse whitespace. */
export function companyKey(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  s = s.replace(/^@/, "").replace(/https?:\/\/(www\.)?/g, "");
  s = s.replace(/\.(com|io|ai|dev|app|co|org|net)\b/g, "");
  s = s.replace(LEGAL_SUFFIXES, " ");
  s = clean(s);
  if (NOT_A_COMPANY_KEYS.has(s)) return "";
  if (s.length < 2) return "";
  return s;
}

/**
 * A company field often names several employers ("@acme @beta", "Acme | Beta",
 * "ex-Google, now Acme"). Split into candidate strings; drop "ex-" entries,
 * because a former employer is not a current one.
 */
export function splitCompanies(raw) {
  if (typeof raw !== "string") return [];
  // Separators: , | ; · • anywhere; / & + only when spaced ("AT&T" survives);
  // whitespace before an @handle. Never "and" — it lives inside real names
  // ("University of Science and Technology of China").
  const parts = raw
    .split(/\s*[,|;·•]\s*|\s+[/&+]\s+|\s+(?=@)/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/^https?:\/\//i.test(p) ? hostLabel(p) : p))
    .filter(Boolean);
  return parts.filter((p) => !/^(ex[-\s]|former|formerly|prev(iously)?\b)/i.test(p));
}

/** "https://www.acme.io/x" → "acme" (the registrable label). */
function hostLabel(url) {
  const host = hostOf(url);
  if (!host || PERSONAL_HOSTS.test(host)) return "";
  const labels = host.split(".");
  return labels.length >= 2 ? labels[labels.length - 2] : labels[0];
}

/** Host of a URL-ish string without `www.`, or "" when it isn't one. */
export function hostOf(url) {
  if (typeof url !== "string" || !url.trim()) return "";
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// Personal-site hosts never identify an employer.
const PERSONAL_HOSTS =
  /(^|\.)(github\.io|gitlab\.io|vercel\.app|netlify\.app|pages\.dev|medium\.com|substack\.com|linkedin\.com|twitter\.com|x\.com|github\.com|gmail\.com|about\.me|linktr\.ee|notion\.site|blogspot\.com|wordpress\.com|hashnode\.dev|dev\.to|youtube\.com|bento\.me|carrd\.co)$/;

/**
 * A website host is evidence for a company only when its registrable label
 * matches the company key ("optimizely.com" for key "optimizely").
 */
export function hostMatchesKey(host, key) {
  if (!host || !key || PERSONAL_HOSTS.test(host)) return false;
  const labels = host.split(".");
  const label = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  const compact = key.replace(/\s+/g, "");
  return label === compact || (compact.length >= 4 && label.startsWith(compact));
}

/** Floor to the nearest `step` for a "5,300+"-style caption. */
export function floorTo(n, step = 100) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n / step) * step;
}
