import { useRef, useEffect } from 'preact/hooks';

/**
 * The live browser pane (S7): a canvas the host's screencast paints onto and that forwards human input. The
 * transport wiring is INJECTED (`connect`) by the App, which owns the single shared connection (S4); when no
 * connect is supplied the pane renders inertly, so mounting never opens a socket in a test environment.
 */
export interface BrowserPaneProps {
  /** Paint frames + forward input onto the canvas; returns a teardown. */
  connect?: (canvas: HTMLCanvasElement) => () => void;
}

export function BrowserPane({ connect }: BrowserPaneProps = {}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current || !connect) return;
    return connect(ref.current);
  }, [connect]);
  return (
    <main class="studio-pane">
      <canvas ref={ref} class="studio-canvas" width={1280} height={720} tabIndex={0} aria-label="Live session view" />
    </main>
  );
}
