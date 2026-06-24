import { readNonce, readSessionId, exchangeNonceForToken, openStreamSocket } from './handshake.js';
import { StreamConnection, type SocketLike } from './connection.js';
import { FrameSink, createCanvasDraw } from './frame-sink.js';
import { parseDownMessage, encodeUp, up, type ControlParty } from './codec.js';
import { toNormalized, mouseInput, keyInput, domButton, modifiersOf, type MouseEventType } from './input.js';

/**
 * Wire the full live stream onto a canvas (S7 glue): redeem the one-time nonce for the bearer, open the
 * reconnecting stream, paint frames + ack, and forward human input — all from the already-tested transport
 * pieces. Returns a teardown. A no-op when there is no WebSocket (jsdom/tests), no nonce+session in the URL,
 * or no 2D context — so importing/mounting the UI never attempts a live connection in a test environment.
 */
export function bootstrapStream(canvas: HTMLCanvasElement): () => void {
  if (typeof WebSocket === 'undefined') return () => {};
  const nonce = readNonce();
  const sessionId = readSessionId();
  if (!nonce || !sessionId) return () => {};
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  let conn: StreamConnection | null = null;
  let epoch = 0;
  // The control epoch is host-authoritative; we stamp the epoch the host last told us on every input so a
  // stale-epoch event is dropped at the host gate (holder flips between turns).

  const sink = new FrameSink({
    draw: createCanvasDraw(ctx, canvas.width, canvas.height),
    sendAck: () => conn?.send(encodeUp(up.ack())),
  });

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

  void exchangeNonceForToken(nonce)
    .then((bearer) => {
      conn = new StreamConnection({
        openSocket: (b) => openStreamSocket(sessionId, b) as unknown as SocketLike,
        bearer,
        onMessage: (data) => {
          const msg = parseDownMessage(data);
          if (!msg) return;
          if (msg.t === 'frame') {
            sink.onFrame(msg.data);
          } else if (msg.t === 'hello' || msg.t === 'control') {
            if (typeof msg.epoch === 'number') epoch = msg.epoch;
            void (msg.holder as ControlParty | undefined);
          }
        },
      });
      conn.start();
    })
    .catch(() => {
      /* handshake failed — the human re-launches; nothing persists in the tab */
    });

  return () => {
    canvas.removeEventListener('mousedown', onDown);
    canvas.removeEventListener('mouseup', onUp);
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('wheel', sendWheel);
    canvas.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('keyup', onKeyUp);
    conn?.stop();
  };
}
