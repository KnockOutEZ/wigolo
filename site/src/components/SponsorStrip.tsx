import { asset } from "@/lib/site";
import { SPONSORS, logoHeight, logoWidth, sponsorGoPath, type Placement } from "@/lib/sponsors";
import styles from "./SponsorStrip.module.css";

/**
 * A one-line "sponsored by" logo row. Every link goes through the counted
 * /go/ hop, tagged with where it was rendered, so each surface's clicks are
 * reported to the sponsor separately.
 */
export default function SponsorStrip({
  placement,
  variant = "home",
}: {
  placement: Placement;
  variant?: "home" | "compact";
}) {
  if (SPONSORS.length === 0) return null;
  return (
    <div className={`${styles.strip} ${styles[variant]}`}>
      <span className={styles.label}>Sponsored by</span>
      {SPONSORS.map((s) => (
        <a
          key={s.slug}
          className={styles.link}
          href={asset(sponsorGoPath(s.slug, placement))}
          rel="sponsored noopener"
          aria-label={s.name}
        >
          <img
            className={styles.logo}
            src={asset(s.logo.light)}
            alt={s.name}
            width={logoWidth(s, variant === "compact" ? 18 : 22)}
            height={logoHeight(s, variant === "compact" ? 18 : 22)}
            style={{ height: logoHeight(s, variant === "compact" ? 18 : 22) }}
            loading="lazy"
            decoding="async"
          />
        </a>
      ))}
    </div>
  );
}
