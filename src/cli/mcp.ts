/**
 * `wigolo mcp` (default) — start the MCP stdio protocol server.
 *
 * HARD invariant: this path NEVER mounts the Ink TUI. stdout is reserved for
 * the JSON-RPC protocol framing; rendering Ink would corrupt it. Only
 * init/config/dashboard/doctor --interactive mount Ink. This function exists as
 * a standalone, testable unit so a test can prove the stdio control plane starts and no
 * Ink entry point (runInkInit / runInkConfig) is ever invoked here.
 */
export async function runMcp(): Promise<void> {
  // Keep stdio startup free of configuration, daemon probes, and the heavy
  // web runtime until the client invokes a tool.
  const { startStdioServer } = await import('../server/control.js');
  await startStdioServer();
}
