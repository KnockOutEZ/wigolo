import { useEffect, useRef, useState } from 'react';
import './studio.css';
import type { StudioState } from '../shared/ipc';
import type { StudioApi } from '../preload/index';
import type { StudioGeneralizeOutput, ResearchBriefDto } from 'wigolo/studio';
import { TabStrip } from './TabStrip';
import { Toolbar } from './Omnibox';
import { DriveBanner } from './DriveBanner';
import { ApprovalCards } from './ApprovalCard';
import { MarksPanel } from './MarksPanel';
import { CapturesPanel } from './CapturesPanel';
import { TimelinePanel } from './TimelinePanel';
import { ChatPanel } from './ChatPanel';
import { GrantCard } from './GrantCard';
import { LoginCard } from './LoginCard';
import { KnowledgeRail } from './KnowledgeRail';
import { IconSpark, IconSend } from './icons';
import { createApprovalStore, type PendingApproval, type ApprovalVerdict } from './approval-store';
import { createMarksStore, type Mark } from './marks-store';
import { createCapturesStore } from './captures-store';
import { createTimelineStore } from './timeline-store';
import { createControlStore } from './control-store';
import { createChatStore } from './chat-store';
import { createLoginStore, type LoginHandoffState } from './login-store';
import type { CaptureDto, KnowledgeHit, ChatMsgDto, AuditDto } from '../shared/ipc';

declare global {
  interface Window { studio: StudioApi }
}

const approvalStore = createApprovalStore();
const marksStore = createMarksStore();
const capturesStore = createCapturesStore();
const timelineStore = createTimelineStore();
const controlStore = createControlStore();
const chatStore = createChatStore();
const loginStore = createLoginStore();
type RailTab = 'agent' | 'marks' | 'captures' | 'timeline';

export function App() {
  const [state, setState] = useState<StudioState>({ sessionName: '', tabs: [] });
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [captures, setCaptures] = useState<CaptureDto[]>([]);
  const [timeline, setTimeline] = useState<AuditDto[]>([]);
  const [brief, setBrief] = useState<ResearchBriefDto | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [knowledge, setKnowledge] = useState<KnowledgeHit[]>([]);
  const [preview, setPreview] = useState<StudioGeneralizeOutput | null>(null);
  const [railTab, setRailTab] = useState<RailTab>('agent');
  const [railOpen, setRailOpen] = useState(true);
  const [, setControlTick] = useState(0); // re-render on any per-tab control change (provenance dots / banner)
  const [chat, setChat] = useState<ChatMsgDto[]>([]);
  const [granted, setGranted] = useState(false);
  const [login, setLogin] = useState<LoginHandoffState | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

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
    capturesStore.subscribe(() => setCaptures(capturesStore.list()));
    window.studio.onCaptureAdded((c) => capturesStore.add(c));
    // P6 F4 timeline: mount backfill + live per-act delta (dedup by seq in the store).
    timelineStore.subscribe(() => setTimeline(timelineStore.list()));
    window.studio.onAuditEntry((e) => timelineStore.add(e));
    // P4 co-drive: per-tab control flips + agent acts drive the provenance dots + the drive banner.
    const unsubControl = controlStore.subscribe(() => setControlTick((n) => n + 1));
    window.studio.onDriveEvent((e) => {
      if (e.t === 'control' && e.holder) controlStore.applyControl(e.tabId, e.holder, e.epoch ?? 0);
      else if (e.t === 'act') controlStore.applyAct(e.tabId, e.action ?? '', e.narration, Date.now());
    });
    // P4 chat rail: agent messages (studio_say) arrive live; the composer posts human messages.
    const unsubChat = chatStore.subscribe(() => setChat(chatStore.list()));
    window.studio.onChatMessage((m) => chatStore.add(m));
    // P4 localhost grant (§13.8c): reflect the agent's per-session grant state.
    window.studio.onGrantState((g) => setGranted(g.granted));
    // P5 login-wall handoff: the host pushes {state, origin?}; the login card shows it (in_progress → settled).
    const unsubLogin = loginStore.subscribe(() => setLogin(loginStore.current()));
    window.studio.onLoginHandoff((msg) => loginStore.apply({ state: msg.state, origin: msg.origin }));
    // P4: on an active-session change (open/close), reset the grant UI, re-backfill that session's captures,
    // and clear the chat for the new session (within-run multi-session; cross-boot restore stays deferred).
    window.studio.onSessionChanged(() => {
      setGranted(false);
      chatStore.clear();
      loginStore.reset();
      void window.studio.listCaptures().then((c) => capturesStore.set(c));
      void window.studio.listAudit().then((a) => timelineStore.set(a));
      setBrief(null); // a synthesis belongs to the session it was run in
    });
    // ⌘J focuses the chat composer (spec §3).
    const onKey = (ev: KeyboardEvent) => { if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'j') { ev.preventDefault(); setRailTab('agent'); composerRef.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    // Mount-time backfill of already-captured items (empty on a fresh run; live captures then arrive via
    // the onCaptureAdded delta). Degrades to [] when the library is down. Per-session re-backfill (reading
    // a resumed session's prior captures) lands with session restore (P4+).
    void window.studio.listCaptures().then((c) => capturesStore.set(c));
    void window.studio.listAudit().then((a) => timelineStore.set(a));
    return () => { unsubControl(); unsubChat(); unsubLogin(); window.removeEventListener('keydown', onKey); };
  }, []);

  // Post text to the agent (optimistic local echo + deliver via the observe drain). The host credential-gates
  // the delivery, so a secret never reaches the agent even if typed here. Shared by the chat composer AND the
  // omnibox ⇥ intent (P6 F2 open decision #4 — reuse the chat channel, no wrapper).
  const postToAgent = (text: string): void => {
    const t = text.trim();
    if (!t) return;
    chatStore.add({ author: 'human', text: t, ts: Date.now() });
    window.studio.sendChat(t);
  };
  const sendChat = (): void => {
    const el = composerRef.current;
    postToAgent(el?.value ?? '');
    if (el) el.value = '';
  };

  const synthesize = (): void => {
    setSynthesizing(true);
    void window.studio.synthesize()
      .then(setBrief)
      .finally(() => setSynthesizing(false));
  };

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
  // Knowledge rail: find_similar on the current page against the local corpus, refreshed on tab/nav change.
  const activeKey = active ? `${active.url}\n${active.title}` : '';
  useEffect(() => {
    if (!active) { setKnowledge([]); return; }
    void window.studio.knowledgeSimilar(active.title || active.url).then(setKnowledge);
  }, [activeKey]);

  // P4 drive banner: shown only while the AGENT holds the visible tab. Tell main so it insets the stage.
  const bannerShow = active ? controlStore.holder(active.id) === 'agent' : false;
  useEffect(() => { void window.studio.setBannerOpen(bannerShow); }, [bannerShow]);

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
        provenance={(id) => controlStore.provenance(id, state.tabs.find((t) => t.id === id)?.active ?? false, Date.now())}
      />
      <Toolbar
        currentUrl={active?.url ?? ''}
        onNavigate={navigate}
        onBack={() => { /* history nav wired in a later phase */ }}
        onForward={() => { /* history nav wired in a later phase */ }}
        onReload={() => { if (active) void window.studio.navigate(active.id, active.url); }}
        railOpen={railOpen}
        onToggleRail={toggleRail}
        onClip={() => window.studio.armClip()}
        onIntent={postToAgent}
      />
      <DriveBanner
        show={bannerShow}
        step={active ? controlStore.step(active.id) : ''}
        onPause={() => { if (active) void window.studio.reclaimDrive(active.id); }}
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
                <button className={`rail__tab ${railTab === 'captures' ? 'is-active' : ''}`} onClick={() => setRailTab('captures')}>
                  Captures{captures.length ? ` · ${captures.length}` : ''}
                </button>
                <button className={`rail__tab ${railTab === 'timeline' ? 'is-active' : ''}`} onClick={() => setRailTab('timeline')}>
                  Timeline{timeline.length ? ` · ${timeline.length}` : ''}
                </button>
              </span>
              <span className="rail__badge">{state.sessionName || 'session'}</span>
              <span className="rail__spacer" />
            </div>
            {railTab === 'agent' ? (
              <>
                <div className="rail__body">
                  <LoginCard login={login} />
                  <ApprovalCards pending={pending} onDecide={decide} />
                  {chat.length > 0 ? (
                    <ChatPanel messages={chat} />
                  ) : pending.length === 0 ? (
                    <p className="rail__empty">
                      The agent co-drives this browser. It talks to you here — and approvals for <b>money</b>,
                      <b> credential</b>, and <b>destructive</b> actions surface here too; nothing risky runs
                      without your say-so.
                    </p>
                  ) : null}
                </div>
                <GrantCard
                  granted={granted}
                  onGrant={() => void window.studio.grantLocalhost()}
                  onRevoke={() => void window.studio.revokeLocalhost()}
                />
                <div className="composer">
                  <textarea
                    ref={composerRef}
                    className="composer__input"
                    rows={1}
                    placeholder="Message the agent…  (⌘J)"
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                  />
                  <div className="composer__row">
                    <span className="composer__hint">⏎ send · page context attached</span>
                    <button className="composer__send" title="Send" onClick={sendChat}><IconSend /></button>
                  </div>
                </div>
              </>
            ) : railTab === 'marks' ? (
              <div className="rail__body">
                <MarksPanel
                  marks={marks}
                  preview={preview}
                  onArm={() => window.studio.armMarkMode()}
                  onComment={comment}
                  onGeneralize={generalize}
                />
              </div>
            ) : railTab === 'captures' ? (
              <div className="rail__body">
                <CapturesPanel captures={captures} onSynthesize={synthesize} synthesizing={synthesizing} brief={brief} />
              </div>
            ) : (
              <div className="rail__body">
                <TimelinePanel entries={timeline} />
              </div>
            )}
            <KnowledgeRail hits={knowledge} />
          </aside>
        )}
      </div>
    </div>
  );
}
