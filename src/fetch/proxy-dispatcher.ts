import {
  EnvHttpProxyAgent,
  ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { getConfig } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("fetch");

/**
 * `always`: every request goes through the proxy (explicit PROXY_URL/ALL_PROXY).
 * `env`: HTTP(S)_PROXY decides per request, with NO_PROXY applied, exactly the
 * way undici's `EnvHttpProxyAgent` does — so a hop it sends direct must stay
 * direct here too.
 */
type ProxyMode = "always" | "env";

let installed: Dispatcher | null = null;
let previous: Dispatcher | null = null;
let mode: ProxyMode | null = null;

function envValue(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

/** Does `hostname`/`port` match one of the NO_PROXY entries? */
function matchesNoProxy(hostname: string, port: string): boolean {
  const raw = envValue("NO_PROXY", "no_proxy");
  if (!raw) return false;

  const host = hostname.toLowerCase();
  for (const entryRaw of raw.split(/[,\s]+/)) {
    const entry = entryRaw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;

    const [entryHost, entryPort] = entry.split(":");
    if (entryPort && entryPort !== port) continue;

    const suffix = entryHost.replace(/^\./, "");
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

/**
 * Route outbound `fetch` through the configured proxy, once per process.
 *
 * The browser tier and `cdp-direct` already honour `USE_PROXY`/`PROXY_URL`, but
 * the search engines and the HTTP client call the global `fetch` without a
 * dispatcher, so they went direct: behind a proxy every non-Bing engine timed
 * out and page fetches returned empty content.
 *
 * `PROXY_URL` wins over the environment. Otherwise the standard
 * `HTTPS_PROXY`/`HTTP_PROXY` variables are honoured through undici's
 * `EnvHttpProxyAgent`, which also applies `NO_PROXY`; `ALL_PROXY` alone is used
 * as an explicit proxy for every request (`EnvHttpProxyAgent` ignores it).
 *
 * Returns the installed dispatcher, or null when no proxy is configured.
 */
export function installProxyDispatcher(): Dispatcher | null {
  if (installed) return installed;

  const config = getConfig();
  let dispatcher: Dispatcher | null = null;
  let nextMode: ProxyMode = "always";
  let source = "";

  if (config.useProxy && config.proxyUrl) {
    dispatcher = new ProxyAgent(config.proxyUrl);
    source = "PROXY_URL";
  } else if (
    envValue("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")
  ) {
    dispatcher = new EnvHttpProxyAgent();
    nextMode = "env";
    source = "HTTP(S)_PROXY";
  } else {
    const allProxy = envValue("ALL_PROXY", "all_proxy");
    if (allProxy) {
      dispatcher = new ProxyAgent(allProxy);
      source = "ALL_PROXY";
    }
  }

  if (!dispatcher) return null;

  previous = getGlobalDispatcher();
  setGlobalDispatcher(dispatcher);
  installed = dispatcher;
  mode = nextMode;
  log.info("installed an outbound proxy dispatcher", {
    source,
    mode: nextMode,
  });
  return dispatcher;
}

/** True once `installProxyDispatcher()` installed a proxy for this process. */
export function hasProxyDispatcher(): boolean {
  return installed !== null;
}

/**
 * Will this specific hop go through the proxy?
 *
 * The caller uses this to keep the SSRF protections on hops that stay direct:
 * `EnvHttpProxyAgent` sends NO_PROXY matches, and `http:` requests when only
 * `HTTPS_PROXY` is set, straight to the origin — those still need DNS pinning
 * and the fail-closed check, because no proxy is resolving them.
 */
export function shouldProxyHop(target: string | URL): boolean {
  if (!installed || mode === null) return false;
  if (mode === "always") return true;

  let url: URL;
  try {
    url = typeof target === "string" ? new URL(target) : target;
  } catch {
    return true;
  }

  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (matchesNoProxy(url.hostname, port)) return false;

  if (url.protocol === "https:")
    return envValue("HTTPS_PROXY", "https_proxy") !== null;
  if (url.protocol === "http:")
    return envValue("HTTP_PROXY", "http_proxy") !== null;
  return false;
}

/** Restore the dispatcher that was in place before installation (tests only). */
export function resetProxyDispatcher(): void {
  if (installed && previous) setGlobalDispatcher(previous);
  installed = null;
  previous = null;
  mode = null;
}
