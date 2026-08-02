import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import DocsSidebar from "./DocsSidebar";
import DocMarkdown from "./DocMarkdown";
import {
  DOCS_NAV,
  editUrlForSlug,
  getDocNeighbours,
  type Doc,
} from "@/lib/docs";
import styles from "./DocShell.module.css";

function route(slug: string): string {
  return slug === "index" ? "/docs" : `/docs/${slug}`;
}

export default function DocShell({ doc }: { doc: Doc }) {
  const { prev, next } = getDocNeighbours(doc.slug);
  const editUrl = editUrlForSlug(doc.slug);

  return (
    <>
      <Nav />
      <main className={styles.wrap}>
        <div className={`container ${styles.grid}`}>
          <DocsSidebar nav={DOCS_NAV} />

          <div className={styles.content}>
            <article>
              <DocMarkdown markdown={doc.markdown} />
            </article>

            <a
              href={editUrl}
              className={styles.edit}
              target="_blank"
              rel="noreferrer"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M11.5 2.5l2 2L6 12l-2.5.5L4 10l7.5-7.5z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Edit this page on GitHub
            </a>

            <nav className={styles.pager} aria-label="Pagination">
              {prev ? (
                <Link href={route(prev.slug)} className={styles.pagerPrev}>
                  <span className={styles.pagerDir}>← Previous</span>
                  <span className={styles.pagerTitle}>{prev.title}</span>
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link href={route(next.slug)} className={styles.pagerNext}>
                  <span className={styles.pagerDir}>Next →</span>
                  <span className={styles.pagerTitle}>{next.title}</span>
                </Link>
              ) : (
                <span />
              )}
            </nav>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
