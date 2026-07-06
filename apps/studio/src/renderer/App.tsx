import { useEffect, useState } from 'react';
import type { StudioState } from '../shared/ipc';
import type { StudioApi } from '../preload/index';
import { TabStrip } from './TabStrip';
import { Omnibox } from './Omnibox';
import { ApprovalCard } from './ApprovalCard';
import { createApprovalStore, type PendingApproval, type ApprovalVerdict } from './approval-store';

declare global {
  interface Window { studio: StudioApi }
}

const approvalStore = createApprovalStore();

export function App() {
  const [state, setState] = useState<StudioState>({ sessionName: '', tabs: [] });
  const [pending, setPending] = useState<PendingApproval[]>([]);

  useEffect(() => {
    window.studio.onState(setState);
    void window.studio.getState().then(setState);
    window.studio.onApprovalParked((a) => {
      approvalStore.add(a);
      setPending(approvalStore.pending());
    });
  }, []);

  const decide = (id: string, decision: ApprovalVerdict) => {
    if (approvalStore.decide(id, decision)) {
      setPending(approvalStore.pending());
      void window.studio.decideApproval(id, decision);
    }
  };

  const active = state.tabs.find((t) => t.active);
  const navigate = (url: string) => {
    if (active) void window.studio.navigate(active.id, url);
    else void window.studio.createTab(url);
  };

  return (
    <div style={{ font: '13px system-ui', userSelect: 'none' }}>
      <TabStrip
        tabs={state.tabs}
        onFocus={(id) => void window.studio.focusTab(id)}
        onClose={(id) => void window.studio.closeTab(id)}
        onNew={() => void window.studio.createTab('about:blank')}
      />
      <Omnibox currentUrl={active?.url ?? ''} onNavigate={navigate} />
      <ApprovalCard pending={pending} onDecide={decide} />
      {/* WebContentsView renders below y=88 — this chrome must never grow past it */}
    </div>
  );
}
