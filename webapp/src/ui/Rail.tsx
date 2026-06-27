import { useMemo } from 'preact/hooks';
import { ControlsModel } from '../transport/controls.js';
import { MarksModel } from '../transport/marks.js';
import { ApprovalsModel } from '../transport/approvals.js';
import { TimelineModel } from '../transport/timeline.js';
import { CommentsModel } from '../transport/comments.js';
import { NarrationModel } from '../transport/narration.js';
import { ArtifactsModel } from '../transport/artifacts.js';
import { SessionsModel } from '../transport/sessions.js';
import { ControlsPanel } from './ControlsPanel.js';
import { MarksPanel } from './MarksPanel.js';
import { ApprovalsPanel } from './ApprovalsPanel.js';
import { TimelinePanel } from './TimelinePanel.js';
import { CommentsPanel } from './CommentsPanel.js';
import { NarrationPanel } from './NarrationPanel.js';
import { CapturedPanel } from './CapturedPanel.js';
import { SessionSwitcher } from './SessionSwitcher.js';

/**
 * The side rail (S4). Its TOP panel is the approval cards (7d S1) — a risky-action interrupt the human answers
 * first; then the direct-drive controls (who's-driving + handoff + nav); the marks-list read surface (7c); the
 * comments panel (7b-notes); the captured-items panel (7e); and the activity timeline (7d S4 = the audit log),
 * all wired to the live connection's models + the ONE codec emit. With nothing injected — the jsdom/no-op path
 * — it renders inert default models so mounting never needs a live connection. Copy is capability language only.
 */
export interface RailControls {
  model: ControlsModel;
  emit: (wire: string) => void;
}

export interface RailProps {
  controls?: RailControls;
  marks?: MarksModel;
  approvals?: ApprovalsModel;
  timeline?: TimelineModel;
  comments?: CommentsModel;
  narration?: NarrationModel;
  artifacts?: ArtifactsModel;
  sessions?: SessionsModel;
  /** The session the stream is bound to (switcher highlight). */
  currentSessionId?: string | null;
  /** Switch the live stream to another session. */
  onSelectSession?: (sessionId: string) => void;
}

export function Rail({ controls, marks, approvals, timeline, comments, narration, artifacts, sessions, currentSessionId, onSelectSession }: RailProps = {}) {
  const c = useMemo<RailControls>(() => controls ?? { model: new ControlsModel(), emit: () => {} }, [controls]);
  const m = useMemo<MarksModel>(() => marks ?? new MarksModel(), [marks]);
  const a = useMemo<ApprovalsModel>(() => approvals ?? new ApprovalsModel(), [approvals]);
  const tl = useMemo<TimelineModel>(() => timeline ?? new TimelineModel(), [timeline]);
  const cm = useMemo<CommentsModel>(() => comments ?? new CommentsModel(), [comments]);
  const nm = useMemo<NarrationModel>(() => narration ?? new NarrationModel(), [narration]);
  const am = useMemo<ArtifactsModel>(() => artifacts ?? new ArtifactsModel(), [artifacts]);
  const sm = useMemo<SessionsModel>(() => sessions ?? new SessionsModel(), [sessions]);
  return (
    <aside class="studio-rail" aria-label="Session panel">
      <ApprovalsPanel model={a} emit={c.emit} />
      <ControlsPanel model={c.model} emit={c.emit} />
      <SessionSwitcher model={sm} currentSessionId={currentSessionId} onSelect={onSelectSession} />
      <MarksPanel model={m} />
      <CommentsPanel model={cm} emit={c.emit} />
      <NarrationPanel model={nm} />
      <CapturedPanel model={am} />
      <TimelinePanel model={tl} />
    </aside>
  );
}
