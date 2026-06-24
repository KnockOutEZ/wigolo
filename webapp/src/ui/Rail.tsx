/**
 * The side rail scaffold (S7). An empty, labelled shell that later phases fill with the marks list,
 * captured items, timeline (audit), and approval cards. Copy is capability language only — no
 * implementation/dependency names ever reach the served UI.
 */
export function Rail() {
  return (
    <aside class="studio-rail" aria-label="Session panel">
      <h2>Session</h2>
      <p class="studio-rail-empty">Marks, captures, and the activity timeline will appear here.</p>
    </aside>
  );
}
