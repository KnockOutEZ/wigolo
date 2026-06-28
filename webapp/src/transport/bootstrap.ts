import { readNonce, readSessionId, exchangeNonceForToken, openStreamSocket } from './handshake.js';
import { type SocketLike } from './connection.js';
import { SessionConnector } from './session-connector.js';
import { FrameSink, createCanvasDraw } from './frame-sink.js';
import { parseDownMessage, encodeUp, up } from './codec.js';
import { toNormalized, mouseInput, domButton, modifiersOf, keyForwardMessages, type MouseEventType } from './input.js';
import { ControlsModel } from './controls.js';
import { MarksModel } from './marks.js';
import { ApprovalsModel } from './approvals.js';
import { TimelineModel } from './timeline.js';
import { CommentsModel } from './comments.js';
import { NarrationModel } from './narration.js';
import { ParkedModel } from './parked.js';
import { ArtifactsModel } from './artifacts.js';
import { SessionsModel } from './sessions.js';

/**
 * Wire the full live Studio session (S7 stream + S4 controls) onto ONE connection: redeem the one-time nonce
 * for the bearer, open the reconnecting stream, and expose (a) `connectCanvas` to paint frames + forward
 * human input onto a canvas, (b) a server-authoritative `model` the down-messages drive, and (c) `emit` to
 * send codec up-messages. Returns null when there is no WebSocket (jsdom/tests) or no nonce+session in the
 * URL — so importing/mounting the UI never opens a live connection in a test environment.
 *
 * The control epoch is host-authoritative: the host's hello/control down-messages feed `model.applyServer`,
 * and the last epoch is stamped on every forwarded input so a stale-epoch event is dropped at the host gate.
 */
export interface StudioWiring {
  /** The server-authoritative control state, fed by hello/control down-messages. */
  model: ControlsModel;
  /** The server-authoritative marks list, fed by marks_snapshot (backfill) + mark (live delta) down-messages. */
  marks: MarksModel;
  /** The server-authoritative pending-approval set, fed by approval_request down-messages (7d S1). */
  approvals: ApprovalsModel;
  /** The server-authoritative audit timeline, fed by audit_snapshot (backfill) + audit (live delta) down-messages (7d S4). */
  timeline: TimelineModel;
  /** The server-authoritative comments list, fed by comment_snapshot (backfill) + comment (live echo delta) down-messages (7b-notes S3). */
  comments: CommentsModel;
  /** The agent's ephemeral narration stream, fed by narration (live delta) down-messages (S2b). Broadcast-only — no backfill. */
  narration: NarrationModel;
  /** The agent's parked risky actions awaiting human review, fed by parked (live delta) down-messages (S7). Broadcast-only — no backfill. */
  parked: ParkedModel;
  /** The server-authoritative captured-items list, fed by artifact_snapshot (backfill) + artifact (live delta) down-messages (7e S3). */
  artifacts: ArtifactsModel;
  /** The server-authoritative live-session list, fed by sessions_snapshot (backfill) + sessions (delta) down-messages (7f B3). */
  sessions: SessionsModel;
  /** The session the stream is currently bound to on boot (the switcher highlights it; switching rebinds). */
  sessionId: string;
  /** Switch the live stream to another session — reuses the daemon-scoped bearer, tears down the old socket first (7f B3). */
  switchSession: (sessionId: string) => void;
  /** Send an encoded up-message to the host (no-op until the socket is up). */
  emit: (wire: string) => void;
  /** Paint frames + forward input onto a canvas; returns a teardown that detaches just that canvas. */
  connectCanvas: (canvas: HTMLCanvasElement) => () => void;
}

export function bootstrapStudio(): StudioWiring | null {
  if (typeof WebSocket === 'undefined') return null;
  const nonce = readNonce();
  const sessionId = readSessionId();
  if (!nonce || !sessionId) return null;

  const model = new ControlsModel();
  const marks = new MarksModel();
  const approvals = new ApprovalsModel();
  const timeline = new TimelineModel();
  const comments = new CommentsModel();
  const narration = new NarrationModel();
  const parked = new ParkedModel();
  const artifacts = new ArtifactsModel();
  const sessions = new SessionsModel();
  let connector: SessionConnector | null = null;
  let epoch = 0;
  const sinks = new Set<FrameSink>();

  const emit = (wire: string): void => connector?.send(wire);
  // Switch the stream to another session (no-op until the bearer handshake completed). The connector reuses
  // the daemon-scoped bearer and stops the old socket before opening the new (never two live streams).
  const switchSession = (id: string): void => connector?.connect(id);

  void exchangeNonceForToken(nonce)
    .then((bearer) => {
      connector = new SessionConnector({
        bearer,
        openSocket: (id, b) => openStreamSocket(id, b) as unknown as SocketLike,
        onMessage: (data) => {
          const msg = parseDownMessage(data);
          if (!msg) return;
          if (msg.t === 'frame') {
            for (const sink of sinks) sink.onFrame(msg.data);
          } else if (msg.t === 'hello' || msg.t === 'control') {
            // SERVER-authoritative: the host owns the epoch. Mirror it into the model (monotonic) and stamp
            // it on outgoing input so a flip-in-flight is dropped at the host gate.
            if (msg.holder !== undefined && typeof msg.epoch === 'number') {
              epoch = msg.epoch;
              model.applyServer(msg.holder, msg.epoch);
            }
          } else if (msg.t === 'marks_snapshot') {
            // 7c: the post-hello backfill — the host's complete marks set for this session (replaces).
            marks.applySnapshot(msg.marks);
          } else if (msg.t === 'mark') {
            // 7c: a live human-mark delta (upsert by id). SERVER-authoritative — no optimistic local add.
            marks.applyDelta({ markId: msg.markId, role: msg.role, name: msg.name, confidence: msg.confidence, ...(msg.ref ? { ref: msg.ref } : {}) });
          } else if (msg.t === 'approval_request') {
            // 7d S1: the host holds a risky agent action and asks the human. SERVER-authoritative — the card
            // appears only on this message; the human's verdict rides back out via the codec emit.
            approvals.add({ id: msg.id, action: msg.action, risk: msg.risk, ...(msg.target ? { target: msg.target } : {}) });
          } else if (msg.t === 'audit_snapshot') {
            // 7d S4: the post-hello backfill — the host's most-recent audit entries for this session (replaces).
            timeline.applySnapshot(msg.entries);
          } else if (msg.t === 'audit') {
            // 7d S4: a live audit delta — a newly-recorded agent action. SERVER-authoritative — append, no optimistic add.
            const { t: _t, ...entry } = msg;
            timeline.applyDelta(entry);
          } else if (msg.t === 'comment_snapshot') {
            // 7b-notes S3: the post-hello backfill — the host's complete comment set this session (replaces).
            comments.applySnapshot(msg.comments);
          } else if (msg.t === 'comment') {
            // 7b-notes S3: a live human-comment echo (upsert by id). SERVER-authoritative — the comment shows
            // only on this echo, never optimistically on the human's local submit.
            comments.applyDelta({ id: msg.id, text: msg.text });
          } else if (msg.t === 'narration') {
            // S2b: a live agent→human narration. Ephemeral (no backfill) — append; rendered inert via SafeText.
            narration.applyDelta(msg.text);
          } else if (msg.t === 'parked') {
            // S7: a risky agent action parked for human review (no matching pre-grant). Ephemeral — append.
            parked.applyDelta({ action: msg.action, risk: msg.risk, ...(msg.domain ? { domain: msg.domain } : {}), ...(msg.ref ? { ref: msg.ref } : {}) });
          } else if (msg.t === 'artifact_snapshot') {
            // 7e S3: the post-hello backfill — the host's complete captured set this session (replaces).
            artifacts.applySnapshot(msg.items);
          } else if (msg.t === 'artifact') {
            // 7e S3: a live captured-item delta (upsert by id). SERVER-authoritative — no optimistic local add.
            const { t: _t, ...item } = msg;
            artifacts.applyDelta(item);
          } else if (msg.t === 'sessions_snapshot' || msg.t === 'sessions') {
            // 7f B3: the post-hello backfill AND the live create/close delta both carry the host's COMPLETE
            // session set → REPLACE. SERVER-authoritative — the switcher never adds/removes a session locally.
            sessions.applySnapshot(msg.sessions);
          }
        },
      });
      connector.connect(sessionId);
    })
    .catch(() => {
      /* handshake failed — the human re-launches; nothing persists in the tab */
    });

  const connectCanvas = (canvas: HTMLCanvasElement): (() => void) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return () => {};
    const sink = new FrameSink({
      draw: createCanvasDraw(ctx, canvas.width, canvas.height),
      sendAck: () => connector?.send(encodeUp(up.ack())),
    });
    sinks.add(sink);

    const sendMouse = (type: MouseEventType) => (ev: MouseEvent) => {
      const { nx, ny } = toNormalized(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
      connector?.send(encodeUp(mouseInput({ type, nx, ny, epoch, button: domButton(ev.button), buttons: ev.buttons, modifiers: modifiersOf(ev) })));
    };
    const sendWheel = (ev: WheelEvent) => {
      const { nx, ny } = toNormalized(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
      connector?.send(encodeUp(mouseInput({ type: 'mouseWheel', nx, ny, epoch, deltaX: ev.deltaX, deltaY: ev.deltaY })));
    };
    // A printable keyDown forwards a `char` text-insertion event too (keyForwardMessages); a named/control key
    // forwards keyDown only — so the human's typing actually lands in the page, not just key events with no text.
    const sendKey = (domType: 'keydown' | 'keyup') => (ev: KeyboardEvent) => {
      for (const m of keyForwardMessages(domType, ev, epoch)) connector?.send(encodeUp(m));
    };
    const onDown = sendMouse('mousePressed');
    const onUp = sendMouse('mouseReleased');
    const onMove = sendMouse('mouseMoved');
    const onKeyDown = sendKey('keydown');
    const onKeyUp = sendKey('keyup');

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mouseup', onUp);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('wheel', sendWheel);
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);

    return () => {
      sinks.delete(sink);
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('wheel', sendWheel);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
    };
  };

  return { model, marks, approvals, timeline, comments, narration, parked, artifacts, sessions, sessionId, switchSession, emit, connectCanvas };
}
