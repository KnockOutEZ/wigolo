import { asset } from "@/lib/site";
import { SPONSORS, sponsorGoPath } from "@/lib/sponsors";
import styles from "./Sponsors.module.css";

export default function Sponsors() {
  return (
    <section className={styles.section} id="sponsors">
      <div className={`container ${styles.inner}`}>
        <span className={styles.eyebrow}>Sponsors</span>
        <h2 className={styles.title}>Thank you</h2>
        <p className={styles.body}>
          wigolo is free for everyone, and it stays that way because people
          choose to support it rather than because anyone has to pay for it.
          These sponsors backed the project with nothing asked in return — no
          say over the roadmap, no feature they get and you don&rsquo;t. That
          generosity is why the tools are keyless and the cache is yours.
        </p>

        <ul className={styles.list}>
          {SPONSORS.map((s) => (
            <li key={s.slug} className={styles.card}>
              <a
                className={styles.logoLink}
                href={asset(sponsorGoPath(s.slug, "site-home"))}
                rel="sponsored noopener"
                aria-label={s.name}
              >
                <img
                  className={styles.logo}
                  src={asset(s.logo.light)}
                  alt={s.name}
                  width={513}
                  height={80}
                />
              </a>
              <p className={styles.blurb}>{s.description}</p>
              <a
                className={styles.cta}
                href={asset(sponsorGoPath(s.slug, "site-home"))}
                rel="sponsored noopener"
              >
                Visit {s.name} →
              </a>
            </li>
          ))}
        </ul>

        <p className={styles.pitch}>
          <strong>Want to support wigolo?</strong>{" "}
          Sponsorship keeps a free-forever project maintained, and there&rsquo;s room for more
          companies and individuals alongside the sponsors above. If that
          sounds like you, write to{" "}
          <a href="mailto:ktowhid20@gmail.com">ktowhid20@gmail.com</a> — it goes
          straight to the developer who wrote the code.
        </p>
      </div>
    </section>
  );
}
