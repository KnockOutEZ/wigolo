import { describe, it, expect, vi } from 'vitest';
import type { Browser } from 'playwright';
import {
  connectScrapingBrowser,
  type CdpConnector,
} from '../../../src/fetch/scraping-browser.js';
import type { Logger } from '../../../src/logger.js';

// A minimal Browser stub: only close() is exercised by the handle. Cast through
// the real type so the module's Browser return contract is honoured.
function makeFakeBrowser(): { browser: Browser; closed: () => boolean } {
  let closedFlag = false;
  const browser = {
    close: vi.fn(async () => {
      closedFlag = true;
    }),
  } as unknown as Browser;
  return { browser, closed: () => closedFlag };
}

// Capture every log line so redaction (and off-machine-egress transparency) is
// assertable without touching stderr.
function makeCapturingLogger(): {
  logger: Logger;
  lines: Array<{ level: string; msg: string; data?: Record<string, unknown> }>;
} {
  const lines: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const record =
    (level: string) => (msg: string, data?: Record<string, unknown>) =>
      lines.push({ level, msg, data });
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
  return { logger, lines };
}

const CRED_WSS = 'wss://user-abc123:secret-token@brd.superproxy.io:9222';

describe('connectScrapingBrowser — OFF by default', () => {
  it('returns null and never calls the connector when wss is null', async () => {
    const connect = vi.fn<CdpConnector>();
    const out = await connectScrapingBrowser({ wss: null, connect });
    expect(out).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it('returns null and never calls the connector when wss is undefined', async () => {
    const connect = vi.fn<CdpConnector>();
    const out = await connectScrapingBrowser({ wss: undefined, connect });
    expect(out).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it('returns null and never calls the connector when wss is empty', async () => {
    const connect = vi.fn<CdpConnector>();
    const out = await connectScrapingBrowser({ wss: '', connect });
    expect(out).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('connectScrapingBrowser — scheme validation', () => {
  it('refuses http:// (connector not called, warns)', async () => {
    const connect = vi.fn<CdpConnector>();
    const { logger, lines } = makeCapturingLogger();
    const out = await connectScrapingBrowser({
      wss: 'http://user:pass@brd.superproxy.io:9222',
      connect,
      logger,
    });
    expect(out).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('refuses ftp:// (connector not called, warns)', async () => {
    const connect = vi.fn<CdpConnector>();
    const { logger, lines } = makeCapturingLogger();
    const out = await connectScrapingBrowser({
      wss: 'ftp://brd.superproxy.io/thing',
      connect,
      logger,
    });
    expect(out).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('refuses a non-URL string (connector not called)', async () => {
    const connect = vi.fn<CdpConnector>();
    const out = await connectScrapingBrowser({ wss: 'not a url', connect });
    expect(out).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('connectScrapingBrowser — valid connect', () => {
  it('calls the injected connector with the wss and returns a handle', async () => {
    const { browser } = makeFakeBrowser();
    const connect = vi.fn(async () => browser);
    const out = await connectScrapingBrowser({ wss: CRED_WSS, connect });
    expect(out).not.toBeNull();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(CRED_WSS);
    expect(out!.browser).toBe(browser);
  });

  it('accepts a plain ws:// endpoint', async () => {
    const { browser } = makeFakeBrowser();
    const connect = vi.fn(async () => browser);
    const out = await connectScrapingBrowser({ wss: 'ws://127.0.0.1:9222/devtools', connect });
    expect(out).not.toBeNull();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('close() disconnects the connected browser exactly once', async () => {
    const { browser, closed } = makeFakeBrowser();
    const connect = vi.fn(async () => browser);
    const out = await connectScrapingBrowser({ wss: CRED_WSS, connect });
    expect(closed()).toBe(false);
    await out!.close();
    expect(closed()).toBe(true);
    expect(browser.close).toHaveBeenCalledTimes(1);
    // Idempotent: a second close() does not re-disconnect.
    await out!.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('returns null (never throws) when the connector fails', async () => {
    const connect = vi.fn(async () => {
      throw new Error('connect refused');
    });
    const { logger, lines } = makeCapturingLogger();
    const out = await connectScrapingBrowser({ wss: CRED_WSS, connect, logger });
    expect(out).toBeNull();
    expect(lines.some((l) => l.level === 'warn')).toBe(true);
  });
});

describe('connectScrapingBrowser — credential redaction & transparency', () => {
  it('redacts the credential userinfo in the off-machine-egress log line', async () => {
    const { browser } = makeFakeBrowser();
    const connect = vi.fn(async () => browser);
    const { logger, lines } = makeCapturingLogger();
    await connectScrapingBrowser({ wss: CRED_WSS, connect, logger });

    // The transparent egress line is emitted at info.
    const egress = lines.find(
      (l) => l.level === 'info' && l.msg.includes('off-machine egress'),
    );
    expect(egress).toBeDefined();

    // No credential (userinfo) leaks into any captured log line.
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('user-abc123');
    expect(serialized).not.toContain('secret-token');
    // The redacted endpoint still identifies the host.
    expect(serialized).toContain('brd.superproxy.io');
  });

  it('redacts the credential in the connect-failure warn line', async () => {
    const connect = vi.fn(async () => {
      throw new Error('boom');
    });
    const { logger, lines } = makeCapturingLogger();
    await connectScrapingBrowser({ wss: CRED_WSS, connect, logger });
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('user-abc123');
    expect(serialized).not.toContain('secret-token');
  });
});

describe('connectScrapingBrowser — abort & timeout', () => {
  it('returns null when the signal is already aborted (connector not called)', async () => {
    const connect = vi.fn<CdpConnector>();
    const controller = new AbortController();
    controller.abort();
    const out = await connectScrapingBrowser({ wss: CRED_WSS, connect, signal: controller.signal });
    expect(out).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it('returns null when the signal aborts mid-connect', async () => {
    const controller = new AbortController();
    // A connector that never resolves — only the abort can settle the connect.
    const connect = vi.fn(() => new Promise<Browser>(() => {}));
    const { logger, lines } = makeCapturingLogger();
    const p = connectScrapingBrowser({
      wss: CRED_WSS,
      connect,
      signal: controller.signal,
      logger,
    });
    controller.abort();
    const out = await p;
    expect(out).toBeNull();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('returns null when the connect exceeds the timeout', async () => {
    // Never-resolving connector + a tiny timeout budget → timeout rejection.
    const connect = vi.fn(() => new Promise<Browser>(() => {}));
    const out = await connectScrapingBrowser({ wss: CRED_WSS, connect, timeoutMs: 5 });
    expect(out).toBeNull();
  });
});
