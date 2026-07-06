import { useEffect, useState } from 'react';
import './studio.css';
import type { StudioState } from '../shared/ipc';
import type { StudioApi } from '../preload/index';
import type { StudioGeneralizeOutput } from 'wigolo/studio';
import { TabStrip } from './TabStrip';
import { Toolbar } from './Omnibox';
import { ApprovalCards } from './ApprovalCard';
import { MarksPanel } from './MarksPanel';
import { IconSpark, IconSend } from './icons';
import { createApprovalStore, type PendingApproval, type ApprovalVerdict } from './approval-store';
import { createMarksStore, type Mark } from './marks-store';

declare global {
  interface Window { studio: StudioApi }
}

const approvalStore = createApprovalStore();
const marksStore = createMarksStore();
type RailTab = 'agent' | 'marks';

export function App() {
  const [state, setState] = useState<StudioState>({ sessionName: '', tabs: [] });
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [preview, setPreview] = useState<StudioGeneralizeOutput | null>(null);
  const [railTab, setRailTab] = useState<RailTab>('agent');
  const [railOpen, setRailOpen] = useState(true);

  useEffect(() => {
    window.studio.onState(setState);
    void window.studio.getState().then(setState);
    window.studio.onApprovalParked((a) => {
      approvalStore.add(a);
      setPending(approvalStore.pending());
    });
    marksStore.subscribe(() => setMarks(marksStore.list()));
    window.studio.onMarksChanged((dtos) => { marksStore.set(dtos); });
    window.studio.onGeneralizePreview((p) => setPreview(p));
  }, []);

  const comment = (markId: string, text: string) => {
    marksStore.appendComment(markId, text); // optimistic local render
    setMarks(marksStore.list());
    void window.studio.addComment(markId, text); // host stores it for the agent's observe drain
  };
  const generalize = (markId: string) => {
    void window.studio.generalize(markId).then((r) => { if ('refs' in r) setPreview(r); });
  };

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
  const toggleRail = () => {
    setRailOpen((open) => {
      const next = !open;
      void window.studio.setRailOpen?.(next); // reflow the WebContentsView to reclaim/yield the rail column
      return next;
    });
  };

  return (
    <div className="studio">
      <TabStrip
        tabs={state.tabs}
        onFocus={(id) => void window.studio.focusTab(id)}
        onClose={(id) => void window.studio.closeTab(id)}
        onNew={() => void window.studio.createTab('about:blank')}
      />
      <Toolbar
        currentUrl={active?.url ?? ''}
        onNavigate={navigate}
        onBack={() => { /* history nav wired in a later phase */ }}
        onForward={() => { /* history nav wired in a later phase */ }}
        onReload={() => { if (active) void window.studio.navigate(active.id, active.url); }}
        railOpen={railOpen}
        onToggleRail={toggleRail}
      />
      <div className="studio__body">
        {/* the real Chromium WebContentsView is composited by the OS over this region */}
        <div className="studio__stage" />
        {railOpen && (
          <aside className="rail">
            <div className="rail__head">
              <span style={{ color: 'var(--agent)', display: 'grid', placeItems: 'center' }}><IconSpark size={16} /></span>
              <span className="rail__tabs">
                <button className={`rail__tab ${railTab === 'agent' ? 'is-active' : ''}`} onClick={() => setRailTab('agent')}>Agent</button>
                <button className={`rail__tab ${railTab === 'marks' ? 'is-active' : ''}`} onClick={() => setRailTab('marks')}>
                  Marks{marks.length ? ` · ${marks.length}` : ''}
                </button>
              </span>
              <span className="rail__badge">{state.sessionName || 'session'}</span>
              <span className="rail__spacer" />
            </div>
            {railTab === 'agent' ? (
              <>
                <div className="rail__body">
                  <ApprovalCards pending={pending} onDecide={decide} />
                  {pending.length === 0 && (
                    <p className="rail__empty">
                      The agent co-drives this browser. Approvals for <b>money</b>, <b>credential</b>, and
                      <b> destructive</b> actions surface here — nothing risky runs without your say-so.
                    </p>
                  )}
                </div>
                <div className="composer">
                  <textarea className="composer__input" rows={1} placeholder="Ask the agent…" />
                  <div className="composer__row">
                    <span className="composer__hint">⏎ send · page context attached</span>
                    <button className="composer__send" title="Send"><IconSend /></button>
                  </div>
                </div>
              </>
            ) : (
              <div className="rail__body">
                <MarksPanel
                  marks={marks}
                  preview={preview}
                  onArm={() => window.studio.armMarkMode()}
                  onComment={comment}
                  onGeneralize={generalize}
                />
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
