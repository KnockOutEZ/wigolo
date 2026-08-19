import type { Sponsor } from "@/lib/sponsors";
import styles from "./SponsorRedirect.module.css";

/**
 * The visible half of the forwarding hop, with no behaviour of its own.
 *
 * Rendered both as the Suspense fallback (so the exported HTML always carries a
 * working link for a visitor without JS, where the redirect never runs) and by
 * the client component once the placement is known.
 */
export default function SponsorCard({
  sponsor,
  target,
}: {
  sponsor: Sponsor;
  target: string;
}) {
  return (
    <main className={styles.wrap}>
      <div className={styles.card}>
        <p className={styles.eyebrow}>wigolo sponsor</p>
        <h1 className={styles.title}>Taking you to {sponsor.name}</h1>
        <p className={styles.body}>{sponsor.description}</p>
        <a className={styles.link} href={target} rel="noopener sponsored">
          Continue to {sponsor.name} →
        </a>
        <p className={styles.note}>
          You&rsquo;re being forwarded from a wigolo sponsor link. We count the
          click so we can tell our sponsors what their support reached — no
          cookies, no tracking script, nothing stored about you.
        </p>
      </div>
    </main>
  );
}
