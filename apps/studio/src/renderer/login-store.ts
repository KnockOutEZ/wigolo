/**
 * P5 — the login-handoff UI state for the human's login card. The host pushes state changes over the
 * `loginHandoff` IPC channel (in_progress → completed / failed); the store holds the latest and notifies
 * the App to re-render. Reset on a session switch (like the chat/grant stores). Carries ONLY {state, origin?}
 * — never credentials or page content.
 */
export interface LoginHandoffState {
  state: 'in_progress' | 'completed' | 'failed';
  origin?: string;
}

export function createLoginStore() {
  let cur: LoginHandoffState | null = null;
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());
  return {
    current: (): LoginHandoffState | null => cur,
    apply(next: LoginHandoffState): void {
      cur = next;
      emit();
    },
    reset(): void {
      cur = null;
      emit();
    },
    subscribe(fn: () => void): () => void {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
