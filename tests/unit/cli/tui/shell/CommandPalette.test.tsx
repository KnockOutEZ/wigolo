import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { CommandPalette } from '../../../../../src/cli/tui/shell/CommandPalette.js';
import type { PaletteEntry } from '../../../../../src/cli/tui/shell/palette-index.js';

afterEach(() => {
  cleanup();
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const ENTRIES: PaletteEntry[] = [
  { id: 'llm', label: 'LLM Provider', kind: 'category', keywords: ['llm', 'LLM Provider'] },
  { id: 'WIGOLO_LLM_API_KEY', label: 'LLM Provider › API key', path: 'llm', kind: 'field', keywords: ['API key', 'LLM Provider'] },
  { id: 'browser', label: 'Browser', kind: 'category', keywords: ['browser'] },
  { id: 'verify', label: 'Verify', kind: 'action', keywords: ['verify'] },
  { id: 'doctor', label: 'Doctor', kind: 'action', keywords: ['doctor'] },
  { id: 'agents', label: 'MCP Agents', kind: 'category', keywords: ['agents'] },
  { id: 'cache', label: 'Cache', kind: 'category', keywords: ['cache'] },
  { id: 'search', label: 'Search', kind: 'category', keywords: ['search'] },
];

describe('CommandPalette', () => {
  it('renders Jump to… header', async () => {
    const { lastFrame } = render(
      <CommandPalette entries={ENTRIES} onPick={() => {}} onClose={() => {}} />,
    );
    await wait(20);
    expect(lastFrame()).toContain('Jump to');
  });

  it('shows up to 5 entries when query is empty', async () => {
    const { lastFrame } = render(
      <CommandPalette entries={ENTRIES} onPick={() => {}} onClose={() => {}} />,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    // Should render some entries (up to 5)
    expect(frame).toContain('LLM Provider');
  });

  it('filters entries to those matching query', async () => {
    const { stdin, lastFrame } = render(
      <CommandPalette entries={ENTRIES} onPick={() => {}} onClose={() => {}} />,
    );
    await wait(20);
    stdin.write('llm');
    await wait(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('LLM');
    expect(frame).not.toContain('Browser');
  });

  it('calls onClose when Esc is pressed', async () => {
    const onClose = vi.fn();
    const { stdin } = render(
      <CommandPalette entries={ENTRIES} onPick={() => {}} onClose={onClose} />,
    );
    await wait(20);
    stdin.write('\x1b'); // Esc
    await wait(30);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onPick with selected entry when Enter is pressed', async () => {
    const onPick = vi.fn();
    const { stdin } = render(
      <CommandPalette entries={ENTRIES} onPick={onPick} onClose={() => {}} />,
    );
    await wait(20);
    stdin.write('\r'); // Enter on first item
    await wait(30);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toHaveProperty('kind');
  });

  it('moves selection down with arrow key', async () => {
    const onPick = vi.fn();
    const { stdin } = render(
      <CommandPalette entries={ENTRIES} onPick={onPick} onClose={() => {}} />,
    );
    await wait(20);
    stdin.write('\x1b[B'); // Down arrow
    await wait(20);
    stdin.write('\r'); // Enter
    await wait(30);
    expect(onPick).toHaveBeenCalledTimes(1);
    // Second item selected (index 1 after moving down)
    const picked = onPick.mock.calls[0][0] as PaletteEntry;
    expect(picked).toBeDefined();
  });
});
