"use client";

import { useState } from "react";
import styles from "./Quickstart.module.css";

function Cmd({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={styles.cmd}
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      aria-label={`Copy command: ${text}`}
    >
      <span className={styles.dollar}>$</span>
      <span>{copied ? "Copied" : text}</span>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={styles.copyIcon}>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M10.5 5.5V4A1.5 1.5 0 009 2.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </button>
  );
}

const STEPS = [
  {
    n: "1",
    title: "Install & wire your agent",
    note: "Auto-wires the agent for you — comma-separated: claude-code · cursor · codex · gemini-cli · vscode · windsurf · zed · antigravity. Using any other MCP client? Drop --agents — init still sets everything up and you point it at wigolo yourself. init does the full setup — downloads the browser engine + models and runs a health check so any problem surfaces here; add --no-warmup to defer downloads to first use.",
    cmd: "npx wigolo init --agents=<your-agent>",
    foot: "That's the whole setup — search, fetch, crawl, extract & cache need no API key. Beyond MCP: a REST API, TypeScript & Python SDKs, an agent-skills installer, and framework integrations (LangChain, CrewAI, LlamaIndex, Vercel AI SDK).",
  },
  {
    n: "2",
    title: "Check it's healthy",
    note: "Verifies the local engine — search, browser, on-device models.",
    cmd: "npx wigolo doctor",
    foot: "Node 20 / 22 / 24 LTS · macOS / Linux / Windows · no account or key for core tools.",
  },
  {
    n: "3",
    title: "Optional — answer synthesis",
    note: "research, agent, and answer-format search use an LLM. Easiest is a free Gemini key (no local setup). Set the provider plus its key — a provider alone isn't enough.",
    cmd: "export WIGOLO_LLM_PROVIDER=gemini GEMINI_API_KEY=<your-free-key>",
    foot: "Grab a free key at aistudio.google.com. Prefer fully local & keyless? Run Ollama: export WIGOLO_LLM_PROVIDER=ollama WIGOLO_LLM_MODEL=llama3.1",
  },
];

export default function Quickstart() {
  return (
    <section className={styles.section} id="quickstart">
      <div className="container">
        <div className={styles.head}>
          <h2 className={styles.title}>Working in under two minutes.</h2>
          <a
            href="https://github.com/KnockOutEZ/wigolo"
            className={styles.preview}
          >
            <span>
              Read the full CLI reference and docs on GitHub
            </span>
            <span className={styles.arrow}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M4 8h8M8 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </a>
        </div>

        <div className={styles.cols}>
          {STEPS.map((s) => (
            <div className={styles.col} key={s.n}>
              <span className={styles.stepNum}>{s.n}</span>
              <h3 className={styles.osName}>{s.title}</h3>
              <p className={styles.stepNote}>{s.note}</p>
              <Cmd text={s.cmd} />
              <p className={styles.stepFoot}>{s.foot}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
