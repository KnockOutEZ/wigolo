import { getConfig } from '../config.js';

function log(msg: string): void {
  process.stderr.write(`[wigolo health] ${msg}\n`);
}

export async function runHealthCheck(): Promise<number> {
  const config = getConfig();
  const host = config.daemonHost;
  const port = config.daemonPort;
  const url = `http://${host}:${port}/health`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      log(`Daemon returned HTTP ${response.status}`);
      const text = await response.text().catch(() => '');
      if (text) log(text);
      return 1;
    }

    const report = await response.json();

    log(`Status: ${report.status}`);
    log(`SearXNG: ${report.searxng}`);
    log(`Browsers: ${report.browsers}`);
    log(`Cache: ${report.cache}`);
    log(`Uptime: ${report.uptime_seconds}s`);
    log('');
    log(JSON.stringify(report, null, 2));

    return report.status === 'healthy' ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('ECONNREFUSED') || message.includes('fetch failed') || message.includes('timed out')) {
      log(`Daemon is not running at ${host}:${port}`);
      log(`Start it with: npx @staticn0va/wigolo serve`);
    } else {
      log(`Health check failed: ${message}`);
    }

    return 1;
  }
}
