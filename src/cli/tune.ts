import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getConfig } from '../config.js';
import { initDatabase, closeDatabase } from '../cache/db.js';
import {
  listDomainRouting,
  resetDomainRouting,
  resetAllDomainRouting,
  type DomainRoutingSummary,
} from '../cache/store.js';

/**
 * `wigolo tune` — inspect and reset the per-domain routing that wigolo learns
 * as it fetches: TLS-tier promotion, browser-engine escalation, anti-bot
 * clearance reuse, and polite backoff windows after repeated blocks. This is a
 * thin CLI over the cache store's routing projection — no business logic lives
 * here.
 *
 * House --json contract: stdout carries exactly ONE JSON document; every human
 * line goes to stderr so the JSON pipes cleanly through jq. Exit 0 on success,
 * 1 on failure.
 */

function out(text: string): void {
  process.stdout.write(text + '\n');
}

function human(text: string): void {
  process.stderr.write(text + '\n');
}

const USAGE = [
  'Usage: wigolo tune <list|show <domain>|reset <domain>|reset --all> [--json]',
  '',
  'wigolo self-tunes per-domain routing as it fetches: it promotes the',
  'TLS-impersonation tier, escalates to the browser engine, reuses solved',
  'anti-bot clearances, and backs off politely after repeated blocks.',
  '',
  '  list                 Show learned routing for every tracked domain',
  '  show <domain>         Show learned routing for one domain',
  '  reset <domain>        Clear learned routing for one domain',
  '  reset --all           Clear learned routing for every domain',
  '',
  '  --json                Emit a single machine-readable JSON document',
].join('\n');

/** Actionable message for a locked/busy store — no library names. */
const BUSY_HINT = 'could not read the local cache — another wigolo process may be writing to it; retry in a moment.';

function fmtBool(v: boolean): string {
  return v ? 'yes' : 'no';
}

function renderTable(rows: DomainRoutingSummary[]): string {
  const header = ['DOMAIN', 'TLS', 'BROWSER', 'TLS_HITS', 'HTTP_FAILS', 'BACKOFF', 'CLEARANCE'];
  const body = rows.map((r) => [
    r.domain,
    fmtBool(r.preferTlsImpersonation),
    fmtBool(r.preferPlaywright),
    String(r.tlsSuccessCount),
    String(r.httpFailures),
    r.backoffUntil ? 'active' : '-',
    r.clearancePresent ? `until ${r.clearanceExpiresAt ?? '?'}` : '-',
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), ...body.map(line)].join('\n');
}

function runList(useJson: boolean): number {
  const rows = listDomainRouting();
  if (useJson) {
    out(JSON.stringify({ domains: rows }));
    return 0;
  }
  if (rows.length === 0) {
    human('No per-domain routing learned yet — wigolo tunes as you fetch.');
    return 0;
  }
  human(renderTable(rows));
  return 0;
}

function runShow(domain: string | undefined, useJson: boolean): number {
  if (!domain) {
    if (useJson) out(JSON.stringify({ error: 'a domain is required' }));
    else human('Error: a domain is required. Usage: wigolo tune show <domain>');
    return 1;
  }
  const row = listDomainRouting().find((r) => r.domain === domain);
  if (!row) {
    const msg = `no learned routing for domain "${domain}"`;
    if (useJson) out(JSON.stringify({ error: msg }));
    else human(`Error: ${msg}.`);
    return 1;
  }
  if (useJson) {
    out(JSON.stringify(row));
    return 0;
  }
  human(renderTable([row]));
  return 0;
}

function runReset(domain: string | undefined, all: boolean, useJson: boolean): number {
  if (all) {
    const count = resetAllDomainRouting();
    if (useJson) out(JSON.stringify({ reset: count, scope: 'all' }));
    else human(`Reset learned routing for ${count} domain(s).`);
    return 0;
  }
  if (!domain) {
    if (useJson) out(JSON.stringify({ error: 'a domain is required (or pass --all)' }));
    else human('Error: a domain is required (or pass --all). Usage: wigolo tune reset <domain>');
    return 1;
  }
  const count = resetDomainRouting(domain);
  if (count === 0) {
    const msg = `no learned routing to reset for domain "${domain}"`;
    if (useJson) out(JSON.stringify({ domain, reset: 0, error: msg }));
    else human(`Error: ${msg}.`);
    return 1;
  }
  if (useJson) out(JSON.stringify({ domain, reset: count }));
  else human(`Reset learned routing for "${domain}".`);
  return 0;
}

export async function runTune(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    human(USAGE);
    return args.length === 0 ? 1 : 0;
  }

  const useJson = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('-'));
  const all = args.includes('--all');
  const subcommand = positional[0];

  const config = getConfig();
  mkdirSync(config.dataDir, { recursive: true });
  initDatabase(join(config.dataDir, 'wigolo.db'));

  try {
    switch (subcommand) {
      case 'list':
        return runList(useJson);
      case 'show':
        return runShow(positional[1], useJson);
      case 'reset':
        return runReset(positional[1], all, useJson);
      default:
        human(USAGE);
        return 1;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (useJson) {
      out(JSON.stringify({ error: BUSY_HINT }));
    } else {
      human(`Error: ${BUSY_HINT}`);
    }
    // Detail goes to a structured field only under --json is avoided (could
    // leak a path); keep the human channel to the actionable hint. Retain the
    // raw detail on stderr for non-json so operators can debug.
    if (!useJson) human(`  (${detail})`);
    return 1;
  } finally {
    closeDatabase();
  }
}
