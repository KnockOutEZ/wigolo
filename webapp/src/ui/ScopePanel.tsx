import { useState } from 'preact/hooks';
import { up, encodeUp } from '../transport/codec.js';

/**
 * The pre-grant scope panel (S7) — SEPARATE from the approval card. The human authorizes-in-advance a class of
 * risky agent actions (a domain + action-type + risk-tier) so matching actions are authorized without a live
 * verdict; everything else parks for review. Submitting emits a {t:'grant'} up-message THROUGH THE CODEC (the
 * host stamps it human-authored and writes the scope store; no agent path can). Copy is capability language only.
 */
export interface ScopePanelProps {
  /** Send an encoded up-message to the host (the rail's one codec emit). */
  emit: (wire: string) => void;
}

const ACTIONS = ['click', 'type'] as const;
const TIERS = ['money', 'credential', 'destructive'] as const;

export function ScopePanel({ emit }: ScopePanelProps) {
  const [domain, setDomain] = useState('');
  const [actionType, setActionType] = useState<(typeof ACTIONS)[number]>('click');
  const [riskTier, setRiskTier] = useState<(typeof TIERS)[number]>('money');

  const submit = (e: Event) => {
    e.preventDefault();
    const d = domain.trim();
    if (!d) return;
    emit(encodeUp(up.grant([{ domain: d, actionType, riskTier }])));
    setDomain('');
  };

  return (
    <section class="studio-scope" aria-label="Pre-authorize actions">
      <h2>Pre-authorize actions</h2>
      <form class="studio-scope-form" onSubmit={submit}>
        <input
          class="studio-scope-domain"
          type="text"
          value={domain}
          onInput={(e) => setDomain((e.target as HTMLInputElement).value)}
          aria-label="Site domain"
          placeholder="site domain (e.g. shop.example)"
        />
        <select class="studio-scope-action" aria-label="Action type" value={actionType} onChange={(e) => setActionType((e.target as HTMLSelectElement).value as (typeof ACTIONS)[number])}>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select class="studio-scope-risk" aria-label="Risk tier" value={riskTier} onChange={(e) => setRiskTier((e.target as HTMLSelectElement).value as (typeof TIERS)[number])}>
          {TIERS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <button type="submit" class="studio-scope-add">Authorize</button>
      </form>
    </section>
  );
}
