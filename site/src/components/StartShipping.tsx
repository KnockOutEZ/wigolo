import { asset } from "@/lib/site";
import styles from "./StartShipping.module.css";

export default function StartShipping() {
  return (
    <section className={styles.section}>
      <div className={`container ${styles.grid}`}>
        <div className={styles.media}>
          <img
            src={asset("/promo/ask-twice.svg")}
            alt="Ask twice, pay never: first query hits the live web in 3.6 seconds, the second answers from local cache in milliseconds, the third still answers offline"
          />
        </div>
        <div className={styles.text}>
          <h2 className={styles.title}>Give your agent the whole web.</h2>
          <p className={styles.body}>
            One command installs the local engine and wires it into your agent —
            search, fetch, crawl, extract, cache, and research, with no API key.
          </p>
          <div className={styles.ctas}>
            <a href="#quickstart" className="btn btn-primary">
              Install in two minutes
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 8h9M8 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
