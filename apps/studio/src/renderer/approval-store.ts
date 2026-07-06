// Renderer-side pending-approval state for the minimal placeholder approval card
// (P1). Risky agent acts are PARKED by the host (non-blocking) and surfaced here;
// a human Allow/Deny is the ONLY way a decision is produced — there is no timeout
// or auto-resolve path, so an approval is never silently allowed (spec §5/§10-P1).
// The rich approval-card UX is P4; this is the plain Allow/Deny placeholder.

export type ApprovalRisk = 'money' | 'credential' | 'destructive';
export type ApprovalVerdict = 'allow' | 'deny';

export interface PendingApproval {
  id: string;
  action: string;
  risk: ApprovalRisk;
}

export interface ApprovalDecisionEvent {
  id: string;
  decision: ApprovalVerdict;
}

export interface ApprovalStore {
  pending(): PendingApproval[];
  add(a: PendingApproval): void;
  /** Resolve an approval. Returns the decision to emit, or null for an unknown id. */
  decide(id: string, decision: ApprovalVerdict): ApprovalDecisionEvent | null;
  onDecision(cb: (d: ApprovalDecisionEvent) => void): void;
}

export function createApprovalStore(): ApprovalStore {
  const items = new Map<string, PendingApproval>();
  const subscribers = new Set<(d: ApprovalDecisionEvent) => void>();

  return {
    pending(): PendingApproval[] {
      return [...items.values()];
    },
    add(a: PendingApproval): void {
      if (!items.has(a.id)) items.set(a.id, a);
    },
    decide(id: string, decision: ApprovalVerdict): ApprovalDecisionEvent | null {
      if (!items.has(id)) return null;
      items.delete(id);
      const event: ApprovalDecisionEvent = { id, decision };
      for (const cb of subscribers) cb(event);
      return event;
    },
    onDecision(cb: (d: ApprovalDecisionEvent) => void): void {
      subscribers.add(cb);
    },
  };
}
