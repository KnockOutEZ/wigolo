import styles from "./TrustedBy.module.css";

const AGENTS = [
  "claude code",
  "cursor",
  "codex",
  "gemini cli",
  "opencode",
  "vs code",
  "windsurf",
  "zed",
  "antigravity",
];

function Row() {
  return (
    <div className={styles.row} aria-hidden="true">
      {AGENTS.map((a, i) => (
        <span key={i} className={styles.chip}>
          {a}
        </span>
      ))}
    </div>
  );
}

export default function TrustedBy() {
  return (
    <section className={styles.section}>
      <p className={styles.label}>one command wires it into</p>
      <div className={styles.track}>
        <Row />
        <Row />
        <Row />
      </div>
      <p className={styles.caption}>+ any other agent, through MCP</p>
    </section>
  );
}
