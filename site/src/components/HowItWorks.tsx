import Reveal from "./Reveal";
import styles from "./HowItWorks.module.css";

function FetchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 3v10m0 0l-4-4m4 4l4-4M4 16h12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12.5 12.5L17 17"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
function CacheIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <ellipse cx="10" cy="5" rx="6.5" ry="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M3.5 5v10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V5M3.5 10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
function Arrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 12h15m0 0l-5-5m5 5l-5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function HowItWorks() {
  return (
    <section className={styles.section} id="how-it-works">
      <div className={`container ${styles.inner}`}>
        <Reveal className={styles.head} as="div">
          <span className="eyebrow">How it works</span>
          <h2 className={styles.title}>
            Everything heavy runs on your machine
          </h2>
          <p className={styles.body}>
            No metering, no round-trips you didn&apos;t ask for. Your agent
            reaches the open web through one local process — and the work that
            costs money elsewhere happens right here instead.
          </p>
        </Reveal>

        <Reveal className={styles.flow} as="div" delay={80}>
          <div className={styles.node}>
            <span className={styles.nodeLabel}>you run</span>
            <span className={styles.nodeName}>your agent</span>
          </div>
          <div className={styles.arrow}>
            <Arrow />
          </div>
          <div className={`${styles.node} ${styles.nodeMid}`}>
            <span className={styles.nodeLabel}>local process</span>
            <span className={styles.nodeName}>wigolo</span>
          </div>
          <div className={styles.arrow}>
            <Arrow />
          </div>
          <div className={styles.node}>
            <span className={styles.nodeLabel}>reaches</span>
            <span className={styles.nodeName}>the web</span>
          </div>
          <p className={styles.over}>
            Spoken over <b>MCP</b> — and the same tools answer over a{" "}
            <b>REST API</b> and <b>language SDKs</b>, so anything that talks HTTP
            can drive it.
          </p>
        </Reveal>

        <div className={styles.pillars}>
          <Reveal className={styles.pillar} as="div" delay={0}>
            <div className={styles.pillarHead}>
              <span className={styles.pillarIcon}>
                <FetchIcon />
              </span>
              <span className={styles.pillarName}>fetch</span>
            </div>
            <p className={styles.pillarBody}>
              A <b>tiered router</b> that starts at plain HTTP and only escalates
              on what it actually sees — anti-bot challenges, empty SPA shells —
              never on a guess about the domain.
            </p>
            <div className={styles.steps}>
              <div className={styles.step}>
                <span className={styles.stepN}>1</span>
                <span>plain HTTP — where most pages resolve</span>
              </div>
              <div className={styles.step}>
                <span className={styles.stepN}>2</span>
                <span>TLS-impersonation — past bot walls</span>
              </div>
              <div className={styles.step}>
                <span className={styles.stepN}>3</span>
                <span>a headless browser engine — full render</span>
              </div>
            </div>
          </Reveal>

          <Reveal className={styles.pillar} as="div" delay={90}>
            <div className={styles.pillarHead}>
              <span className={styles.pillarIcon}>
                <SearchIcon />
              </span>
              <span className={styles.pillarName}>search</span>
            </div>
            <p className={styles.pillarBody}>
              <b>18 search-engine adapters</b> fan out in parallel, then rank
              fusion and an on-device <b>ML reranker</b> settle the order — with
              an explainable score behind every single result.
            </p>
            <div className={styles.steps}>
              <div className={styles.step}>
                <span className={styles.stepN}>▸</span>
                <span>fan out — 18 engines, one query array</span>
              </div>
              <div className={styles.step}>
                <span className={styles.stepN}>▸</span>
                <span>rank fusion — merge, dedup, reconcile</span>
              </div>
              <div className={styles.step}>
                <span className={styles.stepN}>▸</span>
                <span>on-device rerank — scored, explained</span>
              </div>
            </div>
          </Reveal>

          <Reveal className={styles.pillar} as="div" delay={180}>
            <div className={styles.pillarHead}>
              <span className={styles.pillarIcon}>
                <CacheIcon />
              </span>
              <span className={styles.pillarName}>cache</span>
            </div>
            <p className={styles.pillarBody}>
              Everything fetched lands in a <b>local index</b> — keyword search
              paired with on-device vectors. Re-asking is <b>instant and free</b>
              , and it still answers when you&apos;re offline.
            </p>
            <div className={styles.steps}>
              <div className={styles.step}>
                <span className={styles.stepN}>▸</span>
                <span>keyword + on-device vectors, side by side</span>
              </div>
              <div className={styles.step}>
                <span className={styles.stepN}>▸</span>
                <span>a repeat ask returns in milliseconds</span>
              </div>
              <div className={styles.step}>
                <span className={styles.stepN}>▸</span>
                <span>works with no network at all</span>
              </div>
            </div>
          </Reveal>
        </div>

        <Reveal className={styles.closer} as="div" delay={80}>
          Models and cache live under <code>~/.wigolo</code> on your machine —
          no keys, nothing metered, and nothing leaves unless you opt into an
          LLM.
        </Reveal>
      </div>
    </section>
  );
}
