/**
 * `wigolo mcp` (default) — start the MCP stdio protocol server.
 *
 * HARD invariant: this path NEVER mounts the Ink TUI. stdout is reserved for
 * the JSON-RPC protocol framing; rendering Ink would corrupt it. Only
 * init/config/dashboard/doctor --interactive mount Ink. This function exists as
 * a standalone, testable unit so a test can prove startServer is called and no
 * Ink entry point (runInkInit / runInkConfig) is ever invoked here.
 */
import { getConfig } from '../config.js';
import { startServer } from '../server.js';

export async function runMcp(): Promise<void> {
  const config = getConfig();

  try {
    const { tryConnectDaemon } = await import('../daemon/proxy.js');
    const report = await tryConnectDaemon(config.daemonPort, config.daemonHost);
    if (report) {
      process.stderr.write(
        `[wigolo] Daemon detected at ${config.daemonHost}:${config.daemonPort} ` +
          `(status: ${report.status}). Full proxy deferred to v2.1; starting local server.\n`,
      );
    }
  } catch {
    // Daemon proxy module may not be available -- fall through to local server
  }

  await startServer();
}
