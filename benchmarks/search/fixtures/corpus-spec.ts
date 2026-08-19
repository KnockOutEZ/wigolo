/**
 * S14-0 — the judged retrieval corpus, authored rather than harvested.
 *
 * LICENCE, and it is the reason this file exists instead of a scrape. Search-engine output may not be
 * used as a fixture (CEO ruling), so every title, snippet and URL below is **written for this corpus**.
 * The URLs name real documentation *locations* — a path on a public docs site is a fact, not somebody's
 * copyrightable result set — and no ranking, snippet or ordering is taken from any engine. Each emitted
 * response therefore carries `licence: 'synthetic'`, mirroring C0's per-fixture `licence` field, which is
 * the only reason that corpus is auditable.
 *
 * WHY THE RELEVANT RESULT IS NOT ALWAYS FIRST. A corpus where the best answer always ranks first measures
 * MRR 1.0 and **cannot detect a ranking change in either direction** — it would be an instrument with no
 * dynamic range, which is the vacuous-gate shape this program keeps finding. `rank` below is the position
 * the top-graded result is planted at, spread deliberately across 1-5 so the baseline sits mid-range with
 * headroom above and below.
 *
 * SIZE. G-S14-0b requires N ≥ 40: MRR resolution is 1/N, and the finest threshold any S14 gate states is
 * 0.05, so 40 queries give 0.025 — at least 2× the threshold. A corpus at 21 (the previous size) resolves
 * to 0.048, which is within one resolution unit of the threshold and cannot distinguish a real effect from
 * a single judgment flip.
 */

export interface CorpusEntry {
  id: string;
  query: string;
  category: string;
  /** Documentation host the graded answers live on. */
  domain: string;
  /** Graded answers: path + grade (3 = the answer, 2 = strong, 1 = related). */
  graded: Array<{ path: string; title: string; grade: 1 | 2 | 3 }>;
  /** Where the top-graded result is planted in the returned list (1-based). */
  rank: number;
  /** Hosts used to fill the rest of the list. Never graded. */
  distractors: string[];
  tags?: string[];
}

const D = {
  ts: 'www.typescriptlang.org',
  node: 'nodejs.org',
  mdn: 'developer.mozilla.org',
  react: 'react.dev',
  py: 'docs.python.org',
  pg: 'www.postgresql.org',
  rust: 'doc.rust-lang.org',
  go: 'go.dev',
  vite: 'vite.dev',
  vitest: 'vitest.dev',
  sqlite: 'www.sqlite.org',
  docker: 'docs.docker.com',
} as const;

const FILLER = ['example.dev', 'notes.example.com', 'blog.example.org', 'forum.example.net', 'wiki.example.io'];

export const CORPUS: CorpusEntry[] = [
  { id: 'docs-001', query: 'typescript Record utility type', category: 'docs', domain: D.ts, rank: 1,
    graded: [{ path: '/docs/handbook/utility-types.html', title: 'Utility Types', grade: 3 },
             { path: '/docs/handbook/2/mapped-types.html', title: 'Mapped Types', grade: 2 }],
    distractors: FILLER, tags: ['typescript'] },
  { id: 'docs-002', query: 'typescript satisfies operator', category: 'docs', domain: D.ts, rank: 2,
    graded: [{ path: '/docs/handbook/release-notes/typescript-4-9.html', title: 'TypeScript 4.9', grade: 3 }],
    distractors: FILLER, tags: ['typescript'] },
  { id: 'docs-003', query: 'node fs promises readFile', category: 'docs', domain: D.node, rank: 1,
    graded: [{ path: '/api/fs.html', title: 'File system', grade: 3 },
             { path: '/api/promises.html', title: 'Promises API', grade: 1 }],
    distractors: FILLER, tags: ['node'] },
  { id: 'docs-004', query: 'node worker threads shared memory', category: 'docs', domain: D.node, rank: 3,
    graded: [{ path: '/api/worker_threads.html', title: 'Worker threads', grade: 3 }],
    distractors: FILLER, tags: ['node'] },
  { id: 'docs-005', query: 'mdn intersection observer options', category: 'docs', domain: D.mdn, rank: 1,
    graded: [{ path: '/en-US/docs/Web/API/IntersectionObserver', title: 'IntersectionObserver', grade: 3 },
             { path: '/en-US/docs/Web/API/IntersectionObserverEntry', title: 'IntersectionObserverEntry', grade: 2 }],
    distractors: FILLER },
  { id: 'docs-006', query: 'css container queries syntax', category: 'docs', domain: D.mdn, rank: 2,
    graded: [{ path: '/en-US/docs/Web/CSS/CSS_containment/Container_queries', title: 'Container queries', grade: 3 }],
    distractors: FILLER },
  { id: 'docs-007', query: 'postgres generated columns', category: 'docs', domain: D.pg, rank: 1,
    graded: [{ path: '/docs/current/ddl-generated-columns.html', title: 'Generated Columns', grade: 3 }],
    distractors: FILLER, tags: ['postgres'] },
  { id: 'docs-008', query: 'sqlite fts5 match syntax', category: 'docs', domain: D.sqlite, rank: 1,
    graded: [{ path: '/fts5.html', title: 'SQLite FTS5 Extension', grade: 3 }],
    distractors: FILLER, tags: ['sqlite'] },
  { id: 'error-001', query: 'ERR_MODULE_NOT_FOUND cannot find package', category: 'error', domain: D.node, rank: 2,
    graded: [{ path: '/api/errors.html', title: 'Errors', grade: 3 },
             { path: '/api/esm.html', title: 'ECMAScript modules', grade: 2 }],
    distractors: FILLER },
  { id: 'error-002', query: 'SQLITE_BUSY database is locked', category: 'error', domain: D.sqlite, rank: 1,
    graded: [{ path: '/rescode.html', title: 'Result and Error Codes', grade: 3 },
             { path: '/lockingv3.html', title: 'File Locking And Concurrency', grade: 2 }],
    distractors: FILLER },
  { id: 'error-003', query: 'too many SQL variables', category: 'error', domain: D.sqlite, rank: 3,
    graded: [{ path: '/limits.html', title: 'Limits In SQLite', grade: 3 }],
    distractors: FILLER },
  { id: 'error-004', query: 'python ModuleNotFoundError no module named', category: 'error', domain: D.py, rank: 2,
    graded: [{ path: '/3/tutorial/modules.html', title: 'Modules', grade: 3 }],
    distractors: FILLER },
  { id: 'error-005', query: 'rust borrow checker cannot borrow as mutable', category: 'error', domain: D.rust, rank: 1,
    graded: [{ path: '/book/ch04-02-references-and-borrowing.html', title: 'References and Borrowing', grade: 3 }],
    distractors: FILLER },
  { id: 'error-006', query: 'go nil pointer dereference panic', category: 'error', domain: D.go, rank: 4,
    graded: [{ path: '/doc/effective_go', title: 'Effective Go', grade: 2 }],
    distractors: FILLER },
  { id: 'conceptual-001', query: 'what is reciprocal rank fusion', category: 'conceptual', domain: D.pg, rank: 3,
    graded: [{ path: '/docs/current/textsearch-controls.html', title: 'Controlling Text Search', grade: 1 }],
    distractors: FILLER },
  { id: 'conceptual-002', query: 'how does write ahead logging work', category: 'conceptual', domain: D.sqlite, rank: 1,
    graded: [{ path: '/wal.html', title: 'Write-Ahead Logging', grade: 3 }],
    distractors: FILLER },
  { id: 'conceptual-003', query: 'difference between mapped and conditional types', category: 'conceptual', domain: D.ts, rank: 2,
    graded: [{ path: '/docs/handbook/2/conditional-types.html', title: 'Conditional Types', grade: 3 },
             { path: '/docs/handbook/2/mapped-types.html', title: 'Mapped Types', grade: 2 }],
    distractors: FILLER },
  { id: 'conceptual-004', query: 'react server components explained', category: 'conceptual', domain: D.react, rank: 1,
    graded: [{ path: '/reference/rsc/server-components', title: 'Server Components', grade: 3 }],
    distractors: FILLER },
  { id: 'conceptual-005', query: 'rust ownership model overview', category: 'conceptual', domain: D.rust, rank: 2,
    graded: [{ path: '/book/ch04-01-what-is-ownership.html', title: 'What is Ownership?', grade: 3 }],
    distractors: FILLER },
  { id: 'code-001', query: 'react useSyncExternalStore example', category: 'code', domain: D.react, rank: 1,
    graded: [{ path: '/reference/react/useSyncExternalStore', title: 'useSyncExternalStore', grade: 3 }],
    distractors: FILLER },
  { id: 'code-002', query: 'react useDeferredValue vs useTransition', category: 'code', domain: D.react, rank: 3,
    graded: [{ path: '/reference/react/useDeferredValue', title: 'useDeferredValue', grade: 3 },
             { path: '/reference/react/useTransition', title: 'useTransition', grade: 2 }],
    distractors: FILLER },
  { id: 'code-003', query: 'python dataclass field default_factory', category: 'code', domain: D.py, rank: 1,
    graded: [{ path: '/3/library/dataclasses.html', title: 'dataclasses', grade: 3 }],
    distractors: FILLER },
  { id: 'code-004', query: 'go context with timeout example', category: 'code', domain: D.go, rank: 2,
    graded: [{ path: '/blog/context', title: 'Go Concurrency Patterns: Context', grade: 3 }],
    distractors: FILLER },
  { id: 'code-005', query: 'vitest mock module factory', category: 'code', domain: D.vitest, rank: 1,
    graded: [{ path: '/api/vi.html', title: 'Vi', grade: 3 },
             { path: '/guide/mocking.html', title: 'Mocking', grade: 2 }],
    distractors: FILLER },
  { id: 'code-006', query: 'rust iterator collect into hashmap', category: 'code', domain: D.rust, rank: 2,
    graded: [{ path: '/std/iter/trait.Iterator.html', title: 'Iterator', grade: 3 }],
    distractors: FILLER },
  { id: 'api-001', query: 'vite define config plugins', category: 'api', domain: D.vite, rank: 1,
    graded: [{ path: '/config/', title: 'Configuring Vite', grade: 3 }],
    distractors: FILLER },
  { id: 'api-002', query: 'vitest config coverage provider', category: 'api', domain: D.vitest, rank: 2,
    graded: [{ path: '/config/', title: 'Configuring Vitest', grade: 3 }],
    distractors: FILLER },
  { id: 'api-003', query: 'docker compose healthcheck syntax', category: 'api', domain: D.docker, rank: 1,
    graded: [{ path: '/reference/compose-file/services/', title: 'Services top-level element', grade: 3 }],
    distractors: FILLER },
  { id: 'api-004', query: 'node crypto createHash algorithms', category: 'api', domain: D.node, rank: 1,
    graded: [{ path: '/api/crypto.html', title: 'Crypto', grade: 3 }],
    distractors: FILLER },
  { id: 'config-001', query: 'tsconfig moduleResolution bundler', category: 'config', domain: D.ts, rank: 2,
    graded: [{ path: '/tsconfig/#moduleResolution', title: 'moduleResolution', grade: 3 }],
    distractors: FILLER },
  { id: 'config-002', query: 'tsconfig exclude tests directory', category: 'config', domain: D.ts, rank: 3,
    graded: [{ path: '/tsconfig/#exclude', title: 'exclude', grade: 3 }],
    distractors: FILLER },
  { id: 'config-003', query: 'postgres shared_buffers tuning', category: 'config', domain: D.pg, rank: 2,
    graded: [{ path: '/docs/current/runtime-config-resource.html', title: 'Resource Consumption', grade: 3 }],
    distractors: FILLER },
  { id: 'security-001', query: 'content security policy frame-ancestors', category: 'security', domain: D.mdn, rank: 1,
    graded: [{ path: '/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors', title: 'CSP: frame-ancestors', grade: 3 }],
    distractors: FILLER },
  { id: 'security-002', query: 'same origin policy cors preflight', category: 'security', domain: D.mdn, rank: 2,
    graded: [{ path: '/en-US/docs/Web/HTTP/CORS', title: 'Cross-Origin Resource Sharing', grade: 3 },
             { path: '/en-US/docs/Web/Security/Same-origin_policy', title: 'Same-origin policy', grade: 2 }],
    distractors: FILLER },
  { id: 'security-003', query: 'node ssrf prevent private ip fetch', category: 'security', domain: D.node, rank: 4,
    graded: [{ path: '/api/net.html', title: 'Net', grade: 1 }],
    distractors: FILLER },
  { id: 'debug-001', query: 'chrome devtools protocol accessibility tree', category: 'debug', domain: D.mdn, rank: 3,
    graded: [{ path: '/en-US/docs/Web/Accessibility/Accessibility_tree', title: 'Accessibility tree', grade: 2 }],
    distractors: FILLER },
  { id: 'debug-002', query: 'node inspect memory heap snapshot', category: 'debug', domain: D.node, rank: 2,
    graded: [{ path: '/api/v8.html', title: 'V8', grade: 2 }],
    distractors: FILLER },
  { id: 'tutorial-001', query: 'getting started with vite react', category: 'tutorial', domain: D.vite, rank: 1,
    graded: [{ path: '/guide/', title: 'Getting Started', grade: 3 }],
    distractors: FILLER },
  { id: 'tutorial-002', query: 'python asyncio tutorial tasks', category: 'tutorial', domain: D.py, rank: 2,
    graded: [{ path: '/3/library/asyncio-task.html', title: 'Coroutines and Tasks', grade: 3 }],
    distractors: FILLER },
  { id: 'comparison-001', query: 'sqlite vs postgres full text search', category: 'comparison', domain: D.sqlite, rank: 2,
    graded: [{ path: '/fts5.html', title: 'SQLite FTS5 Extension', grade: 2 },
             { path: '/whentouse.html', title: 'Appropriate Uses For SQLite', grade: 2 }],
    distractors: [D.pg, ...FILLER] },
  { id: 'comparison-002', query: 'npm vs pnpm workspaces', category: 'comparison', domain: D.node, rank: 3,
    graded: [{ path: '/api/packages.html', title: 'Modules: Packages', grade: 1 }],
    distractors: FILLER },
  { id: 'multi-query-001', query: 'rust async runtime comparison', category: 'multi-query', domain: D.rust, rank: 2,
    graded: [{ path: '/book/ch17-00-async-await.html', title: 'Async and Await', grade: 2 }],
    distractors: FILLER },
  { id: 'multi-query-002', query: 'go generics type constraints', category: 'multi-query', domain: D.go, rank: 1,
    graded: [{ path: '/doc/tutorial/generics', title: 'Tutorial: Getting started with generics', grade: 3 }],
    distractors: FILLER },
  { id: 'recent-001', query: 'react 19 use hook', category: 'recent', domain: D.react, rank: 1,
    graded: [{ path: '/reference/react/use', title: 'use', grade: 3 }],
    distractors: FILLER },
  { id: 'recent-002', query: 'node permission model flags', category: 'recent', domain: D.node, rank: 2,
    graded: [{ path: '/api/permissions.html', title: 'Permissions', grade: 3 }],
    distractors: FILLER },
];
