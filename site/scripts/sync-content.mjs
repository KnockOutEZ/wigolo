#!/usr/bin/env node
// Copy the repo's public docs/ and examples/ READMEs into site/content/docs/
// (gitignored) as the docs site's content source. The repo files stay plain
// GitHub markdown; this step adds frontmatter, sidebar order and link
// rewriting so the same text works in both places.
//
// Fails the build when docs/ and the docs/README.md "Pages" table disagree,
// or when examples/ and the examples/README.md table disagree — a page is
// never silently dropped from (or dangling in) the sidebar.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const GH = "https://github.com/KnockOutEZ/wigolo";

/** Walk markdown lines, calling `fn` only on text outside fenced code blocks. */
export function mapOutsideFences(markdown, fn) {
  let fence = null;
  return markdown
    .split("\n")
    .map((line) => {
      const m = line.match(/^\s*(```+|~~~+)/);
      if (m) {
        if (!fence) fence = m[1][0];
        else if (m[1][0] === fence) fence = null;
        return line;
      }
      return fence ? line : fn(line);
    })
    .join("\n");
}

/** First `# ` heading outside code, and the markdown with it removed. */
export function takeTitle(markdown) {
  let title = null;
  let fence = false;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (!fence && /^# \S/.test(lines[i])) {
      title = lines[i].slice(2).trim();
      lines.splice(i, 1);
      break;
    }
  }
  return { title, body: lines.join("\n").replace(/^\s*\n/, "") };
}

/** First prose paragraph, flattened to plain text, capped for meta descriptions. */
export function firstParagraph(markdown, max = 160) {
  const para = markdown
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^(#|\||```|!\[|>|-|\*|<)/.test(p));
  if (!para) return "";
  const text = para
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/** Rows of a `| [Label](./target) | description |` index table. */
export function parseIndexTable(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    const m = line.match(/^\|\s*\[([^\]]+)\]\(\.\/([^)]+)\)\s*\|\s*(.+?)\s*\|\s*$/);
    if (m) rows.push({ label: m[1], target: m[2], description: m[3] });
  }
  return rows;
}

// Table cells escape pipes as `\|`; a description is plain text, so unescape.
export const flatten = (s) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\\|/g, "|")
    .replace(/[`*_]/g, "")
    .trim();

/**
 * Map a repo path to where it lives in the content tree, or null when the
 * docs site has no page (or copied asset) for it.
 *   docs/README.md                 → index.md
 *   docs/<page>.md                 → <page>.md
 *   examples/ | examples/README.md → examples/index.md
 *   examples/<x>/ | …/README.md    → examples/<x>/index.md
 *   examples/<x>/<image>           → examples/<x>/<image>   (copied assets)
 */
export function contentPathFor(repoPath, known) {
  const p = repoPath.replace(/\/$/, "");
  if (p === "docs/README.md" || p === "docs") return "index.md";
  let m = p.match(/^docs\/([\w-]+\.md)$/);
  if (m) return known.docs.has(m[1]) ? m[1] : null;
  if (p === "examples" || p === "examples/README.md") return "examples/index.md";
  m = p.match(/^examples\/([\w-]+)(?:\/README\.md)?$/);
  if (m) return known.examples.has(m[1]) ? `examples/${m[1]}/index.md` : null;
  m = p.match(/^examples\/([\w-]+)\/([\w.-]+\.(?:gif|png|jpe?g|svg|webp))$/i);
  if (m && known.examples.has(m[1])) return `examples/${m[1]}/${m[2]}`;
  return null;
}

/**
 * Rewrite relative links/images in one file. `from` is the file's repo path
 * (docs/tools.md), `to` its content path (tools.md). Links that land on a
 * docs-site page become content-relative (Fumadocs turns them into routes);
 * everything else points at GitHub, so no link is ever broken on the site.
 */
export function rewriteLinks(markdown, from, to, known, isDir = () => false) {
  const fromDir = posix.dirname(from);
  const toDir = posix.dirname(to);
  return mapOutsideFences(markdown, (line) =>
    line.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (all, bang, text, target, title) => {
      if (/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(target)) return all;
      const hashAt = target.search(/[#?]/);
      const path = hashAt === -1 ? target : target.slice(0, hashAt);
      const suffix = hashAt === -1 ? "" : target.slice(hashAt);
      if (!path) return all;
      const repoPath = posix.normalize(posix.join(fromDir, path));
      if (repoPath.startsWith("..")) return all;
      const content = contentPathFor(repoPath, known);
      let href;
      if (content) {
        const rel = posix.relative(toDir, content);
        href = rel.startsWith(".") ? rel : `./${rel}`;
      } else {
        const kind = path.endsWith("/") || isDir(repoPath) ? "tree" : "blob";
        href = `${GH}/${kind}/main/${repoPath.replace(/\/$/, "")}`;
      }
      return `${bang}[${text}](${href}${suffix}${title})`;
    }),
  );
}

const yaml = (s) => JSON.stringify(s);

export function withFrontmatter(title, description, body) {
  return `---\ntitle: ${yaml(title)}\ndescription: ${yaml(description)}\n---\n\n${body}`;
}

function main() {
  const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
  const REPO = join(SITE, "..");
  const OUT = join(SITE, "content", "docs");
  const problems = [];
  const isDir = (p) => existsSync(join(REPO, p)) && statSync(join(REPO, p)).isDirectory();

  const docsIndex = readFileSync(join(REPO, "docs", "README.md"), "utf8");
  const exIndex = readFileSync(join(REPO, "examples", "README.md"), "utf8");

  const docRows = parseIndexTable(docsIndex).filter((r) => /^[\w-]+\.md$/.test(r.target));
  const docFiles = readdirSync(join(REPO, "docs")).filter((f) => f.endsWith(".md") && f !== "README.md");
  const exRows = parseIndexTable(exIndex).filter((r) => /^[\w-]+\/?$/.test(r.target));
  const exDirs = readdirSync(join(REPO, "examples")).filter(
    (d) => isDir(`examples/${d}`) && existsSync(join(REPO, "examples", d, "README.md")),
  );

  const tabledDocs = new Set(docRows.map((r) => r.target));
  for (const f of docFiles) if (!tabledDocs.has(f)) problems.push(`docs/${f} is not listed in the docs/README.md Pages table`);
  for (const r of docRows) if (!docFiles.includes(r.target)) problems.push(`docs/README.md lists ${r.target}, which does not exist`);
  const tabledEx = new Set(exRows.map((r) => r.target.replace(/\/$/, "")));
  for (const d of exDirs) if (!tabledEx.has(d)) problems.push(`examples/${d} is not listed in the examples/README.md table`);
  for (const d of tabledEx) if (!exDirs.includes(d)) problems.push(`examples/README.md lists ${d}, which does not exist`);

  const known = { docs: new Set(docFiles), examples: new Set(exDirs) };
  const docDescriptions = new Map(docRows.map((r) => [r.target, flatten(r.description)]));
  const exDescriptions = new Map(exRows.map((r) => [r.target.replace(/\/$/, ""), flatten(r.description)]));

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "examples"), { recursive: true });

  const emit = (from, to, description, titleOverride) => {
    const raw = readFileSync(join(REPO, from), "utf8");
    const { title: h1, body } = takeTitle(raw);
    const title = h1 && titleOverride ? titleOverride : h1;
    if (!title) {
      problems.push(`${from} has no "# " title heading`);
      return;
    }
    const desc = description || firstParagraph(body);
    const text = rewriteLinks(body, from, to, known, isDir);
    mkdirSync(dirname(join(OUT, to)), { recursive: true });
    writeFileSync(join(OUT, to), withFrontmatter(title, desc, text));
  };

  // The index h1 ("wigolo documentation") reads oddly as a sidebar entry.
  emit(
    "docs/README.md",
    "index.md",
    "Install wigolo, wire it into an agent, and use the 10 tools, the REST API, the SDKs and self-hosting.",
    "Overview",
  );
  for (const f of docFiles) emit(`docs/${f}`, f, docDescriptions.get(f));
  emit(
    "examples/README.md",
    "examples/index.md",
    "Runnable examples for every way agents and scripts use wigolo: CLI, shell pipelines, REST, SDKs, n8n, watch jobs and plugins.",
  );
  for (const d of exDirs) {
    emit(`examples/${d}/README.md`, `examples/${d}/index.md`, exDescriptions.get(d));
    for (const asset of readdirSync(join(REPO, "examples", d))) {
      if (/\.(gif|png|jpe?g|svg|webp)$/i.test(asset)) {
        cpSync(join(REPO, "examples", d, asset), join(OUT, "examples", d, asset));
      }
    }
  }

  writeFileSync(
    join(OUT, "meta.json"),
    JSON.stringify({ pages: ["index", ...docRows.map((r) => r.target.replace(/\.md$/, "")), "examples"] }, null, 2),
  );
  writeFileSync(
    join(OUT, "examples", "meta.json"),
    JSON.stringify({ title: "Examples", pages: ["index", ...exRows.map((r) => r.target.replace(/\/$/, ""))] }, null, 2),
  );

  if (problems.length) {
    console.error(`sync-content: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.error(`sync-content: ${docFiles.length + 1} docs + ${exDirs.length + 1} examples → content/docs`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
