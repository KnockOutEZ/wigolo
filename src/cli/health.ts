import { getConfig } from '../config.js';

function log(msg: string): void {
  process.stderr.write(`[wigolo health] ${msg}\n`);
}

export async function runHealthCheck(args: string[] = []): Promise<number> {
  const json = args.includes('--json');
  const config = getConfig();
  const host = config.daemonHost;
  const port = config.daemonPort;
  const url = `http://${host}:${port}/health`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (json) {
        // Best-effort parse the daemon body; fall back to a minimal shape.
        let body: unknown;
        try { body = JSON.parse(text); } catch { body = { status: 'down', http_status: response.status }; }
        process.stdout.write(`${JSON.stringify(body)}\n`);
        return 1;
      }
      log(`Daemon returned HTTP ${response.status}`);
      if (text) log(text);
      return 1;
    }

    const report = await response.json();

    if (json) {
      // Machine shape on stdout; the human summary stays on stderr.
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return report.status === 'healthy' ? 0 : 1;
    }

    log(`Status: ${report.status}`);
    log(`Search engine: ${report.searxng}`);
    log(`Browsers: ${report.browsers}`);
    log(`Cache: ${report.cache}`);
    log(`Uptime: ${report.uptime_seconds}s`);
    log('');
    log(JSON.stringify(report, null, 2));

    return report.status === 'healthy' ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (json) {
      process.stdout.write(`${JSON.stringify({ status: 'down', error: message })}\n`);
      return 1;
    }

    if (message.includes('ECONNREFUSED') || message.includes('fetch failed') || message.includes('timed out')) {
      log(`Daemon is not running at ${host}:${port}`);
      log(`Start it with: npx wigolo serve`);
    } else {
      log(`Health check failed: ${message}`);
    }

    return 1;
  }
}
