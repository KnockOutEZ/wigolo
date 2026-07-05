import { GH } from "@/lib/site";
import styles from "./OpenSource.module.css";

const ACTIONS = [
  {
    glyph: "★",
    title: "Star it",
    body: "The single biggest thing you can do — stars are how open source gets found.",
    cta: "Star on GitHub",
    href: GH,
  },
  {
    glyph: "☕",
    title: "Sponsor it",
    body: "No paid tier, ever. If wigolo saves you a metered search bill, a coffee keeps it maintained.",
    cta: "Buy me a coffee",
    href: "https://buymeacoffee.com/knockoutez",
  },
  {
    glyph: "✉",
    title: "Talk to me",
    body: "Built by one developer — mail goes straight to the person who wrote the code.",
    cta: "ktowhid20@gmail.com",
    href: "mailto:ktowhid20@gmail.com",
  },
  {
    glyph: "⌥",
    title: "Contribute",
    body: "Good first issues are seeded, and the plugin system makes a new search engine a ~100-line PR.",
    cta: "Contributing guide",
    href: `${GH}/blob/main/CONTRIBUTING.md`,
  },
];

export default function OpenSource() {
  return (
    <section className={styles.section} id="support">
      <div className={`container ${styles.inner}`}>
        <div className={styles.content}>
          <span className={styles.eyebrow}>Open Source</span>
          <h2 className={styles.title}>
            Free, and meant to
            <br />
            stay that way
          </h2>
          <p className={styles.body}>
            wigolo is AGPL-3.0 — free to use, modify, and self-host, including
            inside a company. The license keeps it open: nobody can close it up
            and sell it back to you. Maintained, not paywalled.
          </p>
          <p className={styles.byline}>
            built and maintained by{" "}
            <a href="https://github.com/KnockOutEZ" target="_blank" rel="noreferrer">
              @KnockOutEZ
            </a>{" "}
            — one developer, going up against three funded teams.
          </p>
        </div>

        <div className={styles.cards}>
          {ACTIONS.map((a) => (
            <a
              key={a.title}
              className={styles.card}
              href={a.href}
              {...(a.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
            >
              <span className={styles.glyph}>{a.glyph}</span>
              <span className={styles.cardTitle}>{a.title}</span>
              <span className={styles.cardBody}>{a.body}</span>
              <span className={styles.cardCta}>{a.cta} →</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
