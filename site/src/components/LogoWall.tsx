import type { CSSProperties } from "react";
import { asset } from "@/lib/site";
import { buildWall, starCount, type WallItem } from "@/lib/logo-wall";
import styles from "./LogoWall.module.css";

function Logo({ item }: { item: WallItem }) {
  const { mark, display, name } = item;
  const showName = display !== "wordmark";
  return (
    <span className={`${styles.logo} ${display === "wordmark" ? styles.wordmark : ""}`}>
      {mark.kind === "svg" && (
        <svg
          className={styles.mark}
          viewBox={mark.frame}
          style={{ "--aspect": mark.aspect } as CSSProperties}
          aria-hidden="true"
          focusable="false"
        >
          <use href={`${asset("/logo-wall.svg")}#${mark.symbolId}`} />
        </svg>
      )}
      {mark.kind === "mask" && (
        <span
          className={`${styles.mark} ${styles.mask}`}
          style={
            {
              "--aspect": mark.aspect,
              "--src": `url(${asset(mark.src)})`,
            } as CSSProperties
          }
          aria-hidden="true"
        />
      )}
      {showName && <span className={styles.name}>{name}</span>}
    </span>
  );
}

function Track({ items, reverse }: { items: WallItem[]; reverse?: boolean }) {
  // Three copies, scrolled by one copy's width, loop seamlessly at any
  // viewport width (same technique as the agent-chip marquee).
  return (
    <div className={`${styles.viewport} ${reverse ? styles.bottomRow : styles.topRow}`}>
      <div className={`${styles.track} ${reverse ? styles.reverse : ""}`}>
        {[0, 1, 2].map((copy) => (
          <div key={copy} className={styles.row} aria-hidden="true" data-copy={copy}>
            {items.map((item) => (
              <Logo key={item.slug} item={item} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function LogoWall() {
  const wall = buildWall();
  const stars = await starCount();
  return (
    <section className={styles.section} aria-labelledby="logo-wall-caption">
      <p className={styles.caption} id="logo-wall-caption">
        Starred by <strong>{stars.toLocaleString("en-US")}+</strong> developers, including
        engineers at
      </p>

      <ul className={styles.srOnly}>
        {[...wall.top, ...wall.bottom].map((i) => (
          <li key={i.slug}>{i.name}</li>
        ))}
      </ul>

      <Track items={wall.top} />
      <Track items={wall.bottom} reverse />

      <p className={styles.note}>
        From public GitHub profiles of people who starred or forked wigolo. Logos are trademarks of
        their owners; a listing is not an endorsement.{" "}
        <a
          className={styles.noteLink}
          href="https://github.com/KnockOutEZ/wigolo/issues/new?template=adopter.yml"
          target="_blank"
          rel="noreferrer"
          data-track="adopter_click"
          data-track-location="logo-wall"
        >
          Using wigolo at work? Get listed →
        </a>
      </p>
    </section>
  );
}
