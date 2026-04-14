import * as http from 'node:http';
import { createLogger } from '../logger.js';
import type { CDPSession } from '../types.js';

const log = createLogger('fetch');

const DEFAULT_TIMEOUT_MS = 3000;

export interface DiscoverOptions {
  timeoutMs?: number;
  filterPages?: boolean;
}

function httpGet(url: string, timeoutMs: number): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, body });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`CDP request timed out after ${timeoutMs}ms`));
    });
  });
}

interface RawCDPEntry {
  id?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
  type?: string;
  devtoolsFrontendUrl?: string;
  description?: string;
}

export function parseCDPResponse(raw: string): CDPSession[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      log.debug('CDP response is not an array');
      return [];
    }

    return parsed
      .filter((entry: RawCDPEntry) => {
        if (!entry || typeof entry !== 'object') return false;
        if (!entry.id || typeof entry.id !== 'string') return false;
        if (!entry.webSocketDebuggerUrl || typeof entry.webSocketDebuggerUrl !== 'string') return false;
        return true;
      })
      .map((entry: RawCDPEntry) => ({
        id: entry.id!,
        url: entry.url ?? '',
        title: entry.title ?? '',
        webSocketDebuggerUrl: entry.webSocketDebuggerUrl!,
        type: entry.type,
        devtoolsFrontendUrl: entry.devtoolsFrontendUrl,
      }));
  } catch (err) {
    log.debug('failed to parse CDP response', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function discoverSessions(
  cdpUrl: string,
  options?: DiscoverOptions,
): Promise<CDPSession[]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const filterPages = options?.filterPages ?? false;
  const jsonUrl = cdpUrl.endsWith('/') ? `${cdpUrl}json` : `${cdpUrl}/json`;

  try {
    log.debug('discovering CDP sessions', { url: jsonUrl, timeoutMs });
    const { statusCode, body } = await httpGet(jsonUrl, timeoutMs);

    if (statusCode !== 200) {
      log.warn('CDP endpoint returned non-200', { statusCode, url: jsonUrl });
      return [];
    }

    let sessions = parseCDPResponse(body);

    if (filterPages) {
      sessions = sessions.filter(s => s.type === 'page' || s.type === undefined);
    }

    log.info('CDP sessions discovered', { count: sessions.length, url: jsonUrl });
    return sessions;
  } catch (err) {
    log.debug('CDP discovery failed', {
      url: jsonUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function isCDPReachable(cdpUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  const jsonUrl = cdpUrl.endsWith('/') ? `${cdpUrl}json` : `${cdpUrl}/json`;
  try {
    const { statusCode } = await httpGet(jsonUrl, timeoutMs);
    return statusCode === 200;
  } catch {
    return false;
  }
}
