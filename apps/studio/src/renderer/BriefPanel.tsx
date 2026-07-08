import type { ResearchBriefDto, ProvenanceEntry } from 'wigolo/studio';

/** A provenance chip: which captured artifact a key finding came from (source tab url / title / time). */
function Chip({ p }: { p: ProvenanceEntry | undefined }) {
  if (!p) return null; // fail-open per-bullet: an out-of-range/absent source index just renders no chip
  const label = p.title || p.url || `#${p.artifactId}`;
  return (
    <a className="brief__chip" href={p.url ?? undefined} title={p.url ?? undefined} onClick={(e) => e.preventDefault()}>
      {label}
    </a>
  );
}

/**
 * The cross-tab synthesis brief (P6 F3). Renders the session's captured corpus shaped into topics + cited
 * key findings + gaps — each finding carrying a provenance chip back to the capture it came from. An honest
 * empty state when there is nothing to synthesize (never a fabricated brief).
 */
export function BriefPanel({ result }: { result: ResearchBriefDto | null }) {
  if (!result) return null;
  if ('empty' in result) {
    return (
      <p className="rail__empty">
        Nothing to synthesize yet — capture a few pages across your tabs, then synthesize the session into a
        single cited brief.
      </p>
    );
  }
  const { brief, provenance } = result;
  const findings = brief.key_findings ?? [];
  return (
    <div className="brief">
      {brief.topics.length > 0 && (
        <div className="brief__topics">
          {brief.topics.map((t, i) => <span key={i} className="brief__topic">{t}</span>)}
        </div>
      )}
      {findings.length > 0 && (
        <ul className="brief__findings">
          {findings.map((f, i) => {
            const srcIdx = brief.key_finding_sources?.[i];
            return (
              <li key={i} className="brief__finding">
                <span className="brief__text">{f}</span>
                <Chip p={srcIdx != null ? provenance[srcIdx] : undefined} />
              </li>
            );
          })}
        </ul>
      )}
      {brief.sections.gaps.length > 0 && (
        <div className="brief__gaps">
          <div className="brief__label">Coverage gaps</div>
          <ul>
            {brief.sections.gaps.map((g, i) => (
              <li key={i}>{typeof g === 'string' ? g : `${g.entity}: ${g.reason}`}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
