"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BASE_PATH } from "@/lib/site";
import type { DocMeta } from "@/lib/docs";
import styles from "./DocsSidebar.module.css";

/** Route for a nav slug (index → /docs). basePath is applied by next/link. */
function routeFor(slug: string): string {
  return slug === "index" ? "/docs" : `/docs/${slug}`;
}

export default function DocsSidebar({ nav }: { nav: DocMeta[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // usePathname includes the basePath at runtime; strip it before comparing.
  const path =
    BASE_PATH && pathname.startsWith(BASE_PATH)
      ? pathname.slice(BASE_PATH.length) || "/"
      : pathname;
  const normalized = path.replace(/\/$/, "") || "/";

  const isActive = (slug: string) => {
    const route = routeFor(slug);
    return normalized === route;
  };

  return (
    <nav className={styles.sidebar} aria-label="Documentation">
      <button
        className={styles.toggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="docs-nav-list"
      >
        <span>Documentation</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          className={open ? styles.caretOpen : styles.caret}
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <ul
        id="docs-nav-list"
        className={`${styles.list}${open ? " " + styles.listOpen : ""}`}
      >
        {nav.map((d) => (
          <li key={d.slug}>
            <Link
              href={routeFor(d.slug)}
              className={`${styles.item}${isActive(d.slug) ? " " + styles.active : ""}`}
              aria-current={isActive(d.slug) ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              {d.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
