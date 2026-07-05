import { asset, GH, BASE_PATH, FEEDBACK_LINKS } from "@/lib/site";
import styles from "./Footer.module.css";

const COLS: { title: string; links: { label: string; href: string; ext?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Tools", href: "#tools" },
      { label: "Parity", href: "#parity" },
      { label: "Quickstart", href: "#quickstart" },
      { label: "Feedback", href: "#feedback" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: GH, ext: true },
      { label: "npm", href: "https://www.npmjs.com/package/wigolo", ext: true },
      { label: "Changelog", href: `${GH}/releases`, ext: true },
      { label: "Contributing", href: `${GH}/blob/main/CONTRIBUTING.md`, ext: true },
      { label: "Report a bug", href: FEEDBACK_LINKS.bug, ext: true },
    ],
  },
  {
    title: "Support",
    links: [
      { label: "Star on GitHub", href: GH, ext: true },
      { label: "Buy me a coffee", href: "https://buymeacoffee.com/knockoutez", ext: true },
      { label: "Email the maintainer", href: "mailto:ktowhid20@gmail.com" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "License (AGPL-3.0)", href: `${GH}/blob/main/LICENSE`, ext: true },
      { label: "Trademark", href: `${GH}/blob/main/TRADEMARK.md`, ext: true },
      { label: "Security", href: `${GH}/blob/main/SECURITY.md`, ext: true },
    ],
  },
];

function ExtArrow() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ display: "inline", marginLeft: 5, verticalAlign: "middle", opacity: 0.5 }}>
      <path d="M3 9L9 3M4 3h5v5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.inner}`}>
        <div className={styles.cols}>
          {COLS.map((c) => (
            <div key={c.title} className={styles.col}>
              <h4 className={styles.colTitle}>{c.title}</h4>
              <ul className={styles.list}>
                {c.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      className={styles.link}
                      {...(l.ext ? { target: "_blank", rel: "noreferrer" } : {})}
                    >
                      {l.label}
                      {l.ext && <ExtArrow />}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className={styles.bottom}>
          <a href={`${BASE_PATH}/`} className={styles.brand} aria-label="wigolo home">
            <img src={asset("/wigolo/wigolo-icon.png")} alt="" width={26} height={26} />
            <span>wigolo</span>
          </a>
          <div className={styles.bottomRight}>
            <span className={styles.status}>
              <span className={styles.dot} /> All systems local
            </span>
            <span className={styles.copy}>
              public beta · AGPL-3.0 · built by @KnockOutEZ
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
