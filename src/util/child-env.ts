/**
 * Return a copy of the parent process environment with the API-token secrets
 * stripped, for handing to spawned children (search sidecar, browser engine).
 * The daemon holds `WIGOLO_API_TOKEN` / `WIGOLO_API_TOKEN_FILE` in its own env;
 * children never need them, and leaking them into child environments would
 * widen the secret's exposure surface (`docker inspect`, `/proc/<pid>/environ`).
 * Targeted denylist — everything else (PATH, proxy vars, locale) is preserved
 * verbatim by default, so this is zero-regression for child behaviour.
 *
 * When `stripProxy` is set, the `*_PROXY` environment variables are also
 * removed. The browser engine is launched with this option so a configured
 * proxy's credentials never reach the browser child via environment (which is
 * inspectable through `/proc/<pid>/environ` / `docker inspect`); the proxy is
 * instead handed to the browser through its structured launch option. The
 * search sidecar keeps the default (proxy-preserving) behaviour so its
 * proxy path is unchanged.
 */
export function sanitizedChildEnv(opts: { stripProxy?: boolean } = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.WIGOLO_API_TOKEN;
  delete env.WIGOLO_API_TOKEN_FILE;
  if (opts.stripProxy) {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.ALL_PROXY;
    delete env.all_proxy;
  }
  return env;
}
