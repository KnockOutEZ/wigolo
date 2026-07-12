"use client";

import { useState } from "react";
import { asset } from "@/lib/site";
import styles from "./Hero.module.css";

function CopyField() {
  const [copied, setCopied] = useState(false);
  const cmd = "npx wigolo init --non-interactive";
  return (
    <button
      className={styles.copy}
      onClick={() => {
        navigator.clipboard?.writeText(cmd).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      <span className={styles.dollar}>$</span>
      <span className={styles.cmd}>{cmd}</span>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={styles.copyIcon}>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M10.5 5.5V4A1.5 1.5 0 009 2.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" stroke="currentColor" strokeWidth="1.3" />
      </svg>
      {copied && <span className={styles.copied}>Copied</span>}
    </button>
  );
}

export default function Hero() {
  return (
    <section className={styles.hero}>
      <div className={styles.inner}>
        <div className={styles.top}>
          <span className={styles.beta}>public beta · free · open source</span>
          <h1 className={styles.title}>
            The web, wired
            <br />
            into your local agent.
          </h1>
          <p className={styles.lede}>
            wigolo is a local-first MCP server that hands any coding agent the
            whole web — search, fetch, crawl, extract, cache, and research.
            Built to stand with the best tools in the lane. No API keys. No
            cloud. No metered bill.
          </p>
          <p className={styles.agents}>
            claude code · cursor · codex · gemini cli · vs code · windsurf ·
            zed · antigravity
          </p>
        </div>

        <div className={styles.ctas}>
          <a href="#quickstart" className="btn btn-primary">
            Get started
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 8h9M8 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
          <CopyField />
        </div>

        <HeroMockup />
      </div>
    </section>
  );
}

function HeroMockup() {
  return (
    <div className={styles.stage}>
      <div className={styles.window}>
        <div className={styles.titlebar}>
          <span className={styles.dots}>
            <i /> <i /> <i />
          </span>
          <span className={styles.winTitle}>your agent — wigolo mcp · no API keys</span>
        </div>
        <video
          className={styles.heroVideo}
          poster={asset("/wigolo/wigolo-demo-poster.png")}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-label="A coding agent answering a live web question through wigolo, with no API keys"
        >
          <source src={asset("/wigolo/wigolo-demo.webm")} type="video/webm" />
          <source src={asset("/wigolo/wigolo-demo.mp4")} type="video/mp4" />
        </video>
      </div>
    </div>
  );
}
