import {
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { getConfig } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("fetch");

/**
 * The proxy settings the installed dispatcher was built from. `shouldProxyHop`
 * reads the same snapshot, so the per-hop answer cannot drift from what the
 * dispatcher actually does with that hop.
 */
interface ProxySettings {
  http: string | null;
  https: string | null;
  noProxy: string;
}

interface NoProxyEntry {
  hostname: string;
  port: number;
}

/** Loopback stays direct under an explicit proxy, so local daemon checks work. */
const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,[::1]";

const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };

let installed: Dispatcher | null = null;
let previous: Dispatcher | null = null;
let settings: ProxySettings | null = null;
let noProxyEntries: NoProxyEntry[] = [];

function nonEmpty(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

/**
 * Resolve which proxy applies, once per process.
 *
 * `PROXY_URL` (with `USE_PROXY`) wins, then `ALL_PROXY`; both send every
 * request through the proxy except loopback. Otherwise the standard
 * `http_proxy`/`https_proxy`/`no_proxy` variables apply, read in the same
 * order as undici's `EnvHttpProxyAgent`: lowercase first, and a set but empty
 * lowercase value wins.
 */
function resolveProxySettings(): { settings: ProxySettings; source: string } | null {
  const config = getConfig();
  if (config.useProxy && config.proxyUrl) {
    return {
      settings: { http: config.proxyUrl, https: config.proxyUrl, noProxy: LOOPBACK_NO_PROXY },
      source: "PROXY_URL",
    };
  }

  const http = nonEmpty(process.env.http_proxy ?? process.env.HTTP_PROXY);
  const https = nonEmpty(process.env.https_proxy ?? process.env.HTTPS_PROXY);
  if (http || https) {
    return {
      settings: { http, https, noProxy: process.env.no_proxy ?? process.env.NO_PROXY ?? "" },
      source: "HTTP(S)_PROXY",
    };
  }

  const all = nonEmpty(process.env.ALL_PROXY ?? process.env.all_proxy);
  if (all) {
    return {
      settings: { http: all, https: all, noProxy: LOOPBACK_NO_PROXY },
      source: "ALL_PROXY",
    };
  }
  return null;
}

/** Parse a NO_PROXY value the way undici's `EnvHttpProxyAgent` does. */
function parseNoProxy(value: string): NoProxyEntry[] {
  const entries: NoProxyEntry[] = [];
  for (const entry of value.split(/[,\s]/)) {
    if (!entry) continue;
    const parsed = entry.match(/^(.+):(\d+)$/);
    entries.push({
      hostname: (parsed ? parsed[1] : entry).replace(/^\*?\./, "").toLowerCase(),
      port: parsed ? Number.parseInt(parsed[2], 10) : 0,
    });
  }
  return entries;
}

/**
 * Route outbound `fetch` through the configured proxy, once per process.
 *
 * The browser tier and `cdp-direct` read their own proxy options. The search
 * engines and the HTTP client call the global `fetch` without a dispatcher, so
 * without this they ignore the proxy.
 *
 * Returns the installed dispatcher, or null when no proxy is configured. A
 * setting that cannot be parsed is logged and skipped, so commands that do not
 * touch the network still run.
 */
export function installProxyDispatcher(): Dispatcher | null {
  if (installed) return installed;

  const resolved = resolveProxySettings();
  if (!resolved) return null;

  let dispatcher: Dispatcher;
  try {
    // Explicit values (empty string = none) stop undici from re-reading the environment.
    dispatcher = new EnvHttpProxyAgent({
      httpProxy: resolved.settings.http ?? "",
      httpsProxy: resolved.settings.https ?? "",
      noProxy: resolved.settings.noProxy,
    });
  } catch (err) {
    log.warn("ignoring an invalid proxy setting; outbound fetch goes direct", {
      source: resolved.source,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  previous = getGlobalDispatcher();
  setGlobalDispatcher(dispatcher);
  installed = dispatcher;
  settings = resolved.settings;
  noProxyEntries = parseNoProxy(resolved.settings.noProxy);
  log.info("installed an outbound proxy dispatcher", { source: resolved.source });
  return dispatcher;
}

/** True once `installProxyDispatcher()` installed a proxy for this process. */
export function hasProxyDispatcher(): boolean {
  return installed !== null;
}

/**
 * Will this specific hop go through the proxy?
 *
 * Mirrors `EnvHttpProxyAgent`'s choice for the installed settings. The caller
 * keeps DNS pinning and the fail-closed check on every hop that goes direct,
 * because no proxy resolves those names.
 */
export function shouldProxyHop(target: string | URL): boolean {
  if (!installed || !settings) return false;

  let url: URL;
  try {
    url = typeof target === "string" ? new URL(target) : target;
  } catch {
    return true;
  }

  // Same host and port derivation as undici: IPv6 brackets are kept.
  const hostname = url.host.replace(/:\d*$/, "").toLowerCase();
  const port = Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol] || 0;

  if (noProxyEntries.length > 0) {
    if (settings.noProxy === "*") return false;
    for (const entry of noProxyEntries) {
      if (entry.port && entry.port !== port) continue;
      if (hostname === entry.hostname) return false;
      if (hostname.endsWith(`.${entry.hostname}`)) return false;
    }
  }

  // undici sends https through the https proxy, else the http proxy.
  if (url.protocol === "https:") return (settings.https ?? settings.http) !== null;
  return settings.http !== null;
}

/** Restore the dispatcher that was in place before installation (tests only). */
export function resetProxyDispatcher(): void {
  if (installed && previous) setGlobalDispatcher(previous);
  installed = null;
  previous = null;
  settings = null;
  noProxyEntries = [];
}
