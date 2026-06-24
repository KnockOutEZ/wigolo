import { useMemo } from 'preact/hooks';
import { ControlsModel } from '../transport/controls.js';
import { MarksModel } from '../transport/marks.js';
import { ApprovalsModel } from '../transport/approvals.js';
import { TimelineModel } from '../transport/timeline.js';
import { CommentsModel } from '../transport/comments.js';
import { ArtifactsModel } from '../transport/artifacts.js';
import { ControlsPanel } from './ControlsPanel.js';
import { MarksPanel } from './MarksPanel.js';
import { ApprovalsPanel } from './ApprovalsPanel.js';
import { TimelinePanel } from './TimelinePanel.js';
import { CommentsPanel } from './CommentsPanel.js';
import { CapturedPanel } from './CapturedPanel.js';

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
  artifacts?: ArtifactsModel;
}

export function Rail({ controls, marks, approvals, timeline, comments, artifacts }: RailProps = {}) {
  const c = useMemo<RailControls>(() => controls ?? { model: new ControlsModel(), emit: () => {} }, [controls]);
  const m = useMemo<MarksModel>(() => marks ?? new MarksModel(), [marks]);
  const a = useMemo<ApprovalsModel>(() => approvals ?? new ApprovalsModel(), [approvals]);
  const tl = useMemo<TimelineModel>(() => timeline ?? new TimelineModel(), [timeline]);
  const cm = useMemo<CommentsModel>(() => comments ?? new CommentsModel(), [comments]);
  const am = useMemo<ArtifactsModel>(() => artifacts ?? new ArtifactsModel(), [artifacts]);
  return (
    <aside class="studio-rail" aria-label="Session panel">
      <ApprovalsPanel model={a} emit={c.emit} />
      <ControlsPanel model={c.model} emit={c.emit} />
      <MarksPanel model={m} />
      <CommentsPanel model={cm} emit={c.emit} />
      <CapturedPanel model={am} />
      <TimelinePanel model={tl} />
    </aside>
  );
}
