import { readNonce, readSessionId, exchangeNonceForToken, openStreamSocket } from './handshake.js';
import { StreamConnection, type SocketLike } from './connection.js';
import { FrameSink, createCanvasDraw } from './frame-sink.js';
import { parseDownMessage, encodeUp, up } from './codec.js';
import { toNormalized, mouseInput, keyInput, domButton, modifiersOf, type MouseEventType } from './input.js';
import { ControlsModel } from './controls.js';

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
  let conn: StreamConnection | null = null;
  let epoch = 0;
  const sinks = new Set<FrameSink>();

  const emit = (wire: string): void => conn?.send(wire);

  void exchangeNonceForToken(nonce)
    .then((bearer) => {
      conn = new StreamConnection({
        openSocket: (b) => openStreamSocket(sessionId, b) as unknown as SocketLike,
        bearer,
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
          }
        },
      });
      conn.start();
    })
    .catch(() => {
      /* handshake failed — the human re-launches; nothing persists in the tab */
    });

  const connectCanvas = (canvas: HTMLCanvasElement): (() => void) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return () => {};
    const sink = new FrameSink({
      draw: createCanvasDraw(ctx, canvas.width, canvas.height),
      sendAck: () => conn?.send(encodeUp(up.ack())),
    });
    sinks.add(sink);

    const sendMouse = (type: MouseEventType) => (ev: MouseEvent) => {
      const { nx, ny } = toNormalized(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
      conn?.send(encodeUp(mouseInput({ type, nx, ny, epoch, button: domButton(ev.button), buttons: ev.buttons, modifiers: modifiersOf(ev) })));
    };
    const sendWheel = (ev: WheelEvent) => {
      const { nx, ny } = toNormalized(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
      conn?.send(encodeUp(mouseInput({ type: 'mouseWheel', nx, ny, epoch, deltaX: ev.deltaX, deltaY: ev.deltaY })));
    };
    const sendKey = (type: 'keyDown' | 'keyUp') => (ev: KeyboardEvent) => {
      conn?.send(encodeUp(keyInput({ type, key: ev.key, code: ev.code, epoch, modifiers: modifiersOf(ev) })));
    };
    const onDown = sendMouse('mousePressed');
    const onUp = sendMouse('mouseReleased');
    const onMove = sendMouse('mouseMoved');
    const onKeyDown = sendKey('keyDown');
    const onKeyUp = sendKey('keyUp');

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

  return { model, emit, connectCanvas };
}
