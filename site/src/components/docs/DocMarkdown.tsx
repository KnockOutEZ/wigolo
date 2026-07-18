import Link from "next/link";
import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeHighlight from "rehype-highlight";
import { rewriteHref } from "@/lib/docs";
import styles from "./DocMarkdown.module.css";

/**
 * Build-time markdown renderer. Runs inside a Server Component during
 * `next build`, so the highlighted HTML is baked into the static export and
 * reading a docs page requires no client JS.
 *
 * - remark-gfm: tables, strikethrough, task lists, autolinks.
 * - rehype-slug: github-slugger heading ids (matches the docs' own #anchors).
 * - rehype-highlight: highlight.js at build time (theme via DocMarkdown.module.css).
 * - custom `a`: inter-doc/repo links rewritten to site routes or GitHub URLs;
 *   internal /docs links use next/link so the GH Pages basePath is applied.
 */
function Anchor({ href = "", children, ...rest }: ComponentProps<"a">) {
  const { href: target, internal } = rewriteHref(href);

  if (internal) {
    return (
      <Link href={target} className={styles.link}>
        {children}
      </Link>
    );
  }

  const external = /^https?:\/\//i.test(target);
  return (
    <a
      href={target}
      className={styles.link}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      {...rest}
    >
      {children}
    </a>
  );
}

export default function DocMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className={styles.prose}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeSlug,
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
        components={{
          a: Anchor,
          // Wrap tables so wide content scrolls inside its own box rather than
          // pushing the page into horizontal scroll on mobile.
          table: ({ children, ...props }) => (
            <div className={styles.tableWrap}>
              <table {...props}>{children}</table>
            </div>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
