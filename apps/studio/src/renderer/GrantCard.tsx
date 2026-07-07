/**
 * The localhost grant card (spec §7 / §13.8c) — the human's one-click "allow the agent onto localhost this
 * session" affordance that unblocks the DOM-to-code flow. Scoped to the session, revocable anytime;
 * cloud-internal / metadata addresses stay blocked no matter what. Capability language only.
 */
export function GrantCard({ granted, onGrant, onRevoke }: { granted: boolean; onGrant: () => void; onRevoke: () => void }) {
  return (
    <div className={`grant-card${granted ? ' grant-card--on' : ''}`}>
      <div className="grant-card__title">Agent access to localhost</div>
      {granted ? (
        <>
          <div className="grant-card__body">
            The agent can open <b>localhost</b> and private-network pages in this session. Cloud-internal
            addresses stay blocked.
          </div>
          <button className="grant-card__btn grant-card__btn--revoke" onClick={onRevoke}>Revoke access</button>
        </>
      ) : (
        <>
          <div className="grant-card__body">
            Allow the agent to open <b>localhost</b> / private-network pages — <b>this session only</b>,
            revoke anytime. Cloud-internal stays blocked.
          </div>
          <button className="grant-card__btn" onClick={onGrant}>Allow on localhost</button>
        </>
      )}
    </div>
  );
}
