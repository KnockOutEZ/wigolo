/**
 * The Studio web-app root. S1 ships a minimal placeholder shell so the daemon static route + build
 * pipeline have something real to serve; the split-view (browser pane + rail) lands in S7. All
 * user-facing copy uses capability language only — never an implementation/dependency name.
 */
export function App() {
  return (
    <div id="studio-root">
      <h1>wigolo studio</h1>
      <p>Connecting to your session…</p>
    </div>
  );
}
