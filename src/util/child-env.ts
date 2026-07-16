/**
 * Return a copy of the parent process environment with the API-token secrets
 * stripped, for handing to spawned children (search sidecar, browser engine).
 * The daemon holds `WIGOLO_API_TOKEN` / `WIGOLO_API_TOKEN_FILE` in its own env;
 * children never need them, and leaking them into child environments would
 * widen the secret's exposure surface (`docker inspect`, `/proc/<pid>/environ`).
 * Targeted denylist — everything else (PATH, proxy vars, locale) is preserved
 * verbatim, so this is zero-regression for child behaviour.
 */
export function sanitizedChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.WIGOLO_API_TOKEN;
  delete env.WIGOLO_API_TOKEN_FILE;
  return env;
}
