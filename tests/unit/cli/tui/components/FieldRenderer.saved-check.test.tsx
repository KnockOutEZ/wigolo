/**
 * Task 3.1 — Per-field saved ✓ checkmark
 *
 * After onEditDone fires, FieldRenderer shows a transient ✓ next to the field
 * label for ~1500ms, then removes it. The animation is gated on reducedMotion().
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { FieldRenderer } from '../../../../../src/cli/tui/components/FieldRenderer.js';
import type { FieldDef } from '../../../../../src/cli/tui/schema/types.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete process.env.WIGOLO_TUI_REDUCED_MOTION;
});

const textField: FieldDef = {
  key: 'TX',
  settingsPath: 'tx',
  label: 'Greeting',
  kind: 'text',
  default: '',
};

const noop = (): void => {};

describe('FieldRenderer — saved ✓ checkmark', () => {
  it('shows ✓ immediately after savedAt becomes non-null', async () => {
    vi.useFakeTimers();
    const ts = Date.now();

    const { lastFrame, rerender } = render(
      <FieldRenderer
        field={textField}
        value="hello"
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
        savedAt={null}
      />,
    );

    // No ✓ before save
    expect(lastFrame() ?? '').not.toContain('✓');

    // Simulate save success by providing a non-null savedAt timestamp
    rerender(
      <FieldRenderer
        field={textField}
        value="hello"
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
        savedAt={ts}
      />,
    );

    // Advance 100ms — well within the 1500ms window; ✓ should be visible
    await vi.advanceTimersByTimeAsync(100);
    expect(lastFrame() ?? '').toContain('✓');
  });

  it('hides ✓ after 1500ms', async () => {
    vi.useFakeTimers();
    const ts = Date.now();

    const { lastFrame, rerender } = render(
      <FieldRenderer
        field={textField}
        value="hello"
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
        savedAt={ts}
      />,
    );

    // Before 1500ms: ✓ should be visible
    await vi.advanceTimersByTimeAsync(100);
    expect(lastFrame() ?? '').toContain('✓');

    // After 1500ms: ✓ should be gone
    await vi.advanceTimersByTimeAsync(1500);
    expect(lastFrame() ?? '').not.toContain('✓');
  });

  it('does not show ✓ when savedAt is null', async () => {
    const { lastFrame } = render(
      <FieldRenderer
        field={textField}
        value="hello"
        focused={false}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
        savedAt={null}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame() ?? '').not.toContain('✓');
  });

  it('skips ✓ when reducedMotion() is true', async () => {
    process.env.WIGOLO_TUI_REDUCED_MOTION = '1';
    const { lastFrame } = render(
      <FieldRenderer
        field={textField}
        value="hello"
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
        savedAt={Date.now()}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame() ?? '').not.toContain('✓');
  });

  it('resets ✓ if a newer savedAt arrives before expiry', async () => {
    vi.useFakeTimers();
    const ts1 = Date.now();

    const { lastFrame, rerender } = render(
      <FieldRenderer
        field={textField}
        value="hello"
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
        savedAt={ts1}
      />,
    );

    // Advance 800ms — ✓ still visible
    await vi.advanceTimersByTimeAsync(800);
    expect(lastFrame() ?? '').toContain('✓');

    // Second save arrives at 800ms mark
    const ts2 = ts1 + 800;
    rerender(
      <FieldRenderer
        field={textField}
        value="world"
        focused={true}
        editing={false}
        onChange={noop}
        onEditStart={noop}
        onEditDone={noop}
        onEditCancel={noop}
        savedAt={ts2}
      />,
    );

    // Advance another 900ms (1700ms total since ts1, but only 900ms since ts2)
    // ✓ should still be visible (ts2 window hasn't expired)
    await vi.advanceTimersByTimeAsync(900);
    expect(lastFrame() ?? '').toContain('✓');

    // Advance past ts2 + 1500ms
    await vi.advanceTimersByTimeAsync(700);
    expect(lastFrame() ?? '').not.toContain('✓');
  });
});
