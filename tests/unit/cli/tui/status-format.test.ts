import { describe, expect, it } from 'vitest';
import { formatStatus, type StatusBag } from '../../../../src/cli/tui/status-format.js';

const baseBag: StatusBag = {
  version: '0.6.3',
  browserTier: { tier: 'desktop', detail: 'this platform always has a display session', desktopComponent: 'not installed' },
  searxng: 'ready',
  reranker: 'ok',
  embeddings: 'ok',
  cache: { pages: 142, bytes: 13 * 1024 * 1024 },
  agents: [
    { id: 'claude-code', displayName: 'Claude Code', configured: true, path: '(cli)' },
    { id: 'cursor',      displayName: 'Cursor',      configured: true, path: '/h/.cursor/mcp.json' },
    { id: 'vscode',      displayName: 'VS Code',     configured: false, path: '/h/.vscode/mcp.json' },
  ],
};

describe('formatStatus', () => {
  it('starts with the version line', () => {
    const out = formatStatus(baseBag);
    expect(out.split('\n')[0]).toContain('wigolo');
    expect(out.split('\n')[0]).toContain('v0.6.3');
  });

  it('renders SearXNG ready with the "starts on demand" note', () => {
    const out = formatStatus(baseBag);
    expect(out).toMatch(/✓ Search engine ready/);
    expect(out).toMatch(/starts on demand/);
  });

  it('shows ✓ for installed python packages, ⊘ for missing', () => {
    const out = formatStatus({ ...baseBag, reranker: 'missing', embeddings: 'ok' });
    expect(out).toMatch(/⊘ ML reranker/);
    expect(out).toMatch(/✓ Embeddings/);
  });

  it('prints cache stats in human-readable MB', () => {
    const out = formatStatus({ ...baseBag, cache: { pages: 142, bytes: 13 * 1024 * 1024 } });
    expect(out).toMatch(/Cache: 142 pages, 13\.0 MB/);
  });

  it('lists only configured agents under Connected agents', () => {
    const out = formatStatus(baseBag);
    const connectedSection = out.split('Connected agents:')[1] ?? '';
    expect(connectedSection).toContain('✓ Claude Code');
    expect(connectedSection).toContain('✓ Cursor');
    expect(connectedSection).not.toContain('VS Code');
  });

  it('shows "none" when zero agents are configured', () => {
    const out = formatStatus({
      ...baseBag,
      agents: baseBag.agents.map(a => ({ ...a, configured: false })),
    });
    expect(out).toMatch(/Connected agents:\s*\n\s*\(none\)/);
  });

  it('handles searxng: "failed" and "pending" states', () => {
    const failed = formatStatus({ ...baseBag, searxng: 'failed' });
    expect(failed).toMatch(/✗ Search engine: failed/);
    const pending = formatStatus({ ...baseBag, searxng: 'pending' });
    expect(pending).toMatch(/⊘ Search engine: not installed/);
  });
});

describe('formatStatus — the D10(a) browser-session block', () => {
  const withSession: StatusBag = {
    ...baseBag,
    browserSession: {
      signedInBudget: 20,
      anonymousBudget: 300,
      bridgeAttempted: 7,
      bridgeServed: 4,
      budgetRefused: 2,
      cardShown: 1,
      cardUnattended: 3,
    },
  };

  it('is omitted entirely when the browser session has never been used — a block of zeroes for every user is noise, and a section people learn to skip is worthless the day it matters', () => {
    expect(formatStatus(baseBag)).not.toMatch(/Browser session/);
  });

  it('prints BOTH pacing lanes, because a single number would hide the split that is the only reason the tight one is acceptable', () => {
    const out = formatStatus(withSession);
    expect(out).toMatch(/20 requests per signed-in site/);
    expect(out).toMatch(/300 elsewhere/);
  });

  it('shows the escalation rate the D9 defaults are meant to be re-decided from — the whole point of collecting it is that a human can read it', () => {
    expect(formatStatus(withSession)).toMatch(/Escalations: 7 attempted, 4 served/);
  });

  it('names requests held back by pacing, so a limit that fires is never indistinguishable from a bug', () => {
    expect(formatStatus(withSession)).toMatch(/Held back by pacing: 2/);
  });

  it('reports prompts skipped with nobody attached — that count is how a user discovers their background runs are silently degrading', () => {
    expect(formatStatus(withSession)).toMatch(/3 skipped with nobody attached/);
  });

  it('states the counters never leave the machine, because a user reading their own usage numbers will reasonably wonder', () => {
    expect(formatStatus(withSession)).toMatch(/never leave this machine/);
  });

  it('hides the pacing and prompt lines when nothing was refused or prompted, keeping the block to what actually happened', () => {
    const quiet = formatStatus({ ...withSession, browserSession: { ...withSession.browserSession!, budgetRefused: 0, cardShown: 0, cardUnattended: 0 } });
    expect(quiet).toMatch(/Browser session/);
    expect(quiet).not.toMatch(/Held back by pacing/);
    expect(quiet).not.toMatch(/Sign-in prompts/);
  });
});
