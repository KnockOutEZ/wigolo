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
  { label: "Verbatim excerpts pinned to byte-offset source spans", cells: [true, false, false, false] },
  { label: "Explainable per-result score decomposition", cells: [true, false, false, false] },
  { label: "Persistent local memory — instant, offline re-query", cells: [true, false, false, false] },
  { label: "Query data stays on your machine", cells: [true, false, false, false] },
  { label: "API key / account", cells: ["none", "required", "required", "required"] },
  { label: "Cost per query", cells: ["$0", "metered", "metered", "metered"] },
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
          <span className="eyebrow">Parity</span>
          <h2 className={styles.title}>
            Same fight.
            <br />
            Different physics.
          </h2>
          <p className={styles.lede}>
            The paid tools in this lane are genuinely good — that&apos;s what
            makes the parity interesting. What still separates wigolo isn&apos;t
            quality. It&apos;s where the work happens.
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
            Feature standing as of July 2026 — check each vendor&apos;s docs
            for current state. One cold query, four tools, judged on the
            evidence alone —{" "}
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
            alt="The meter: a metered cloud API's cost climbs with every query while wigolo stays flat at zero dollars — illustrative pricing"
            loading="lazy"
          />
        </Reveal>
      </div>
    </section>
  );
}
