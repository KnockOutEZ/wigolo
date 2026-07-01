/**
 * ImportScreen — import flow.
 *
 * Tests assert the screen:
 *   - prompts the user for a file path
 *   - rejects non-existent files with an error frame
 *   - rejects invalid JSON with an error frame
 *   - stages only schema-known keys into the store; unknown keys appear
 *     as a warning and do NOT mutate the store
 *   - returns the user to SettingsHome via onBack after staging
 *   - cancels with esc on every phase
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ImportScreen } from '../../../../../src/cli/tui/components/ImportScreen.js';
import { createSettingsStore } from '../../../../../src/cli/tui/state/settings-store.js';
import { CATALOG } from '../../../../../src/cli/tui/schema/catalog.js';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const ENTER = '\r';
const ESC = '\x1b';
const BACKSPACE = '\x7f';

const KNOWN_KEY = CATALOG[0]!.fields[0]!.settingsPath;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-import-'));
});

afterEach(() => {
  cleanup();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: type a string into stdin one char at a time.
async function typeString(
  stdin: { write: (s: string) => void },
  s: string,
): Promise<void> {
  for (const ch of s) {
    stdin.write(ch);
    await wait(2);
  }
}

// Helper: clear the default path buffer (~/wigolo-config-export.json) and
// write a fresh path. The screen pre-populates the buffer with the default
// export path; tests need to wipe it and type a tmpdir path.
async function clearDefaultBuffer(
  stdin: { write: (s: string) => void },
): Promise<void> {
  // Default buffer is 27 chars. Bias high to be safe.
  for (let i = 0; i < 50; i++) {
    stdin.write(BACKSPACE);
    await wait(2);
  }
}

describe('ImportScreen', () => {
  it('mounts on the prompt phase', () => {
    const store = createSettingsStore({});
    const { lastFrame } = render(
      <ImportScreen store={store} catalog={CATALOG} onBack={() => {}} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Import config');
    expect(frame).toContain('Path:');
  });

  it('esc on prompt phase calls onBack', async () => {
    const store = createSettingsStore({});
    const onBack = vi.fn();
    const { stdin } = render(
      <ImportScreen store={store} catalog={CATALOG} onBack={onBack} />,
    );
    await wait(20);
    stdin.write(ESC);
    await wait(30);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows an error when the file does not exist', async () => {
    const store = createSettingsStore({});
    const { stdin, lastFrame } = render(
      <ImportScreen store={store} catalog={CATALOG} onBack={() => {}} />,
    );
    await wait(20);
    await clearDefaultBuffer(stdin);
    await typeString(stdin, join(tmpDir, 'does-not-exist.json'));
    stdin.write(ENTER);
    await wait(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Import error');
    expect(frame).toContain('File not found');
    expect(store.isDirty()).toBe(false);
  });

  it('shows an error when the file is not valid JSON', async () => {
    const store = createSettingsStore({});
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, 'not json{');
    const { stdin, lastFrame } = render(
      <ImportScreen store={store} catalog={CATALOG} onBack={() => {}} />,
    );
    await wait(20);
    await clearDefaultBuffer(stdin);
    await typeString(stdin, path);
    stdin.write(ENTER);
    await wait(40);
    expect(lastFrame() ?? '').toContain('not valid JSON');
    expect(store.isDirty()).toBe(false);
  });

  it('shows unknown keys as a warning and does NOT stage them', async () => {
    const store = createSettingsStore({});
    const path = join(tmpDir, 'unknown.json');
    writeFileSync(
      path,
      JSON.stringify({
        settings: {
          totallyMadeUpKey: 'x',
          someOtherUnknown: 42,
        },
      }),
    );
    const { stdin, lastFrame } = render(
      <ImportScreen store={store} catalog={CATALOG} onBack={() => {}} />,
    );
    await wait(20);
    await clearDefaultBuffer(stdin);
    await typeString(stdin, path);
    stdin.write(ENTER);
    await wait(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('unknown key');
    expect(frame).toContain('totallyMadeUpKey');
    // No known keys → "0 known" reported, nothing staged yet.
    stdin.write('y');
    await wait(30);
    expect(store.isDirty()).toBe(false);
  });

  it('stages known keys into the store and reports the count', async () => {
    const store = createSettingsStore({});
    const path = join(tmpDir, 'good.json');
    const payload = {
      settings: {
        [KNOWN_KEY]: 'imported-value',
        unknownKey: 'ignored',
      },
    };
    writeFileSync(path, JSON.stringify(payload));
    const { stdin, lastFrame } = render(
      <ImportScreen store={store} catalog={CATALOG} onBack={() => {}} />,
    );
    await wait(20);
    await clearDefaultBuffer(stdin);
    await typeString(stdin, path);
    stdin.write(ENTER);
    await wait(40);
    const reviewFrame = lastFrame() ?? '';
    expect(reviewFrame).toContain('1 known key');
    expect(reviewFrame).toContain('unknown key');
    // Confirm staging.
    stdin.write('y');
    await wait(30);
    expect(store.isDirty()).toBe(true);
    expect(store.dirtyKeys()).toContain(KNOWN_KEY);
    expect(store.getPending()[KNOWN_KEY]).toBe('imported-value');
    // Done frame surfaces the staged count.
    expect(lastFrame() ?? '').toContain('Staged 1 pending');
  });

  it('accepts a flat { key: value } file in addition to the envelope shape', async () => {
    const store = createSettingsStore({});
    const path = join(tmpDir, 'flat.json');
    writeFileSync(path, JSON.stringify({ [KNOWN_KEY]: 'flat-value' }));
    const { stdin, lastFrame } = render(
      <ImportScreen store={store} catalog={CATALOG} onBack={() => {}} />,
    );
    await wait(20);
    await clearDefaultBuffer(stdin);
    await typeString(stdin, path);
    stdin.write(ENTER);
    await wait(40);
    expect(lastFrame() ?? '').toContain('1 known key');
    stdin.write('y');
    await wait(30);
    expect(store.getPending()[KNOWN_KEY]).toBe('flat-value');
  });

  it('returns to SettingsHome via onBack from the done frame', async () => {
    const store = createSettingsStore({});
    const path = join(tmpDir, 'good.json');
    writeFileSync(path, JSON.stringify({ [KNOWN_KEY]: 'v' }));
    const onBack = vi.fn();
    const { stdin } = render(
      <ImportScreen store={store} catalog={CATALOG} onBack={onBack} />,
    );
    await wait(20);
    await clearDefaultBuffer(stdin);
    await typeString(stdin, path);
    stdin.write(ENTER);
    await wait(40);
    stdin.write('y');
    await wait(30);
    stdin.write(ESC);
    await wait(30);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('cancels with n on the review phase without staging', async () => {
    const store = createSettingsStore({});
    const path = join(tmpDir, 'good.json');
    writeFileSync(path, JSON.stringify({ [KNOWN_KEY]: 'v' }));
    const onBack = vi.fn();
    const { stdin } = render(
      <ImportScreen store={store} catalog={CATALOG} onBack={onBack} />,
    );
    await wait(20);
    await clearDefaultBuffer(stdin);
    await typeString(stdin, path);
    stdin.write(ENTER);
    await wait(40);
    stdin.write('n');
    await wait(30);
    expect(store.isDirty()).toBe(false);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('retries from the error frame with enter, returning to prompt', async () => {
    const store = createSettingsStore({});
    const { stdin, lastFrame } = render(
      <ImportScreen store={store} catalog={CATALOG} onBack={() => {}} />,
    );
    await wait(20);
    await clearDefaultBuffer(stdin);
    await typeString(stdin, join(tmpDir, 'missing.json'));
    stdin.write(ENTER);
    await wait(30);
    expect(lastFrame() ?? '').toContain('Import error');
    stdin.write(ENTER);
    await wait(30);
    // Back on the prompt phase.
    expect(lastFrame() ?? '').toContain('Import config');
    expect(lastFrame() ?? '').toContain('Path:');
  });
});
