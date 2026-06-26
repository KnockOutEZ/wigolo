import { createLogger } from '../logger.js';

/**
 * Bridges CDP `Page.startScreencast` to a frame sink (the WS hub). Two pacers,
 * decoupled:
 *  - CDP is acked on EVERY frame so Chrome keeps capturing at full rate.
 *  - the client is fed lock-step: at most one forwarded frame in flight; frames
 *    that arrive while the client hasn't acked are held (newest-wins, older
 *    dropped) and released on the client's ack. An ack-timeout releases the held
 *    frame anyway so a stalled client can't freeze the stream.
 * Baseline transport per the Phase-1 latency spike (GO): JPEG-over-WS + ack/drop.
 * The CDP session is injected so the logic is unit-testable without a browser.
 */

const log = createLogger('studio');

export interface FrameMetadata {
  offsetTop?: number;
  pageScaleFactor?: number;
  deviceWidth?: number;
  deviceHeight?: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  timestamp?: number;
}

/** A frame forwarded to the client: base64 JPEG + the metadata input mapping needs (1c). */
export interface ScreencastFrame {
  data: string;
  metadata: FrameMetadata;
}

/** The CDP `Page.screencastFrame` event payload. */
export interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
  metadata: FrameMetadata;
}

/** The slice of a CDP session this bridge needs (injectable for tests). */
export interface ScreencastCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, cb: (payload: ScreencastFrameEvent) => void): void;
  off(event: string, cb: (payload: ScreencastFrameEvent) => void): void;
}

export interface ScreencastBridgeOptions {
  cdp: ScreencastCdp;
  sink: (frame: ScreencastFrame) => void;
  quality: number;
  maxWidth: number;
  maxHeight: number;
  everyNthFrame: number;
  ackTimeoutMs: number;
  /** Observability hooks (optional): fired when a frame is forwarded / dropped under backpressure. */
  onForward?: () => void;
  onDrop?: () => void;
}

export class ScreencastBridge {
  private cdp: ScreencastCdp; // reassigned on restart() after a crash recovery
  private readonly sink: (frame: ScreencastFrame) => void;
  private readonly quality: number;
  private readonly maxWidth: number;
  private readonly maxHeight: number;
  private readonly everyNthFrame: number;
  private readonly ackTimeoutMs: number;
  private readonly onForward?: () => void;
  private readonly onDrop?: () => void;

  private started = false;
  private pending = false; // a forwarded frame is awaiting the client's ack
  private held: ScreencastFrame | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(o: ScreencastBridgeOptions) {
    this.cdp = o.cdp;
    this.sink = o.sink;
    this.quality = o.quality;
    this.maxWidth = o.maxWidth;
    this.maxHeight = o.maxHeight;
    this.everyNthFrame = o.everyNthFrame;
    this.ackTimeoutMs = o.ackTimeoutMs;
    this.onForward = o.onForward;
    this.onDrop = o.onDrop;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.cdp.on('Page.screencastFrame', this.onFrame);
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.quality,
      maxWidth: this.maxWidth,
      maxHeight: this.maxHeight,
      everyNthFrame: this.everyNthFrame,
    });
    log.debug('screencast started', { quality: this.quality, maxWidth: this.maxWidth, maxHeight: this.maxHeight });
  }

  /** The client painted the last forwarded frame — release the newest held frame, if any. */
  onClientAck(): void {
    this.clearAckTimer();
    this.pending = false;
    this.flushHeld();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.cdp.off('Page.screencastFrame', this.onFrame);
    this.clearAckTimer();
    this.pending = false;
    this.held = null;
    await this.cdp.send('Page.stopScreencast').catch((err) =>
      log.debug('stopScreencast failed', { error: err instanceof Error ? err.message : String(err) }),
    );
  }

  /**
   * Rebind to a fresh CDP session after a browser-crash recovery (wired to
   * SessionBrowser.onRecovered). Detaches the dead session and RESETS all
   * ack/frame state — a frame/ack in flight against the old session is
   * meaningless against the new one, so it must not carry over.
   */
  async restart(newCdp?: ScreencastCdp): Promise<void> {
    this.cdp.off('Page.screencastFrame', this.onFrame);
    this.clearAckTimer();
    this.pending = false;
    this.held = null;
    if (newCdp) this.cdp = newCdp;
    this.started = false;
    await this.start();
  }

  private onFrame = (ev: ScreencastFrameEvent): void => {
    // Keep Chrome capturing regardless of how fast the client drains.
    void this.cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    const frame: ScreencastFrame = { data: ev.data, metadata: ev.metadata };
    if (this.pending) {
      if (this.held) this.onDrop?.(); // the previously held frame is discarded (newest-held-wins)
      this.held = frame;
      return;
    }
    this.forward(frame);
  };

  private forward(frame: ScreencastFrame): void {
    this.held = null;
    this.pending = true;
    this.onForward?.();
    this.sink(frame);
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.pending = false;
      this.flushHeld();
    }, this.ackTimeoutMs);
    if (typeof this.ackTimer.unref === 'function') this.ackTimer.unref();
  }

  private flushHeld(): void {
    if (this.held && !this.pending) {
      const next = this.held;
      this.held = null;
      this.forward(next);
    }
  }

  private clearAckTimer(): void {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }
}
