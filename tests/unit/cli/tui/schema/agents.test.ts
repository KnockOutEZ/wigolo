import { describe, it, expect } from 'vitest';
import { agentsCategory } from '../../../../../src/cli/tui/schema/agents.js';
import { configKeyBySettingsKey } from '../../../../../src/config.js';

/** The registry is the only place a default or an env-var name is declared. */
function registered(settingsKey: string) {
  const def = configKeyBySettingsKey(settingsKey);
  expect(def, `${settingsKey} missing from CONFIG_KEYS`).toBeDefined();
  return def!;
}


describe('agentsCategory', () => {
  it('has id agents with a non-empty label and description', () => {
    expect(agentsCategory.id).toBe('agents');
    expect(agentsCategory.label).toBeTruthy();
    expect(agentsCategory.description).toBeTruthy();
  });

  it('exposes exactly one field (the multiselect for installed agents)', () => {
    expect(agentsCategory.fields).toHaveLength(1);
    const field = agentsCategory.fields[0]!;
    expect(field.kind).toBe('multiselect');
    expect(field.settingsPath).toBe('agents');
    // No env var resolves this list, so there is no env-var name to print and
    // none to write into an agent's env block. It was printed and propagated
    // as WIGOLO_AGENTS, which nothing anywhere reads.
    expect(registered('agents').envVar).toBeNull();
    expect(field.key).toBe('agents');
    expect(field.propagateToAgents).toBe(false);
    // The old name keeps working for `--set`, which is where it was documented.
    expect(registered('agents').legacyKeys).toContain('WIGOLO_AGENTS');
  });

  it('lists exactly 5 agent options: claude-code, vscode, zed, windsurf, cursor', () => {
    const field = agentsCategory.fields[0]!;
    const values = (field.options ?? []).map((o) => o.value);
    expect(values).toEqual(['claude-code', 'vscode', 'zed', 'windsurf', 'cursor']);
  });

  it('every option has a human label', () => {
    const field = agentsCategory.fields[0]!;
    for (const opt of field.options ?? []) {
      expect(opt.label).toBeTruthy();
      // Label should not just echo the value — it's user-facing.
      expect(opt.label.length).toBeGreaterThan(opt.value.length - 1);
    }
  });

  it('default is an empty array (no agents pre-selected)', () => {
    const field = agentsCategory.fields[0]!;
    expect(Array.isArray(field.default)).toBe(true);
    expect(field.default).toEqual(registered('agents').default);
    expect(field.default).toEqual([]);
  });

  it('has help text explaining the propagation behaviour', () => {
    const field = agentsCategory.fields[0]!;
    expect(field.help).toBeTruthy();
    expect(field.help!.length).toBeGreaterThan(10);
  });
});
