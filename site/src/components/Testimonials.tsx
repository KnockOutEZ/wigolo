"use client";

import { useState } from "react";
import styles from "./Testimonials.module.css";

type Receipt = {
  tag: string;
  quote: string;
  detail: string;
};

// Real findings from wigolo's recorded comparison — one cold query, four web
// tools on equal footing, judged by the agent on the evidence alone.
const RECEIPTS: Receipt[] = [
  {
    tag: "Provenance",
    quote:
      "Verbatim quoted excerpts, pinned to character offsets in extracted Markdown with citation IDs.",
    detail: "wigolo · the only tool of four to return this",
  },
  {
    tag: "Explainable scoring",
    quote:
      "A score decomposition per result — semantic, lexical, and engine consensus, shown, not asserted.",
    detail: "wigolo · recorded comparison",
  },
  {
    tag: "Telemetry",
    quote: "Live per-engine telemetry, on-screen, for every single query.",
    detail: "wigolo · recorded comparison",
  },
  {
    tag: "Honesty by contract",
    quote:
      "Self-flagged junk — when two of its results were weak, its own scorer said so.",
    detail: "wigolo · recorded comparison",
  },
];

export default function Testimonials() {
  const [i, setI] = useState(0);
  const prev = () => setI((v) => (v - 1 + RECEIPTS.length) % RECEIPTS.length);
  const next = () => setI((v) => (v + 1) % RECEIPTS.length);
  const r = RECEIPTS[i];

  return (
    <section className={styles.section} id="parity">
      <div className={`container ${styles.inner}`}>
        <div className={styles.top}>
          <div className={styles.logos}>
            {RECEIPTS.map((item, idx) => (
              <button
                key={idx}
                className={`${styles.tagBtn}${i === idx ? " " + styles.tagActive : ""}`}
                onClick={() => setI(idx)}
              >
                {item.tag}
              </button>
            ))}
          </div>
          <div className={styles.arrows}>
            <button className={styles.arrow} onClick={prev} aria-label="Previous">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M11 3l-6 6 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button className={styles.arrow} onClick={next} aria-label="Next">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M7 3l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>

        <blockquote key={i} className={styles.quote}>
          &ldquo;{r.quote}&rdquo;
        </blockquote>

        <div className={styles.foot}>
          <p className={styles.attr}>
            <span className={styles.name}>All four tools converged on the same core answer.</span>
            <span className={styles.role}> {r.detail}</span>
          </p>
          <span className={styles.counter}>
            {i + 1} / {RECEIPTS.length}
          </span>
        </div>
      </div>
    </section>
  );
}
