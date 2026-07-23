import Reveal from "./Reveal";
import { asset } from "@/lib/site";
import styles from "./Parity.module.css";

type Cell = boolean | string;
type Row = { label: string; cells: [Cell, Cell, Cell, Cell] };

const TOOLS = ["wigolo", "firecrawl", "exa", "tavily"];

const FIGHT: Row[] = [
  { label: "Multi-engine web search", cells: [true, true, true, true] },
  { label: "Fetch & structured extraction", cells: [true, true, true, true] },
  { label: "Whole-site crawl & map", cells: [true, true, false, true] },
];

const PHYSICS: Row[] = [
  { label: "Verbatim excerpts with character offsets in extracted Markdown", cells: [true, false, false, false] },
  { label: "Explainable per-result score decomposition", cells: [true, false, false, false] },
  { label: "Persistent local memory — instant, offline re-query", cells: [true, false, false, false] },
  { label: "Default/core access", cells: ["keyless", "key for full API", "free tier / x402", "keyless Search / Extract"] },
  { label: "Paid usage", cells: ["no Wigolo fee", "after allowance", "after allowance", "after allowance"] },
];

function Mark({ v }: { v: Cell }) {
  if (typeof v === "string") {
    return <span className={styles.word}>{v}</span>;
  }
  return v ? (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-label="yes">
      <path d="M2.5 7.5L5.5 10.5L11.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <span className={styles.dash} aria-label="no">—</span>
  );
}

function Rows({ rows }: { rows: Row[] }) {
  return (
    <>
      {rows.map((r) => (
        <tr key={r.label}>
          <th scope="row" className={styles.rowLabel}>{r.label}</th>
          {r.cells.map((c, i) => (
            <td key={i} className={`${styles.cell}${i === 0 ? " " + styles.us : ""}`}>
              <Mark v={c} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export default function Parity() {
  return (
    <section className={styles.section}>
      <div className={`container ${styles.inner}`}>
        <Reveal className={styles.head}>
          <span className="eyebrow">Feature snapshot</span>
          <h2 className={styles.title}>
            Same category.
            <br />
            Different architecture.
          </h2>
          <p className={styles.lede}>
            One recorded query showed all four tools converging on the same core
            answer. That is a useful demonstration, not a general quality
            benchmark. Wigolo&apos;s durable distinction is where its state and
            ranking work live.
          </p>
        </Reveal>

        <Reveal className={styles.tableWrap} delay={120}>
          <table className={styles.table}>
            <thead>
              <tr>
                <td className={styles.corner} />
                {TOOLS.map((t, i) => (
                  <th key={t} scope="col" className={`${styles.tool}${i === 0 ? " " + styles.usHead : ""}`}>
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="rowgroup" colSpan={5} className={styles.group}>the fight — everyone shows up</th>
              </tr>
              <Rows rows={FIGHT} />
              <tr>
                <th scope="rowgroup" colSpan={5} className={styles.group}>the physics — where the work happens</th>
              </tr>
              <Rows rows={PHYSICS} />
            </tbody>
          </table>
          <p className={styles.foot}>
            Feature standing as of July 2026. Access modes and allowances
            change; check each vendor&apos;s current docs. One cold query, four
            tools, judged on the evidence alone —{" "}
            <a
              href="https://github.com/KnockOutEZ/wigolo#benchmark"
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "underline" }}
            >
              watch the full run
            </a>
            .
          </p>
          <img
            className={styles.meter}
            src={asset("/promo/meter.svg")}
            alt="Illustrative comparison: a metered cloud API's cost rises with usage while Wigolo itself charges no API usage fee"
            loading="lazy"
          />
        </Reveal>
      </div>
    </section>
  );
}
