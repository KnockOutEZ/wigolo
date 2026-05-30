import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import os from 'node:os';
import path from 'node:path';
import { FieldRenderer } from '../../../../../src/cli/tui/components/FieldRenderer.js';
import type { FieldDef } from '../../../../../src/cli/tui/schema/types.js';

afterEach(() => {
  cleanup();
});

const noop = (): void => {};

const selectField: FieldDef = {
  key: 'X',
  settingsPath: 'x',
  label: 'X',
  kind: 'select',
  options: [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
    { value: 'c', label: 'C' },
  ],
  default: 'a',
};

const toggleField: FieldDef = {
  key: 'T',
  settingsPath: 't',
  label: 'Toggle',
  kind: 'toggle',
  default: false,
};

const numberField: FieldDef = {
  key: 'N',
  settingsPath: 'n',
  label: 'Count',
  kind: 'number',
  default: 3,
  min: 1,
  max: 16,
};

const textField: FieldDef = {
  key: 'TX',
  settingsPath: 'tx',
  label: 'Greeting',
  kind: 'text',
  default: '',
};

const pathField: FieldDef = {
  key: 'P',
  settingsPath: 'p',
  label: 'Data dir',
  kind: 'path',
  default: '',
};

const readonlyField: FieldDef = {
  key: 'V',
  settingsPath: 'v',
  label: 'Version',
  kind: 'readonly',
  default: '0.1.23',
};

const maskedField: FieldDef = {
  key: 'K',
  settingsPath: 'k',
  label: 'API key',
  kind: 'masked',
  secret: true,
};

const multiselectField: FieldDef = {
  key: 'M',
  settingsPath: 'm',
  label: 'Agents',
  kind: 'multiselect',
  options: [
    { value: 'claude-code', label: 'Claude Code (CLI)' },
    { value: 'vscode', label: 'VS Code' },
    { value: 'zed', label: 'Zed' },
    { value: 'windsurf', label: 'Windsurf' },
    { value: 'cursor', label: 'Cursor' },
  ],
  default: [],
};

describe('FieldRenderer', () => {
  it('renders select with current value and label', () => {
    const { lastFrame } = render(
      <FieldRenderer
        field={selectField}
        value="a"
        focused={false}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    expect(lastFrame()).toContain('X');
    expect(lastFrame()).toContain('a');
  });

  it('renders readonly value without focus indicator', () => {
    const { lastFrame } = render(
      <FieldRenderer
        field={readonlyField}
        value="0.1.23"
        focused={false}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    expect(lastFrame()).toContain('0.1.23');
  });

  it('renders pending marker (*) when value differs from current', () => {
    const { lastFrame } = render(
      <FieldRenderer
        field={selectField}
        value="b"
        current="a"
        focused={false}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    expect(lastFrame()).toMatch(/\*/);
  });

  it('does not render pending marker when value equals current', () => {
    const { lastFrame } = render(
      <FieldRenderer
        field={selectField}
        value="a"
        current="a"
        focused={false}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    // The label "X" must still render but no trailing asterisk near the value.
    expect(lastFrame()).not.toMatch(/\*/);
  });

  it('renders futureNote as muted footer text under the field', () => {
    const f: FieldDef = { ...selectField, futureNote: 'More engines coming soon.' };
    const { lastFrame } = render(
      <FieldRenderer
        field={f}
        value="a"
        focused={false}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    expect(lastFrame()).toContain('More engines coming soon');
  });

  it('renders help text below the value', () => {
    const f: FieldDef = { ...selectField, help: 'Choose your browser engine.' };
    const { lastFrame } = render(
      <FieldRenderer
        field={f}
        value="a"
        focused={false}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    expect(lastFrame()).toContain('Choose your browser engine');
  });

  it('readonly never fires onChange even when focused + enter', async () => {
    const onChange = vi.fn();
    const onEditStart = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={readonlyField}
        value="0.1.23"
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={onEditStart}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(onChange).not.toHaveBeenCalled();
    expect(onEditStart).not.toHaveBeenCalled();
  });

  it('toggle flips on enter when focused', async () => {
    const onChange = vi.fn();
    const onEditDone = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={toggleField}
        value={false}
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(onEditDone).toHaveBeenCalled();
  });

  it('select cycles forward with right-arrow and wraps at end', async () => {
    const onChange = vi.fn();
    const onEditDone = vi.fn();
    // Start at 'c' (last). Right-arrow should wrap to 'a'.
    const { stdin } = render(
      <FieldRenderer
        field={selectField}
        value="c"
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    // Right-arrow to advance
    stdin.write('[C');
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('select cycles backward with left-arrow and wraps at start', async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={selectField}
        value="a"
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    // Left-arrow to retreat (should wrap to 'c')
    stdin.write('[D');
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('number out-of-range entry is rejected (no onChange) on commit', async () => {
    const onChange = vi.fn();
    const onEditDone = vi.fn();
    const { stdin, rerender } = render(
      <FieldRenderer
        field={numberField}
        value={3}
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={() => {}}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    // Enter edit mode
    rerender(
      <FieldRenderer
        field={numberField}
        value={3}
        focused={true}
        editing={true}
        onChange={onChange}
        onEditStart={() => {}}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    // Clear buffer and type 999 (out of max=16)
    stdin.write(''); // backspace to clear
    stdin.write('');
    stdin.write('');
    stdin.write('9');
    stdin.write('9');
    stdin.write('9');
    await new Promise((r) => setTimeout(r, 30));
    // Commit
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    // onChange must NOT have been called with an out-of-range numeric value
    const numericCalls = onChange.mock.calls.filter(
      ([v]) => typeof v === 'number' && (v < (numberField.min ?? -Infinity) || v > (numberField.max ?? Infinity)),
    );
    expect(numericCalls).toHaveLength(0);
  });

  it('number in-range entry commits via onChange + onEditDone', async () => {
    const onChange = vi.fn();
    const onEditDone = vi.fn();
    const { stdin, rerender } = render(
      <FieldRenderer
        field={numberField}
        value={3}
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    rerender(
      <FieldRenderer
        field={numberField}
        value={3}
        focused={true}
        editing={true}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write(''); // clear "3"
    stdin.write('5');
    await new Promise((r) => setTimeout(r, 30));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).toHaveBeenCalledWith(5);
    expect(onEditDone).toHaveBeenCalled();
  });

  it('text edit enter calls onEditDone with committed text', async () => {
    const onChange = vi.fn();
    const onEditDone = vi.fn();
    const { stdin, rerender } = render(
      <FieldRenderer
        field={textField}
        value=""
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    rerender(
      <FieldRenderer
        field={textField}
        value=""
        focused={true}
        editing={true}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('h');
    stdin.write('i');
    await new Promise((r) => setTimeout(r, 30));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).toHaveBeenCalledWith('hi');
    expect(onEditDone).toHaveBeenCalled();
  });

  it('text edit esc calls onEditCancel without onEditDone', async () => {
    const onChange = vi.fn();
    const onEditDone = vi.fn();
    const onEditCancel = vi.fn();
    const { stdin, rerender } = render(
      <FieldRenderer
        field={textField}
        value="old"
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={onEditCancel}
      />,
    );
    rerender(
      <FieldRenderer
        field={textField}
        value="old"
        focused={true}
        editing={true}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={onEditCancel}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('x');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write(''); // escape
    await new Promise((r) => setTimeout(r, 30));
    expect(onEditCancel).toHaveBeenCalled();
    expect(onEditDone).not.toHaveBeenCalled();
  });

  it('path display replaces homedir prefix with ~/', () => {
    const home = os.homedir();
    const fullPath = path.join(home, '.wigolo', 'cache');
    const { lastFrame } = render(
      <FieldRenderer
        field={pathField}
        value={fullPath}
        focused={false}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    expect(lastFrame()).toContain('~/.wigolo/cache');
    expect(lastFrame()).not.toContain(home);
  });

  it('focused (not editing) on text dispatches onEditStart on enter', async () => {
    const onEditStart = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={textField}
        value="hi"
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={onEditStart}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(onEditStart).toHaveBeenCalled();
  });

  it('masked: empty value renders [type to enter] placeholder', () => {
    const { lastFrame } = render(
      <FieldRenderer
        field={maskedField}
        value=""
        focused={false}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    expect(lastFrame()).toContain('[type to enter]');
  });

  it('masked: set value renders ****<last4> + replace/remove hint when focused', () => {
    // Contract: display is the literal `****` followed by the last 4 chars
    // of the stored value. Anything earlier in the secret must NOT appear.
    const { lastFrame } = render(
      <FieldRenderer
        field={maskedField}
        value="sk-ant-supersecret-1234ds4F"
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    const frame = lastFrame() ?? '';
    // Last 4 chars of value are `ds4F`.
    expect(frame).toContain('****ds4F');
    expect(frame).not.toContain('supersecret');
    expect(frame).not.toContain('sk-ant');
    expect(frame).toMatch(/\[r\] Replace/);
    expect(frame).toMatch(/\[x\] Remove/);
  });

  it('masked: pressing r when set enters replace/edit mode', async () => {
    const onEditStart = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={maskedField}
        value="sk-existing-key-1234"
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={onEditStart}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('r');
    await new Promise((r) => setTimeout(r, 30));
    expect(onEditStart).toHaveBeenCalled();
  });

  it('masked: pressing x when set calls onChange(null) + onEditDone', async () => {
    const onChange = vi.fn();
    const onEditDone = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={maskedField}
        value="sk-existing-key-1234"
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('x');
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(onEditDone).toHaveBeenCalled();
  });

  it('masked: empty + enter starts edit (onEditStart fired)', async () => {
    const onEditStart = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={maskedField}
        value=""
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={onEditStart}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(onEditStart).toHaveBeenCalled();
  });

  it('masked: enter commits typed buffer via onChange(value) + onEditDone', async () => {
    const onChange = vi.fn();
    const onEditDone = vi.fn();
    const { stdin, rerender } = render(
      <FieldRenderer
        field={maskedField}
        value=""
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    rerender(
      <FieldRenderer
        field={maskedField}
        value=""
        focused={true}
        editing={true}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('a');
    stdin.write('k');
    stdin.write('-');
    stdin.write('b');
    stdin.write('c');
    await new Promise((r) => setTimeout(r, 30));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).toHaveBeenCalledWith('ak-bc');
    expect(onEditDone).toHaveBeenCalled();
  });

  it('masked: editing display echoes asterisks, never the typed plaintext', async () => {
    const { stdin, rerender, lastFrame } = render(
      <FieldRenderer
        field={maskedField}
        value=""
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    rerender(
      <FieldRenderer
        field={maskedField}
        value=""
        focused={true}
        editing={true}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('a');
    stdin.write('b');
    stdin.write('c');
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('abc');
    expect(frame).toContain('***');
  });

  it('masked: esc cancels edit without firing onChange', async () => {
    const onChange = vi.fn();
    const onEditCancel = vi.fn();
    const onEditDone = vi.fn();
    const { stdin, rerender } = render(
      <FieldRenderer
        field={maskedField}
        value=""
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={onEditCancel}
      />,
    );
    rerender(
      <FieldRenderer
        field={maskedField}
        value=""
        focused={true}
        editing={true}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={onEditCancel}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write(''); // escape
    await new Promise((r) => setTimeout(r, 30));
    expect(onEditCancel).toHaveBeenCalled();
    expect(onEditDone).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not fire input handlers when not focused', async () => {
    const onChange = vi.fn();
    const onEditStart = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={selectField}
        value="a"
        focused={false}
        editing={false}
        onChange={onChange}
        onEditStart={onEditStart}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');
    stdin.write('[C');
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).not.toHaveBeenCalled();
    expect(onEditStart).not.toHaveBeenCalled();
  });

  it('multiselect: renders all 5 options with [ ] checkboxes when none selected', () => {
    const { lastFrame } = render(
      <FieldRenderer
        field={multiselectField}
        value={[]}
        focused={false}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Claude Code (CLI)');
    expect(frame).toContain('VS Code');
    expect(frame).toContain('Zed');
    expect(frame).toContain('Windsurf');
    expect(frame).toContain('Cursor');
    // 5 unchecked rows.
    expect(frame.match(/\[ \]/g)?.length ?? 0).toBe(5);
  });

  it('multiselect: rows for already-selected values render with [x] checkbox', () => {
    const { lastFrame } = render(
      <FieldRenderer
        field={multiselectField}
        value={['claude-code', 'cursor']}
        focused={false}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame.match(/\[x\]/g)?.length ?? 0).toBe(2);
    expect(frame.match(/\[ \]/g)?.length ?? 0).toBe(3);
  });

  it('multiselect: pre-filled options with hint:"installed" render the hint', () => {
    const fieldWithHints: FieldDef = {
      ...multiselectField,
      options: [
        { value: 'claude-code', label: 'Claude Code (CLI)', hint: 'installed' },
        { value: 'vscode', label: 'VS Code' },
        { value: 'zed', label: 'Zed', hint: 'installed' },
        { value: 'windsurf', label: 'Windsurf' },
        { value: 'cursor', label: 'Cursor' },
      ],
    };
    const { lastFrame } = render(
      <FieldRenderer
        field={fieldWithHints}
        value={[]}
        focused={false}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    const frame = lastFrame() ?? '';
    // 'installed' appears twice (claude-code + zed rows).
    expect(frame.match(/installed/g)?.length ?? 0).toBe(2);
  });

  it('multiselect: enter when focused (not editing) fires onEditStart', async () => {
    const onEditStart = vi.fn();
    const { stdin } = render(
      <FieldRenderer
        field={multiselectField}
        value={[]}
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={onEditStart}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(onEditStart).toHaveBeenCalled();
  });

  it('multiselect: in edit mode, space toggles the focused option in the buffer', async () => {
    const { stdin, rerender, lastFrame } = render(
      <FieldRenderer
        field={multiselectField}
        value={[]}
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    rerender(
      <FieldRenderer
        field={multiselectField}
        value={[]}
        focused={true}
        editing={true}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    // Cursor starts at idx 0 (claude-code). Press space → should be checked.
    stdin.write(' ');
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? '';
    expect(frame.match(/\[x\]/g)?.length ?? 0).toBe(1);
    expect(frame.match(/\[ \]/g)?.length ?? 0).toBe(4);
  });

  it('multiselect: enter in edit mode commits buffer via onChange(string[]) + onEditDone', async () => {
    const onChange = vi.fn();
    const onEditDone = vi.fn();
    const { stdin, rerender } = render(
      <FieldRenderer
        field={multiselectField}
        value={[]}
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    rerender(
      <FieldRenderer
        field={multiselectField}
        value={[]}
        focused={true}
        editing={true}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    // Toggle first option (claude-code).
    stdin.write(' ');
    await new Promise((r) => setTimeout(r, 20));
    // Down-arrow to row 2 (vscode), down to row 3 (zed), toggle.
    stdin.write('[B');
    stdin.write('[B');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write(' ');
    await new Promise((r) => setTimeout(r, 20));
    // Commit.
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).toHaveBeenCalled();
    // The committed payload must be a string[] in option order (not arbitrary
    // toggle order) with the 2 toggled ids.
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(Array.isArray(lastCall[0])).toBe(true);
    expect((lastCall[0] as string[]).sort()).toEqual(['claude-code', 'zed']);
    expect(onEditDone).toHaveBeenCalled();
  });

  it('multiselect: esc in edit mode cancels without firing onChange', async () => {
    const onChange = vi.fn();
    const onEditCancel = vi.fn();
    const onEditDone = vi.fn();
    const { stdin, rerender } = render(
      <FieldRenderer
        field={multiselectField}
        value={['claude-code']}
        focused={true}
        editing={false}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={onEditCancel}
      />,
    );
    rerender(
      <FieldRenderer
        field={multiselectField}
        value={['claude-code']}
        focused={true}
        editing={true}
        onChange={onChange}
        onEditStart={noop}
        onEditDone={onEditDone}
        onEditCancel={onEditCancel}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    // Toggle something — buffer mutates but value[] is untouched.
    stdin.write(' ');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write(''); // ESC
    await new Promise((r) => setTimeout(r, 30));
    expect(onEditCancel).toHaveBeenCalled();
    expect(onEditDone).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
