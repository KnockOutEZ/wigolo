"use client";

import { useEffect, useRef, useState } from "react";
import { BASE_PATH } from "@/lib/site";
import styles from "./Tools.module.css";

type Feature = {
  id: string;
  tab: string;
  icon: React.ReactNode;
  heading: string;
  body: string;
  cta: string;
  href: string;
  visual: React.ReactNode;
};

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none">
      <circle cx="8.5" cy="8.5" r="5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12.5 12.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function FetchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none">
      <path d="M10 3v10m0 0l-4-4m4 4l4-4M4 16h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CacheIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none">
      <ellipse cx="10" cy="5" rx="6.5" ry="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 5v10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V5M3.5 10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
function ResearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor">
      <path d="M10 1l1.8 4.7L16.5 7l-4.7 1.8L10 13l-1.8-4.2L3.5 7l4.7-1.3L10 1z" />
      <circle cx="15.5" cy="14.5" r="2.2" />
    </svg>
  );
}

/* ---- panel visuals (wigolo's real evidence surfaces) ---- */
function EvidenceVisual() {
  return (
    <pre className={styles.code} aria-label="Evidence object with score breakdown and character-offset source span">
      <span className={styles.dim}>{"// every result explains itself"}</span>
      {"\n{"}
      {"\n  "}<span className={styles.key}>&quot;excerpt&quot;</span>: <span className={styles.str}>&quot;Logical replication replicates data…&quot;</span>,
      {"\n  "}<span className={styles.key}>&quot;score&quot;</span>: <span className={styles.num}>0.87</span>,
      {"\n  "}<span className={styles.key}>&quot;breakdown&quot;</span>: {"{"}
      {"\n    "}<span className={styles.key}>&quot;semantic&quot;</span>: <span className={styles.num}>0.91</span>,
      {"\n    "}<span className={styles.key}>&quot;lexical&quot;</span>: <span className={styles.num}>0.74</span>,
      {"\n    "}<span className={styles.key}>&quot;engine_consensus&quot;</span>: <span className={styles.str}>&quot;4/5 engines&quot;</span>
      {"\n  }"},
      {"\n  "}<span className={styles.key}>&quot;source_span&quot;</span>: {"{ "}<span className={styles.key}>&quot;start&quot;</span>: <span className={styles.num}>1284</span>, <span className={styles.key}>&quot;end&quot;</span>: <span className={styles.num}>1571</span>{" }"},
      {"\n  "}<span className={styles.key}>&quot;citation_id&quot;</span>: <span className={styles.ember}>&quot;f38b44c100e4&quot;</span>
      {"\n}"}
    </pre>
  );
}
function FetchVisual() {
  return (
    <div className={styles.ladder}>
      <div className={styles.rung}>
        <span className={styles.rungN}>1</span>
        <div>
          <b>Plain HTTP</b>
          <span>fast path — most pages end here</span>
        </div>
      </div>
      <p className={styles.down}>↓ anti-bot challenge detected</p>
      <div className={styles.rung}>
        <span className={styles.rungN}>2</span>
        <div>
          <b>TLS-impersonation</b>
          <span>learned fingerprints past bot walls</span>
        </div>
      </div>
      <p className={styles.down}>↓ SPA shell · thin content</p>
      <div className={styles.rung}>
        <span className={styles.rungN}>3</span>
        <div>
          <b>Headless browser</b>
          <span>full render from a warm in-process pool</span>
        </div>
      </div>
    </div>
  );
}
function CacheVisual() {
  return (
    <pre className={styles.code} aria-label="Cache query answering instantly">
      <span className={styles.dim}>agent →</span> <span className={styles.ember}>cache</span> <span className={styles.str}>&quot;postgres logical replication&quot;</span>
      {"\n"}<span className={styles.dim}>wigolo →</span> 3 hits · hybrid keyword + semantic
      {"\n   "}<span className={styles.key}>postgresql.org</span>/docs/current/logical-replication
      {"\n   "}<span className={styles.key}>postgresql.org</span>/docs/current/warm-standby
      {"\n   "}<span className={styles.key}>wiki.postgresql.org</span>/wiki/Streaming_Replication
      {"\n"}<span className={styles.dim}>latency →</span> <span className={styles.num}>3ms</span> · <span className={styles.num}>$0</span> · nothing left your machine
    </pre>
  );
}
function ResearchVisual() {
  return (
    <pre className={styles.code} aria-label="Research decomposition and cited brief">
      <span className={styles.dim}>question →</span> <span className={styles.str}>&quot;how does postgres logical replication work?&quot;</span>
      {"\n"}<span className={styles.dim}>decompose →</span> 4 sub-queries · fanned out in parallel
      {"\n   "}<span className={styles.ember}>▸</span> publication / subscription model
      {"\n   "}<span className={styles.ember}>▸</span> conflict handling &amp; limitations
      {"\n   "}<span className={styles.ember}>▸</span> vs. physical / streaming replication
      {"\n"}<span className={styles.dim}>synthesize →</span> cited brief · <span className={styles.num}>7</span> sources · <span className={styles.num}>12</span> citations
      {"\n"}<span className={styles.dim}>gaps →</span> surfaced, not hidden
    </pre>
  );
}

const GH = "https://github.com/KnockOutEZ/wigolo";

const FEATURES: Feature[] = [
  {
    id: "search",
    tab: "Search & Evidence",
    icon: <SearchIcon />,
    heading: "Evidence, not blue links",
    body: "One MCP call fans a query array across many engines in parallel. Every result can include an inspectable score breakdown, character offsets into extracted Markdown, and citation IDs — output your agent can quote.",
    cta: "See the receipts",
    href: "#parity",
    visual: <EvidenceVisual />,
  },
  {
    id: "fetch",
    tab: "Smart Fetch",
    icon: <FetchIcon />,
    heading: "Routing on observable signals",
    body: "The keyless fetch ladder escalates to a real browser on what it sees — SPA markers, challenge bodies, thin content — not domain guesses. It clears most challenge sites with no keys; the strictest managed-challenge and IP-reputation walls need an opt-in proxy, solver, or reader. It learns per-domain, and unlearns when a site stops needing it.",
    cta: "How it works",
    href: `${GH}#architecture`,
    visual: <FetchVisual />,
  },
  {
    id: "cache",
    tab: "Local Cache",
    icon: <CacheIcon />,
    heading: "Successfully cached, locally reusable",
    body: "Successfully fetched content lands in a local store under ~/.wigolo/ — full text, keyword index, and on-device vectors. Asking again avoids another network round trip and Wigolo usage fee; find_similar and change detection build on it.",
    cta: "Get started",
    href: "#quickstart",
    visual: <CacheVisual />,
  },
  {
    id: "research",
    tab: "Research & Agent",
    icon: <ResearchIcon />,
    heading: "Research that writes itself",
    body: "research decomposes a question, fans out sub-queries, fetches sources, and hands back a cited brief. agent runs an autonomous plan → search → fetch → extract → synthesize loop with a step log and time budget.",
    cta: "All 10 tools",
    href: `${GH}#the-tools`,
    visual: <ResearchVisual />,
  },
];

export default function Tools() {
  const [active, setActive] = useState(0);
  const blockRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const idx = Number((e.target as HTMLElement).dataset.idx);
            setActive(idx);
          }
        }
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 }
    );
    blockRefs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  const goTo = (i: number) => {
    blockRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <section className={styles.section} id="tools">
      <span id="how" />
      <div className={`container ${styles.head}`}>
        <span className="eyebrow">The tools</span>
        <h2 className={styles.title}>
          Your agent is smart. Its web access isn&apos;t.
        </h2>
        <a href={`${BASE_PATH}/docs/tools`} className={styles.headLink}>
          Full tool reference
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M3 8h9M8 3l5 5-5 5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </div>

      <div className={`container ${styles.grid}`}>
        <div className={styles.tabsWrap}>
          <nav className={styles.tabs}>
            {FEATURES.map((f, i) => (
              <button
                key={f.id}
                className={`${styles.tab}${active === i ? " " + styles.tabActive : ""}`}
                onClick={() => goTo(i)}
              >
                <span className={`${styles.tabIcon} ${styles.tabIconTile}`}>
                  {f.icon}
                </span>
                <span className={styles.tabLabel}>{f.tab}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className={styles.blocks}>
          {FEATURES.map((f, i) => (
            <div
              key={f.id}
              data-idx={i}
              ref={(el) => {
                blockRefs.current[i] = el;
              }}
              className={styles.block}
            >
              <div className={styles.panel}>{f.visual}</div>
              <div className={styles.blockText}>
                <div className={styles.blockHeadRow}>
                  <h3 className={styles.blockHeading}>{f.heading}</h3>
                  <a
                    href={f.href}
                    className="btn btn-primary"
                    {...(f.href.startsWith("http")
                      ? { target: "_blank", rel: "noreferrer" }
                      : {})}
                  >
                    {f.cta}
                  </a>
                </div>
                <p className={styles.blockBody}>{f.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
