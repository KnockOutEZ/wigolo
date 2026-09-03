/**
 * A hand-rolled `text/event-stream` parser — no dependency, because the SDK has none and one
 * event-stream field parser is not worth becoming the first.
 *
 * The parser is PURE: bytes in through `push`, complete messages out. It owns no socket, no
 * timer and no reconnect policy, so the resume behaviour that rides on it (`runs.ts`) is
 * testable by feeding it split chunks rather than by killing real sockets — and the same parser
 * serves whatever transport the caller has.
 *
 * Implements the WHATWG event-stream parsing rules that the daemon's stream actually exercises:
 * `\n` / `\r\n` / `\r` line breaks, comment (`:`) frames as heartbeats, the single optional
 * space after a field's colon, multi-line `data` joined with `\n`, and `id` persisting across
 * messages as the last-event-id (which the daemon sets to the run event's `seq` — that identity
 * is the whole resume contract).
 */

/** One dispatched event-stream message. */
export interface SseMessage {
  /** The `event:` field, or `'message'` when the stream did not name one. */
  type: string;
  /** `data:` lines joined with a newline, in arrival order. */
  data: string;
  /**
   * The last-event-id in force when this message dispatched. Persists across messages per the
   * event-stream rules, so a message with no `id:` of its own still carries the previous one.
   */
  lastEventId: string | undefined;
}

const LAST_EVENT_ID_HEADER = 'Last-Event-ID';

export { LAST_EVENT_ID_HEADER };

export class SseParser {
  /** Bytes seen but not yet terminated by a line break. */
  private pending = '';
  private dataLines: string[] = [];
  private eventType = '';
  /**
   * The id seen on the wire, which is NOT yet the resume point. The event-stream rules keep these
   * two apart deliberately and the separation is load-bearing here: a connection that dies after
   * `id: 13` but before that message's blank line must resume from 12, or event 13 — which was
   * never delivered to anyone — is skipped by the very mechanism meant to make resume gapless.
   */
  private idBuffer: string | undefined;
  /** The id of the last message actually DISPATCHED. This is what `Last-Event-ID` carries. */
  private lastEventId: string | undefined;
  private reconnectMs: number | undefined;
  /** Set when the previous chunk ended on a bare `\r`, whose `\n` may open the next one. */
  private sawTrailingCr = false;

  /** The `retry:` the server advertised, in ms, if it sent one. */
  get retryMs(): number | undefined {
    return this.reconnectMs;
  }

  /** The id to resume from — what goes in `Last-Event-ID` on the next connect. */
  get resumeId(): string | undefined {
    return this.lastEventId;
  }

  /**
   * Seed the resume point from outside — used when a caller knows where it got to (a stored
   * cursor) before the first byte arrives.
   */
  setResumeId(id: string | undefined): void {
    this.lastEventId = id;
    this.idBuffer = id;
  }

  /**
   * Feed a decoded chunk; returns every message that COMPLETED within it. A chunk boundary may
   * fall anywhere, including mid-field and between a `\r` and its `\n`, so nothing is dispatched
   * until a blank line actually arrives.
   */
  push(chunk: string): SseMessage[] {
    if (chunk.length === 0) return [];
    let text = chunk;
    // A `\r` that ended the previous chunk was already treated as a line break. If this chunk
    // opens with its `\n`, that pair is ONE break, not two — dropping the `\n` here is what keeps
    // a CRLF split across chunks from dispatching a spurious empty line.
    if (this.sawTrailingCr && text.startsWith('\n')) text = text.slice(1);
    this.sawTrailingCr = text.endsWith('\r');

    this.pending += text;
    const lines = this.pending.split(/\r\n|\n|\r/);
    // The final element is whatever followed the last break — incomplete unless the chunk ended
    // on one, in which case it is the empty string and carrying it over is a no-op.
    this.pending = lines.pop() ?? '';

    const messages: SseMessage[] = [];
    for (const line of lines) {
      const message = this.consumeLine(line);
      if (message) messages.push(message);
    }
    return messages;
  }

  /**
   * Drop everything half-parsed. Called when a connection dies mid-message: those bytes will be
   * re-sent from `lastEventId`, and keeping them would splice two connections' fragments into one
   * corrupt message. The resume id and retry hint deliberately SURVIVE — they are what the next
   * connection is built from.
   */
  reset(): void {
    this.pending = '';
    this.dataLines = [];
    this.eventType = '';
    this.sawTrailingCr = false;
    // Roll the id buffer back to the last DISPATCHED id. An id read off the dead connection
    // belongs to a message nobody received, and resuming past it would drop that event.
    this.idBuffer = this.lastEventId;
  }

  private consumeLine(line: string): SseMessage | undefined {
    if (line === '') return this.dispatch();
    // A comment frame. The daemon sends `: ping` every 15s of silence, so this is the common
    // case on an idle stream and must cost nothing.
    if (line.startsWith(':')) return undefined;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // Exactly one leading space is part of the framing, not the value.
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        // A NUL in an id is defined to be ignored rather than to reset the id.
        if (!value.includes('\u0000')) this.idBuffer = value;
        break;
      case 'retry': {
        if (/^\d+$/.test(value)) this.reconnectMs = Number(value);
        break;
      }
      default:
        // Unknown field: ignored, which is what makes the stream extensible.
        break;
    }
    return undefined;
  }

  /**
   * A blank line ends the message. A blank line with no `data` accumulated is NOT a message —
   * that is how the `retry:`-only opening frame and stray blank lines stay invisible to callers.
   */
  private dispatch(): SseMessage | undefined {
    if (this.dataLines.length === 0) {
      this.eventType = '';
      return undefined;
    }
    // Dispatch is the moment the buffered id BECOMES the resume point.
    this.lastEventId = this.idBuffer;
    const message: SseMessage = {
      type: this.eventType === '' ? 'message' : this.eventType,
      data: this.dataLines.join('\n'),
      lastEventId: this.lastEventId,
    };
    this.dataLines = [];
    this.eventType = '';
    return message;
  }
}
