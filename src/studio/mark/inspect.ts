/**
 * Mark capture via the browser compositor's inspect mode (HANDOFF §2): `Overlay.setInspectMode`
 * → the human's next click on the streamed page is intercepted by the browser (NOT dispatched
 * to the page) and fires `Overlay.inspectNodeRequested` with the picked backend node. The
 * compositor highlight is immune to page CSS/CSP, and the pick rides the privileged CDP path —
 * no page script. This module is the choreography only: arm inspect mode, resolve the picked
 * node to a structured target (host-injected, AX⋈DOM), emit it, disarm. One mark per `enable()`.
 *
 * The listener is registered on the LIVE cdp at each `enable()` (via the injected getter) and
 * removed as soon as a node is picked, so a crash-recovery rebind of the session cdp is followed
 * automatically — a stale listener on a dead session can never deliver a mark.
 */
import { createLogger } from '../../logger.js';
import type { StructuredTarget } from './target.js';

const log = createLogger('studio');

export interface InspectCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): void;
  off?(event: string, handler: (params: unknown) => void): void;
}

export interface InspectorDeps {
  /** Live session cdp getter — read fresh at each enable so the listener follows a recovery rebind. */
  cdp: () => InspectCdp;
  /** Resolve a picked backend node to a structured target (host wires AX⋈DOM + buildTarget); null if it can't be built. */
  resolveMark: (backendNodeId: number) => Promise<StructuredTarget | null>;
  /** Emitted when a pick resolves to a target — the host stores it + enqueues a mark event. */
  onMark: (target: StructuredTarget) => void;
}

export interface Inspector {
  /** Arm inspect mode so the human's next click marks an element. */
  enable(): Promise<void>;
  /** Detach any armed listener (session teardown / re-arm). */
  stop(): void;
}

export function createInspector(deps: InspectorDeps): Inspector {
  let armed: { cdp: InspectCdp; handler: (p: unknown) => void } | null = null;

  const disarm = (): void => {
    if (armed) {
      armed.cdp.off?.('Overlay.inspectNodeRequested', armed.handler);
      armed = null;
    }
  };

  return {
    async enable(): Promise<void> {
      disarm(); // drop any prior (possibly stale) listener before re-arming on the live cdp
      const cdp = deps.cdp();
      const handler = (params: unknown): void => {
        const backendNodeId = (params as { backendNodeId?: number } | null)?.backendNodeId;
        disarm(); // one mark per enable: stop listening as soon as a node is picked
        void cdp.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }).catch(() => {});
        if (typeof backendNodeId !== 'number') return;
        void deps
          .resolveMark(backendNodeId)
          .then((target) => {
            if (target) deps.onMark(target);
            else log.debug('inspect pick did not resolve to a target', { backendNodeId });
          })
          .catch((err) => log.debug('resolveMark failed', { error: err instanceof Error ? err.message : String(err) }));
      };
      cdp.on('Overlay.inspectNodeRequested', handler);
      armed = { cdp, handler };
      await cdp.send('DOM.enable').catch(() => {}); // Overlay.enable requires the DOM agent enabled first
      await cdp.send('Overlay.enable').catch(() => {});
      await cdp.send('Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.4 } },
      });
    },
    stop(): void {
      disarm();
    },
  };
}
