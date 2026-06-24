import { useRef, useEffect } from 'preact/hooks';
import { bootstrapStream } from '../transport/bootstrap.js';

/**
 * The live browser pane (S7): a canvas the host's screencast paints onto and that forwards human input.
 * The transport wiring is INJECTABLE (`connect`) so the component renders inertly in tests; the default is
 * the real bootstrap, which itself no-ops without a WebSocket (jsdom) so mounting never opens a socket in a
 * test environment.
 */
export interface BrowserPaneProps {
  /** Wire the live stream onto the canvas; returns a teardown. Defaults to the real bootstrap. */
  connect?: (canvas: HTMLCanvasElement) => () => void;
}

export function BrowserPane({ connect = bootstrapStream }: BrowserPaneProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return connect(ref.current);
  }, [connect]);
  return (
    <main class="studio-pane">
      <canvas ref={ref} class="studio-canvas" width={1280} height={720} tabIndex={0} aria-label="Live session view" />
    </main>
  );
}
