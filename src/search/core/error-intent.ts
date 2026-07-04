// Atomic error-token detection for error-intent search queries.
//
// A developer pasting a runtime/compiler error string ("ERR_MODULE_NOT_FOUND
// cannot find package", "error[E0499] cannot borrow") wants pages that discuss
// that exact token. General web engines tokenise the string and substring-match
// the shortest fragment ("ERR", "panic") against broadcasters, dictionaries and
// unrelated brands (err.ee, Cambridge "ERR", a Thai restaurant), which then
// crowd out the actual fix pages. Two things need the atomic token:
//   1. a bare-token dispatch variant — engines that return 0 for the long
//      natural-language form return on-target pages for the token alone;
//   2. a per-result survival predicate — a result that does not mention the
//      token anywhere is junk for an error-intent query and is damped.
//
// Detection is SHAPE-based, not a token allow-list, so it generalises to any
// ecosystem (Node errno, npm codes, Rust/C#/TS compiler codes, Postgres
// SQLSTATE). It is deliberately conservative: ordinary uppercase acronyms
// (HTTP, JSON, API, REST, AWS) and single-uppercase-word queries must NOT be
// classified as errors, or a normal query would be mangled.

export interface ErrorScorable {
  title: string;
  url: string;
  snippet: string;
}

// SCREAMING_SNAKE identifier: two-plus underscore-joined all-caps/digit
// segments. This shape ALSO matches config/env/API constants (DATABASE_URL,
// JAVA_HOME, GL_TEXTURE_2D) which are NOT errors, so it is only self-evident
// when the identifier itself reads as an error (ERR-prefixed, or carrying an
// ERROR/EXCEPTION/FAIL/FATAL segment). Otherwise it requires query-wide error
// context. Captures ERR_MODULE_NOT_FOUND, ERR_SSL_PROTOCOL_ERROR while leaving
// ordinary env vars alone.
const SCREAMING_SNAKE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const ERRORY_SNAKE_SEGMENT_RE = /(^|_)(ERR|ERROR|ERRNO|EXCEPTION|FAIL|FAILED|FAILURE|FATAL|PANIC)(_|$)/;

// Errno / npm-style bare code: "E" followed by >=4 uppercase letters, no
// digits, no underscore. Captures EADDRINUSE, ENOENT, ERESOLVE, ELIFECYCLE,
// EACCES. The shape alone also matches ordinary all-caps English words
// (EXPORT, ENGINE, EXAMPLE), so — like the bare compiler code — it is only
// taken when the query also carries an error-context signal; a real errno
// paste virtually always does ("Error: getaddrinfo ENOTFOUND", "npm ERR!
// code ERESOLVE"). "ERR" alone (3 chars) is intentionally NOT a token — it is
// the very fragment that mis-matches.
const ERRNO_RE = /^E[A-Z]{4,}$/;

// The literal words "ERROR"/"ERRORS" match the errno shape but are the very
// fragments dictionaries and broadcasters match — using them as a survival
// token would keep exactly the junk we are trying to remove (a Cambridge
// "ERROR" definition page contains "error"). Never treat them as atomic tokens.
const ERRNO_STOPWORDS = new Set(['ERROR', 'ERRORS']);

// Fixed-width all-caps labels used AS the error's name. Kept narrow to tokens
// that are error-specific; ordinary words a developer searches (STATUS, STATE)
// are deliberately excluded so a query like "STATUS 200 OK" is untouched.
const ERROR_LABEL_WORDS = new Set(['SQLSTATE', 'ERRNO', 'EXITCODE']);

// Compiler-error code shape: 1-4 letters + >=3 digits (E0499, CS0246, TS2345,
// C1083). Digit-bearing and high-IDF but collides with codec/spec/hardware
// identifiers (H264, RFC7231, B550, RTX4090). A bracketed occurrence
// (error[E0499]) is unambiguous and always taken. A bare occurrence counts
// ONLY when an "error"/"warning" word immediately precedes it (error CS0246,
// error TS2345) — the way compilers actually print them — so an incidental
// error-context word elsewhere in the query cannot license a hardware token.
const COMPILER_CODE_RE = /^[A-Z]{1,4}\d{3,}$/;
const BRACKETED_CODE_RE = /\[\s*([A-Z]{1,4}\d{3,})\s*\]/g;
const PREFIXED_COMPILER_CODE_RE = /\b(?:error|warning|err|fatal)\s+([A-Z]{1,4}\d{3,})\b/gi;

// Error-context words that license the bare errno shape. Presence of any one
// means the query is talking about a failure, not an ordinary all-caps word.
const ERROR_CONTEXT_RE =
  /\b(error|errors|err|panic|exception|traceback|stacktrace|stack\s*trace|failed|failure|cannot|could\s*not|unable|throw|thrown|crash|segfault|fatal)\b/i;

function stripEdges(token: string): string {
  return token.replace(/^[^A-Za-z0-9_]+/, '').replace(/[^A-Za-z0-9_]+$/, '');
}

/**
 * Extract atomic error tokens from a query by shape. Returns the tokens in
 * their surface form (uppercase), de-duplicated, order-preserving. Empty when
 * the query carries no atomic error token.
 */
export function extractErrorTokens(query: string): string[] {
  if (typeof query !== 'string' || query.trim() === '') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };

  // Bracketed compiler codes are unambiguous — take them regardless of context.
  for (const m of query.matchAll(BRACKETED_CODE_RE)) {
    push(m[1]);
  }
  // "error CS0246" / "error TS2345": a compiler code printed with its leading
  // error/warning word. Precise (adjacency, not a query-wide gate) so a
  // hardware/codec token elsewhere is not swept in.
  for (const m of query.matchAll(PREFIXED_COMPILER_CODE_RE)) {
    push(m[1].toUpperCase());
  }

  const rawTokens = query.trim().split(/\s+/).map(stripEdges);

  // First pass: self-evident error tokens whose SHAPE does not collide with
  // ordinary words — error-flavoured SCREAMING_SNAKE identifiers (ERR-prefixed
  // or carrying an ERROR/EXCEPTION/FAIL segment) and the fixed error-label
  // words. Their presence also establishes error context for the ambiguous
  // errno shape below. Ordinary config/env constants (DATABASE_URL, JAVA_HOME)
  // are held back to the context-gated pass.
  const plainSnake: string[] = [];
  for (const t of rawTokens) {
    if (t.length < 4) continue;
    if (ERROR_LABEL_WORDS.has(t)) {
      push(t);
      continue;
    }
    if (SCREAMING_SNAKE_RE.test(t)) {
      if (ERRORY_SNAKE_SEGMENT_RE.test(t)) push(t);
      else plainSnake.push(t);
    }
  }

  // Ambiguous shapes (bare errno, plain SCREAMING_SNAKE constant) collide with
  // ordinary all-caps words / config identifiers, so they are taken ONLY when
  // the query carries an error-context signal: an error-context word or a
  // self-evident token already found above.
  const hasErrorContext = ERROR_CONTEXT_RE.test(query) || out.length > 0;
  if (hasErrorContext) {
    for (const t of rawTokens) {
      if (t.length < 4) continue;
      if (ERRNO_RE.test(t) && !ERRNO_STOPWORDS.has(t)) push(t);
    }
    for (const t of plainSnake) push(t);
  }
  return out;
}

/**
 * True when the query carries at least one atomic error token. This is the
 * error-intent gate: it fires ONLY on genuine error strings, never on ordinary
 * acronym or single-uppercase-word queries.
 */
export function hasErrorIntent(query: string): boolean {
  return extractErrorTokens(query).length > 0;
}

/**
 * Per-result survival predicate: true when any atomic error token appears in
 * the result's title, snippet, or URL (case-insensitive). A result that
 * mentions none of the tokens is off-target junk for an error-intent query.
 */
export function resultMatchesErrorToken(result: ErrorScorable, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
  return tokens.some((t) => hay.includes(t.toLowerCase()));
}
