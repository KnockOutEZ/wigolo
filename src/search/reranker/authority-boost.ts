export interface AuthorityBoostable {
  url: string;
  relevance_score: number;
}

export interface AuthorityBoostOptions {
  /** URLs that are rare-term MISSES for the current query (contain none of the
   * query's compound tokens, or have phrase run < 2). Generic (non-known-
   * subject) authority for these is multiplicatively reduced so an off-topic
   * high-authority page can't outrank an exact-match page. Per-result, not
   * query-wide: a high-authority page that DOES contain the rare terms (a hit)
   * keeps its full authority. */
  capUrls?: ReadonlySet<string>;
}

// Generic (non-known-subject) authority is REDUCED by this factor for rare-term
// miss results. Must be multiplicative, not a Math.min ceiling: the additive
// boosts (down to +0.04 for an authoritative TLD) sit on a tiny ~0.016 RRF base,
// so a clamp ceiling above 0.04 would be a no-op and an off-topic .org/.io page
// would still win. Multiplicative reduction shrinks every generic boost
// proportionally.
const GENERIC_AUTHORITY_RARE_FACTOR = 0.25;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'what', 'is', 'are', 'was', 'were', 'how', 'why', 'when', 'where', 'who',
  'do', 'does', 'did', 'for', 'of', 'to', 'in', 'on', 'with', 'and', 'or', 'but', 'as', 'at',
  'by', 'from', 'into', 'about', 'than', 'this', 'that', 'these', 'those', 'it', 'its', 'be',
  'been', 'has', 'have', 'had', 'can', 'could', 'should', 'would', 'may', 'might', 'must',
  'will', 'shall', 'i', 'you', 'we', 'they', 'he', 'she', 'them', 'my', 'your', 'our', 'their',
  'latest', 'current', 'newest', 'recent', 'best', 'top', 'most',
]);

const AUTHORITATIVE_TLD = /\.(io|org|dev|edu|gov)$/;
const KNOWN_DOCS_HOSTS = new Set([
  'docs.python.org', 'developer.mozilla.org', 'kubernetes.io', 'cloud.google.com',
  'aws.amazon.com', 'docs.aws.amazon.com', 'learn.microsoft.com', 'docs.microsoft.com',
  'developer.apple.com', 'docs.docker.com', 'docs.npmjs.com', 'docs.github.com',
  'docs.anthropic.com',
]);

const KNOWN_SUBJECT_DOMAIN: Record<string, string[]> = {
  redis: ['redis.io', 'redis.com'],
  postgres: ['postgresql.org', 'neon.tech'],
  postgresql: ['postgresql.org', 'neon.tech'],
  pg: ['postgresql.org', 'neon.tech', 'edb.com'],
  neon: ['neon.tech'],
  pgedge: ['pgedge.com'],
  cockroachdb: ['cockroachlabs.com'],
  cockroach: ['cockroachlabs.com'],
  supabase: ['supabase.com', 'supabase.io'],
  mysql: ['mysql.com', 'dev.mysql.com'],
  python: ['python.org', 'docs.python.org'],
  react: ['react.dev', 'reactjs.org'],
  nextjs: ['nextjs.org'],
  vue: ['vuejs.org'],
  angular: ['angular.io', 'angular.dev'],
  node: ['nodejs.org'],
  nodejs: ['nodejs.org'],
  rust: ['rust-lang.org', 'doc.rust-lang.org'],
  go: ['go.dev', 'golang.org'],
  golang: ['go.dev', 'golang.org'],
  typescript: ['typescriptlang.org'],
  javascript: ['developer.mozilla.org'],
  anthropic: ['anthropic.com', 'docs.anthropic.com'],
  openai: ['openai.com', 'platform.openai.com'],
  google: ['google.com', 'cloud.google.com'],
  microsoft: ['microsoft.com', 'learn.microsoft.com'],
  apple: ['apple.com', 'developer.apple.com'],
  github: ['github.com', 'docs.github.com'],
  gitlab: ['gitlab.com'],
  docker: ['docker.com', 'docs.docker.com'],
  kubernetes: ['kubernetes.io'],
  k8s: ['kubernetes.io'],
  aws: ['aws.amazon.com', 'docs.aws.amazon.com'],
  azure: ['azure.microsoft.com', 'learn.microsoft.com'],
  gcp: ['cloud.google.com'],
  npm: ['npmjs.com', 'docs.npmjs.com'],
  pnpm: ['pnpm.io'],
  yarn: ['yarnpkg.com'],
  mcp: ['modelcontextprotocol.io', 'spec.modelcontextprotocol.io', 'docs.anthropic.com'],
};

function extractSubjects(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && t.length <= 16 && !STOPWORDS.has(t));
  // Versioned tokens like "pg18", "ts5", "py312" should also match their
  // base alias ("pg", "ts", "py") so authoritative domains still get boosted
  // when users include a release number inline with the project name.
  const expanded = new Set<string>(tokens);
  for (const t of tokens) {
    const stripped = t.replace(/\d+$/, '');
    if (stripped && stripped !== t && stripped.length >= 2) expanded.add(stripped);
  }
  return [...expanded];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function applyAuthorityBoost<T extends AuthorityBoostable>(
  query: string,
  results: T[],
  opts: AuthorityBoostOptions = {},
): T[] {
  if (results.length === 0) return results;
  const subjects = extractSubjects(query);
  const knownDomains = new Set<string>();
  for (const s of subjects) {
    const mapped = KNOWN_SUBJECT_DOMAIN[s];
    if (mapped) for (const d of mapped) knownDomains.add(d);
  }

  return results.map((r) => {
    const host = hostOf(r.url);
    if (!host) return r;

    let boost = 0;
    let fromKnownSubject = false;

    if (knownDomains.has(host)) { boost += 0.20; fromKnownSubject = true; }
    else for (const dom of knownDomains) {
      if (host.endsWith(`.${dom}`)) { boost += 0.18; fromKnownSubject = true; break; }
    }

    if (boost === 0) {
      for (const subj of subjects) {
        if (host === `${subj}.io` || host === `${subj}.com` || host === `${subj}.org` || host === `${subj}.dev`) {
          boost += 0.15;
          break;
        }
        if (host.startsWith(`${subj}.`) || host.includes(`.${subj}.`)) {
          boost += 0.10;
          break;
        }
      }
    }

    if (KNOWN_DOCS_HOSTS.has(host)) boost = Math.max(boost, 0.18);
    else if (host.startsWith('docs.')) boost += 0.08;

    if (boost === 0 && AUTHORITATIVE_TLD.test(host)) boost += 0.04;

    if (opts.capUrls?.has(r.url) && !fromKnownSubject) {
      boost *= GENERIC_AUTHORITY_RARE_FACTOR;
    }

    if (boost === 0) return r;

    return {
      ...r,
      relevance_score: Math.min(1, r.relevance_score + boost),
    };
  });
}
