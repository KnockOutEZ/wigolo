export function runHealthCheck(): void {
  process.stderr.write('[wigolo] Health check: Coming in v2\n');
  process.stderr.write('[wigolo] Daemon mode is required for health checks.\n');
}
