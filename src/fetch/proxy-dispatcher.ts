import {
  EnvHttpProxyAgent,
  ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('fetch');

let installed: Dispatcher | null = null;
let previous: Dispatcher | null = null;

/** First proxy URL from the environment, in the order undici's own env agent reads it. */
function envProxyUrl(): string | null {
  return (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy ??
    null
  );
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
 * `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` variables are honoured through
 * undici's `EnvHttpProxyAgent`, which also applies `NO_PROXY`.
 *
 * Returns the installed dispatcher, or null when no proxy is configured.
 */
export function installProxyDispatcher(): Dispatcher | null {
  if (installed) return installed;

  const config = getConfig();
  let dispatcher: Dispatcher;
  let source: string;

  if (config.useProxy && config.proxyUrl) {
    dispatcher = new ProxyAgent(config.proxyUrl);
    source = 'PROXY_URL';
  } else if (envProxyUrl()) {
    dispatcher = new EnvHttpProxyAgent();
    source = 'environment';
  } else {
    return null;
  }

  previous = getGlobalDispatcher();
  setGlobalDispatcher(dispatcher);
  installed = dispatcher;
  log.info('installed an outbound proxy dispatcher', { source });
  return dispatcher;
}

/** True once `installProxyDispatcher()` installed a proxy for this process. */
export function hasProxyDispatcher(): boolean {
  return installed !== null;
}

/** Restore the dispatcher that was in place before installation (tests only). */
export function resetProxyDispatcher(): void {
  if (installed && previous) setGlobalDispatcher(previous);
  installed = null;
  previous = null;
}
