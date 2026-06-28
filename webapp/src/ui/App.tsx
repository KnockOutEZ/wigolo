import { useMemo, useState } from 'preact/hooks';
import { BrowserPane } from './BrowserPane.js';
import { Rail, type RailControls } from './Rail.js';
import { bootstrapStudio, type StudioWiring } from '../transport/bootstrap.js';
import type { MarksModel } from '../transport/marks.js';
import type { ApprovalsModel } from '../transport/approvals.js';
import type { TimelineModel } from '../transport/timeline.js';
import type { CommentsModel } from '../transport/comments.js';
import type { NarrationModel } from '../transport/narration.js';
import type { ParkedModel } from '../transport/parked.js';
import type { ArtifactsModel } from '../transport/artifacts.js';
import type { SessionsModel } from '../transport/sessions.js';

/**
 * The Studio web-app root (S7 split view + S4 controls + 7c marks). It owns the single shared connection: one
 * `bootstrapStudio` feeds the browser pane (frames + input) AND the rail (server-authoritative control + marks
 * models + codec emit). In jsdom/tests `bootstrapStudio` returns null, so the UI renders inertly; the canvas
 * `connect`, the `controls`, and the `marks` model are all injectable for explicit tests. All user-facing copy
 * uses capability language only (the served-UI guardrail).
 */
export interface AppProps {
  /** Override the canvas wiring (tests). Defaults to the shared bootstrap. */
  connect?: (canvas: HTMLCanvasElement) => () => void;
  /** Override the rail controls (tests). Defaults to the shared bootstrap. */
  controls?: RailControls;
  /** Override the marks model (tests). Defaults to the shared bootstrap. */
  marks?: MarksModel;
  /** Override the approvals model (tests). Defaults to the shared bootstrap. */
  approvals?: ApprovalsModel;
  /** Override the timeline model (tests). Defaults to the shared bootstrap. */
  timeline?: TimelineModel;
  /** Override the comments model (tests). Defaults to the shared bootstrap. */
  comments?: CommentsModel;
  /** Override the narration model (tests). Defaults to the shared bootstrap. */
  narration?: NarrationModel;
  /** Override the parked-actions model (tests). Defaults to the shared bootstrap. */
  parked?: ParkedModel;
  /** Override the captured-items model (tests). Defaults to the shared bootstrap. */
  artifacts?: ArtifactsModel;
  /** Override the sessions model (tests). Defaults to the shared bootstrap. */
  sessions?: SessionsModel;
}

/**
 * Map the live bootstrap wiring to the rail's props. Explicit so the live control + marks models actually
 * reach the rail — the prior `boot?.controls` read a field the wiring never carried, leaving the rail inert
 * in production. Returns {} when there is no wiring (jsdom / no WebSocket).
 */
export function deriveRailProps(boot: StudioWiring | null): { controls?: RailControls; marks?: MarksModel; approvals?: ApprovalsModel; timeline?: TimelineModel; comments?: CommentsModel; narration?: NarrationModel; parked?: ParkedModel; artifacts?: ArtifactsModel; sessions?: SessionsModel } {
  if (!boot) return {};
  return { controls: { model: boot.model, emit: boot.emit }, marks: boot.marks, approvals: boot.approvals, timeline: boot.timeline, comments: boot.comments, narration: boot.narration, parked: boot.parked, artifacts: boot.artifacts, sessions: boot.sessions };
}

export function App({ connect, controls, marks, approvals, timeline, comments, narration, parked, artifacts, sessions }: AppProps = {}) {
  const boot = useMemo(() => bootstrapStudio(), []);
  const connectFn = connect ?? boot?.connectCanvas;
  const rail = deriveRailProps(boot);
  const controlsObj = controls ?? rail.controls;
  const marksModel = marks ?? rail.marks;
  const approvalsModel = approvals ?? rail.approvals;
  const timelineModel = timeline ?? rail.timeline;
  const commentsModel = comments ?? rail.comments;
  const narrationModel = narration ?? rail.narration;
  const parkedModel = parked ?? rail.parked;
  const artifactsModel = artifacts ?? rail.artifacts;
  const sessionsModel = sessions ?? rail.sessions;
  // The session the stream is bound to (switcher highlight). Switching rebinds the connection AND updates the
  // highlight; the session LIST itself stays server-authoritative (only snapshot/delta mutate it).
  const [current, setCurrent] = useState<string | null>(boot?.sessionId ?? null);
  const onSelectSession = (id: string): void => {
    boot?.switchSession(id);
    setCurrent(id);
  };
  return (
    <div id="studio-root" class="studio-split">
      <header class="studio-header">
        <h1>wigolo studio</h1>
      </header>
      <div class="studio-body">
        <BrowserPane connect={connectFn} />
        <Rail controls={controlsObj} marks={marksModel} approvals={approvalsModel} timeline={timelineModel} comments={commentsModel} narration={narrationModel} parked={parkedModel} artifacts={artifactsModel} sessions={sessionsModel} currentSessionId={current} onSelectSession={onSelectSession} />
      </div>
    </div>
  );
}
