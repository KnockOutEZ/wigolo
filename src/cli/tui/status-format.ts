import type { ConnectedAgent } from './status-agents.js';

export interface StatusBag {
  version: string;
  /**
   * D-S10-9: the resolved browser rung, always present. Unlike the escalation counters below
   * this is NOT hidden until it has been used — the whole point is that a machine which
   * resolved to a weaker rung finds out before a fetch quietly underperforms on it.
   */
  browserTier: { tier: string; detail: string; ceiling?: string; remedy?: string; desktopComponent: string };
  searxng: 'ready' | 'failed' | 'pending';
  reranker: 'ok' | 'missing';
  embeddings: 'ok' | 'missing';
  cache: { pages: number; bytes: number };
  agents: ConnectedAgent[];
  /**
   * D10(a) escalation counters. LOCAL ONLY — read from this machine's own data dir, never sent anywhere.
   * Absent when the browser session has never been used, so `status` stays quiet for everyone else.
   */
  browserSession?: {
    signedInBudget: number;
    anonymousBudget: number;
    bridgeAttempted: number;
    bridgeServed: number;
    budgetRefused: number;
    cardShown: number;
    cardUnattended: number;
  };
  /**
   * D-S10-4 tier-occupancy counters, for the tier this host is CURRENTLY resolved to.
   *
   * Optional for the same reason `browserSession` is: a fresh install has nothing to say here,
   * and a block of zeroes printed for everyone is the kind of section that gets skipped by the
   * time it finally carries something. Only the current tier's row is carried — `doctor` is
   * where a machine whose tier has changed sees both.
   */
  rungsUsed?: {
    http: number;
    tls: number;
    browser: number;
    substrate: number;
    browserUnavailable: number;
    blocked: number;
  };
}

export function formatStatus(bag: StatusBag): string {
  const lines: string[] = [];
  lines.push(`wigolo v${bag.version}`);

  switch (bag.searxng) {
    case 'ready':
      lines.push('✓ Search engine ready (not running — starts on demand)');
      break;
    case 'failed':
      lines.push('✗ Search engine: failed (see `wigolo doctor`)');
      break;
    case 'pending':
      lines.push('⊘ Search engine: not installed (run `wigolo warmup`)');
      break;
  }

  lines.push(line('ML reranker',      bag.reranker));
  lines.push(line('Embeddings',  bag.embeddings));
  lines.push(`  Cache: ${bag.cache.pages} pages, ${formatBytes(bag.cache.bytes)}`);

  lines.push('');
  lines.push('Browser tier:');
  lines.push(`  Resolved: ${bag.browserTier.tier} — ${bag.browserTier.detail}`);
  lines.push(`  Desktop component: ${bag.browserTier.desktopComponent}`);
  if (bag.browserTier.ceiling) lines.push(`  Ceiling: ${bag.browserTier.ceiling}`);
  if (bag.browserTier.remedy) lines.push(`  Remedy: ${bag.browserTier.remedy}`);

  if (bag.rungsUsed) {
    const r = bag.rungsUsed;
    lines.push(
      `  Rungs used: ${r.http} direct, ${r.tls} hardened, ${r.browser} browser engine,` +
        ` ${r.substrate} attended session`,
    );
    if (r.browserUnavailable > 0) {
      lines.push(`  Needed a browser engine this machine could not start: ${r.browserUnavailable}`);
    }
    if (r.blocked > 0) lines.push(`  Ended at a bot-protection challenge: ${r.blocked}`);
    lines.push('  These counters never leave this machine.');
  }

  if (bag.browserSession) {
    const b = bag.browserSession;
    lines.push('');
    lines.push('Browser session:');
    lines.push(`  Pacing: ${b.signedInBudget} requests per signed-in site, ${b.anonymousBudget} elsewhere, per session`);
    lines.push(`  Escalations: ${b.bridgeAttempted} attempted, ${b.bridgeServed} served`);
    if (b.budgetRefused > 0) lines.push(`  Held back by pacing: ${b.budgetRefused}`);
    if (b.cardShown + b.cardUnattended > 0) {
      lines.push(`  Sign-in prompts: ${b.cardShown} shown, ${b.cardUnattended} skipped with nobody attached`);
    }
    lines.push('  These counters never leave this machine.');
  }

  lines.push('');
  lines.push('Connected agents:');
  const connected = bag.agents.filter(a => a.configured);
  if (connected.length === 0) {
    lines.push('  (none)');
  } else {
    for (const a of connected) lines.push(`  ✓ ${a.displayName}`);
  }

  return lines.join('\n') + '\n';
}

function line(label: string, state: 'ok' | 'missing'): string {
  if (state === 'ok') return `✓ ${label} installed`;
  return `⊘ ${label} not installed`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
