import type { PendingApproval, ApprovalVerdict } from './approval-store';

// The minimal placeholder approval card (P1). A risky agent action the host parked shows here with
// plain Allow/Deny — there is NO auto-resolve or timeout, so an action is never silently allowed
// (spec §10-P1). The rich card UX (context, provenance, one-click session grant) is P4.

const RISK_COPY: Record<PendingApproval['risk'], string> = {
  money: 'a money action',
  credential: 'a credential action',
  destructive: 'a destructive action',
};

export function ApprovalCard({
  pending,
  onDecide,
}: {
  pending: PendingApproval[];
  onDecide: (id: string, decision: ApprovalVerdict) => void;
}) {
  if (pending.length === 0) return null;
  return (
    <div style={{ borderTop: '1px solid #e2b400', background: '#fff8e1', padding: '8px 12px', font: '13px system-ui' }}>
      {pending.map((p) => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <span style={{ flex: 1 }}>
            The agent wants to run <strong>{p.action}</strong> — {RISK_COPY[p.risk]}. Approve?
          </span>
          <button onClick={() => onDecide(p.id, 'allow')}>Allow</button>
          <button onClick={() => onDecide(p.id, 'deny')}>Deny</button>
        </div>
      ))}
    </div>
  );
}
