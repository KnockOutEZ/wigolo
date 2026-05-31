/**
 * Fix B regression test: pressing Enter on a select field while NOT in editing
 * mode must be a complete no-op. The bug: `key.return && !editing` was included
 * in the rightArrow branch, causing Enter to silently cycle the value and call
 * onEditDone — both wrong.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { FieldRenderer } from '../../../../../src/cli/tui/components/FieldRenderer.js';
import type { FieldDef } from '../../../../../src/cli/tui/schema/types.js';

afterEach(() => {
  cleanup();
});

const noop = (): void => {};

const selectField: FieldDef = {
  key: 'PROV',
  settingsPath: 'llmProvider',
  label: 'Provider',
  kind: 'select',
  options: [
    { value: 'anthropic', label: 'Anthropic (Claude)' },
    { value: 'openai', label: 'OpenAI (GPT)' },
    { value: 'gemini', label: 'Google Gemini' },
  ],
  default: 'anthropic',
};

describe('FieldRenderer select — Enter key is a no-op (Fix B)', () => {
  it('Enter on a select field while not editing does NOT call onChange', async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={selectField}
        value="anthropic"
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Enter on a select field while not editing does NOT call onEditDone', async () => {
    const onEditDone = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={selectField}
        value="anthropic"
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(onEditDone).not.toHaveBeenCalled();
  });

  it('right-arrow still cycles normally on a select field', async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={selectField}
        value="anthropic"
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\x1b[C'); // right-arrow
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).toHaveBeenCalledWith('openai');
  });

  it('left-arrow still cycles backward on a select field', async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={selectField}
        value="openai"
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\x1b[D'); // left-arrow
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).toHaveBeenCalledWith('anthropic');
  });
});

describe('FieldRenderer toggle — Enter flips value (intentional asymmetry with select)', () => {
  it('Enter on toggle flips the value (intentional — unlike select)', async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={{ key: 'headless', settingsPath: 'headless', label: 'Headless', kind: 'toggle', default: false }}
        value={false}
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r'); // Enter
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('Enter on toggle flips from true to false', async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={{ key: 'headless', settingsPath: 'headless', label: 'Headless', kind: 'toggle', default: true }}
        value={true}
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r'); // Enter
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
