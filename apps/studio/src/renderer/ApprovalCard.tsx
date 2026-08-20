import type { PendingApproval, ApprovalVerdict } from './approval-store';

// The approval card. A risky agent action the host parked shows here with plain Allow/Deny — there is
// NO auto-resolve or timeout, so an action is never silently allowed.
//
// Per-risk accent, two families only: money and destructive want a person, so they read attention; a
// credential prompt is agent-caused state and reads agent. The old third colour said nothing the label
// did not already say. No glyph: the label names the risk, and the design system allows no emoji.

const RISK: Record<PendingApproval['risk'], { label: string; copy: string }> = {
  money: { label: 'Money action', copy: 'could spend money or place an order' },
  credential: { label: 'Credential action', copy: 'touches a login or credential field' },
  destructive: { label: 'Destructive action', copy: 'could delete or irreversibly change something' },
};

export function ApprovalCards({
  pending,
  onDecide,
}: {
  pending: PendingApproval[];
  onDecide: (id: string, decision: ApprovalVerdict) => void;
}) {
  return (
    <>
      {pending.map((p) => {
        const r = RISK[p.risk];
        return (
          <div className={`approval approval--${p.risk}`} key={p.id}>
            <div className="approval__label"><span className="approval__dot" /> {r.label} · needs your approval</div>
            <div className="approval__body">
              The agent wants to run <b>{p.action}</b> — this {r.copy}. It won&rsquo;t run until you allow it.
            </div>
            <div className="approval__actions">
              <button className="btn btn--allow" onClick={() => onDecide(p.id, 'allow')}>Allow</button>
              <button className="btn btn--deny" onClick={() => onDecide(p.id, 'deny')}>Deny</button>
            </div>
          </div>
        );
      })}
    </>
  );
}
