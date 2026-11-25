import { asset, BASE_PATH } from "@/lib/site";
import { SPONSORS, logoHeight, logoWidth, sponsorGoPath } from "@/lib/sponsors";
import styles from "./Sponsors.module.css";

const LOGO_H = 24;

export default function Sponsors() {
  return (
    <section className={styles.section} id="sponsors">
      <div className={`container ${styles.inner}`}>
        <div className={styles.head}>
          <span className="eyebrow">Sponsors</span>
          <h2 className={styles.title}>
            Kept free by
            <br />
            its sponsors.
          </h2>
          <p className={styles.lede}>
            wigolo is free for everyone and stays that way. These companies help keep it
            maintained, and their support goes straight into the work.
          </p>
          <a className={styles.pitch} href={`${BASE_PATH}/sponsors/`} data-track="sponsor_pitch_click" data-track-location="home">
            Sponsor wigolo →
          </a>
        </div>

        <ul className={styles.list}>
          {SPONSORS.map((s) => {
            const href = asset(sponsorGoPath(s.slug, "site-home"));
            return (
              <li key={s.slug} className={styles.row}>
                <a className={styles.logoLink} href={href} rel="sponsored noopener" aria-label={s.name}>
                  <img
                    className={styles.logo}
                    src={asset(s.logo.light)}
                    alt={s.name}
                    width={logoWidth(s, LOGO_H)}
                    height={logoHeight(s, LOGO_H)}
                    loading="lazy"
                    decoding="async"
                  />
                </a>
                <p className={styles.blurb}>{s.description}</p>
                <a className={styles.visit} href={href} rel="sponsored noopener">
                  Visit →
                </a>
              </li>
            );
          })}
          <li className={`${styles.row} ${styles.open}`}>
            <span className={styles.openName}>Your company</span>
            <p className={styles.blurb}>
              On the README, this site and every release, with the reach of each placement
              measured and shared.
            </p>
            <a className={styles.visit} href={`${BASE_PATH}/sponsors/`} data-track="sponsor_pitch_click" data-track-location="home-row">
              Sponsor →
            </a>
          </li>
        </ul>
      </div>
    </section>
  );
}
