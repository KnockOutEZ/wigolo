import { describe, expect, it } from 'vitest';
import { formatStatus, type StatusBag } from '../../../../src/cli/tui/status-format.js';

const baseBag: StatusBag = {
  version: '0.6.3',
  searxng: 'ready',
  flashrank: 'ok',
  trafilatura: 'ok',
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
    expect(out).toMatch(/✓ SearXNG ready/);
    expect(out).toMatch(/starts on demand/);
  });

  it('shows ✓ for installed python packages, ⊘ for missing', () => {
    const out = formatStatus({ ...baseBag, flashrank: 'ok', trafilatura: 'missing', embeddings: 'ok' });
    expect(out).toMatch(/✓ FlashRank/);
    expect(out).toMatch(/⊘ Trafilatura/);
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
    expect(failed).toMatch(/✗ SearXNG: failed/);
    const pending = formatStatus({ ...baseBag, searxng: 'pending' });
    expect(pending).toMatch(/⊘ SearXNG: not installed/);
  });
});
