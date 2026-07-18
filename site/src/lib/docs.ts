import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The public docs live at repo-root /docs (one level above site/). We read them
// with fs at build time — static export runs Server Components during `next build`,
// so nothing is fetched at runtime and the rendered HTML ships in the export.
const DOCS_DIR = join(process.cwd(), "..", "docs");

const GH_REPO = "https://github.com/KnockOutEZ/wigolo";
const GH_BLOB = `${GH_REPO}/blob/main`;
const GH_TREE = `${GH_REPO}/tree/main`;
const GH_EDIT = `${GH_REPO}/edit/main/docs`;

export type DocMeta = {
  slug: string;
  title: string;
  blurb: string;
};

export type Doc = DocMeta & {
  markdown: string;
};

/**
 * Sidebar order. `index` is docs/README.md rendered at /docs; the rest map
 * filename-minus-.md → route slug. Order matches the Pages table in
 * docs/README.md so the sidebar reads top-to-bottom the same as the index.
 */
export const DOCS_NAV: DocMeta[] = [
  { slug: "index", title: "Overview", blurb: "What wigolo is and where to start." },
  {
    slug: "getting-started",
    title: "Getting started",
    blurb: "The 5-minute path: init, wire an agent, first search.",
  },
  {
    slug: "installation",
    title: "Installation",
    blurb: "Every install channel, the agent auto-wire matrix, uninstall.",
  },
  {
    slug: "configuration",
    title: "Configuration",
    blurb: "Resolution order, the settings TUI, grouped env-var tables.",
  },
  {
    slug: "tools",
    title: "Tools",
    blurb: "The 10 tools with parameters, response fields, examples.",
  },
  {
    slug: "cli",
    title: "CLI",
    blurb: "Full command reference, one-shot tools, the interactive shell.",
  },
  {
    slug: "rest-api",
    title: "REST API",
    blurb: "serve, endpoints, the fail-closed auth model, resource limits.",
  },
  {
    slug: "sdks",
    title: "SDKs",
    blurb: "TypeScript and Python clients, plus framework integrations.",
  },
  {
    slug: "self-hosting",
    title: "Self-hosting",
    blurb: "Running wigolo where your agents run: VPS, Docker, tokens.",
  },
  {
    slug: "skills",
    title: "Skills",
    blurb: "Agent skill packs: the catalog, install scopes, receipts.",
  },
  {
    slug: "plugins",
    title: "Plugins",
    blurb: "Extend wigolo with your own search engines and extractors.",
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    blurb: "Symptom-to-fix table, platform notes, and the FAQ.",
  },
  {
    slug: "privacy-security",
    title: "Privacy & security",
    blurb: "What lives on disk, what leaves your machine, disclosure.",
  },
];

/** slug → source filename under docs/. */
function fileForSlug(slug: string): string {
  return slug === "index" ? "README.md" : `${slug}.md`;
}

const KNOWN_SLUGS = new Set(DOCS_NAV.map((d) => d.slug));

/** Read a single doc's raw markdown. Throws if the slug is unknown/missing. */
export function getDoc(slug: string): Doc {
  const meta = DOCS_NAV.find((d) => d.slug === slug);
  if (!meta) throw new Error(`Unknown doc slug: ${slug}`);
  const markdown = readFileSync(join(DOCS_DIR, fileForSlug(slug)), "utf8");
  return { ...meta, markdown };
}

/** Every non-index slug — the `generateStaticParams` source for /docs/[slug]. */
export function getDocSlugs(): string[] {
  return DOCS_NAV.filter((d) => d.slug !== "index").map((d) => d.slug);
}

/** Prev/next neighbours in sidebar order (index included). */
export function getDocNeighbours(slug: string): {
  prev: DocMeta | null;
  next: DocMeta | null;
} {
  const i = DOCS_NAV.findIndex((d) => d.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? DOCS_NAV[i - 1] : null,
    next: i < DOCS_NAV.length - 1 ? DOCS_NAV[i + 1] : null,
  };
}

/** The GitHub "edit this page" URL for a doc. */
export function editUrlForSlug(slug: string): string {
  return `${GH_EDIT}/${fileForSlug(slug)}`;
}

// Build a filename→slug map (README.md → index) for link rewriting.
const FILE_TO_SLUG = new Map<string, string>();
for (const d of DOCS_NAV) FILE_TO_SLUG.set(fileForSlug(d.slug).toLowerCase(), d.slug);

/**
 * Rewrite a markdown href to a site-usable target.
 *
 * Returns `{ href, internal }`:
 *  - internal `/docs/...` routes (rendered via next/link so the GH Pages
 *    basePath is applied automatically),
 *  - external/GitHub-blob absolute URLs (rendered as plain <a>).
 *
 * Rules:
 *  - `./other.md`, `./other.md#anchor` → `/docs/other`, `/docs/other#anchor`
 *    (README.md → /docs). Unknown doc files fall back to the GitHub blob.
 *  - repo-relative links that leave docs/ (`../examples/…`, `../SECURITY.md`,
 *    `../packaging/compose.serve.yml`) → GitHub blob/tree URL.
 *  - bare `#anchor` → same-page anchor (kept as-is).
 *  - absolute http(s), mailto, protocol-relative → untouched.
 */
export function rewriteHref(raw: string): { href: string; internal: boolean } {
  const href = raw.trim();

  // Same-page fragment or empty — leave alone.
  if (href === "" || href.startsWith("#")) {
    return { href, internal: false };
  }

  // Absolute / external / mailto / protocol-relative — untouched.
  if (/^(https?:)?\/\//i.test(href) || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return { href, internal: false };
  }

  // Split off a trailing #anchor / ?query so we can map just the path.
  const hashIdx = href.search(/[#?]/);
  const path = hashIdx === -1 ? href : href.slice(0, hashIdx);
  const suffix = hashIdx === -1 ? "" : href.slice(hashIdx);

  // Inter-doc link: ./file.md (optionally with a leading ./). Strip a single
  // leading ./ and match against known doc files.
  const bare = path.replace(/^\.\//, "");
  if (!bare.startsWith("../") && bare.toLowerCase().endsWith(".md")) {
    const slug = FILE_TO_SLUG.get(bare.toLowerCase());
    if (slug) {
      const route = slug === "index" ? "/docs" : `/docs/${slug}`;
      return { href: `${route}${suffix}`, internal: true };
    }
    // A .md that isn't one of our docs — point at the GitHub blob for it.
    return { href: `${GH_BLOB}/docs/${bare}${suffix}`, internal: false };
  }

  // Repo-relative link escaping docs/ (../something). Resolve against the repo
  // root and map to a GitHub URL. Directory-ish paths (trailing slash) → tree,
  // file paths → blob.
  const repoPath = path.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
  const isDir = path.endsWith("/");
  const base = isDir ? GH_TREE : GH_BLOB;
  const cleaned = repoPath.replace(/\/$/, "");
  return { href: `${base}/${cleaned}${suffix}`, internal: false };
}

// Guard: keep the nav list and the on-disk docs in sync at build time. If a
// file is added/removed under docs/ without updating DOCS_NAV, fail the build
// loudly rather than silently dropping a page.
export function assertDocsInSync(): void {
  const onDisk = readdirSync(DOCS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((f) => (f.toLowerCase() === "readme.md" ? "index" : f.replace(/\.md$/i, "")));
  const missing = onDisk.filter((s) => !KNOWN_SLUGS.has(s));
  const extra = [...KNOWN_SLUGS].filter((s) => !onDisk.includes(s));
  if (missing.length || extra.length) {
    throw new Error(
      `docs nav out of sync with docs/ — missing from DOCS_NAV: [${missing.join(
        ", "
      )}], in DOCS_NAV but not on disk: [${extra.join(", ")}]`
    );
  }
}
