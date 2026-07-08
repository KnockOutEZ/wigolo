/**
 * The login-wall handoff card (spec §7) — shown the instant the agent hits a sign-in wall. It tells the
 * human to sign in (the agent has paused and cannot see the credentials), then reflects the settled state.
 * Capability language ONLY (no engine/library names). The completed copy makes NO persistence claim: on a
 * host without secure key storage the sign-in is not saved (fail-closed), so the card must never over-assure.
 */
import type { LoginHandoffState } from './login-store';

export function LoginCard({ login }: { login: LoginHandoffState | null }) {
  if (!login) return null;
  if (login.state === 'in_progress') {
    return (
      <div className="login-card login-card--active" role="status">
        <div className="login-card__title">Sign in to continue</div>
        <div className="login-card__body">
          A sign-in wall appeared{login.origin ? ` on ${login.origin}` : ''}. The agent has paused and{' '}
          <strong>cannot see your credentials</strong> — sign in here and the agent resumes automatically.
        </div>
      </div>
    );
  }
  if (login.state === 'completed') {
    return (
      <div className="login-card login-card--done" role="status">
        <div className="login-card__title">Signed in{login.origin ? ` — ${login.origin}` : ''}</div>
        <div className="login-card__body">The agent has resumed on the signed-in session.</div>
      </div>
    );
  }
  return (
    <div className="login-card login-card--failed" role="status">
      <div className="login-card__title">Sign-in didn’t complete</div>
      <div className="login-card__body">The agent stayed paused. Reopen the session to try again.</div>
    </div>
  );
}
