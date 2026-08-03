import type { ConnectedAgent } from './status-agents.js';

export interface StatusBag {
  version: string;
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
