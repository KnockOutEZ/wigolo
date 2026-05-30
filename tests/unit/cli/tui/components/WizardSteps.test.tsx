/**
 * Tests for the 4-step first-run wizard.
 *
 * The wizard reuses CategoryScreen for step 3 (LLM) and step 4 (Agents);
 * we drive the keyboard through ink-testing-library and assert:
 *   - all 4 step headers appear in sequence
 *   - Esc from any step lands on home (onSkip fires)
 *   - On step 4 commit (Enter / ⏎ Finish) we call propagation.save() once
 *     and installAgent() per selected agent.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { WizardSteps } from '../../../../../src/cli/tui/components/WizardSteps.js';
import { createSettingsStore } from '../../../../../src/cli/tui/state/settings-store.js';
import { CATALOG } from '../../../../../src/cli/tui/schema/catalog.js';
import type { AgentTarget } from '../../../../../src/cli/tui/state/agent-targets.js';
import type { SecretStore } from '../../../../../src/cli/tui/state/propagation.js';

vi.mock('../../../../../src/cli/tui/actions/write-config.js', () => ({
  persistKey: vi.fn().mockResolvedValue(undefined),
  writeMcpConfig: vi.fn().mockResolvedValue({ results: [], anyFailed: false }),
}));

afterEach(() => {
  cleanup();
});

const ENTER = '\r';
const ESC = '\x1b';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function silentSystemCheck() {
  return Promise.resolve({
    node: { ok: true, version: '20.0.0' },
    python: { ok: true, version: '3.11.0', binary: 'python3' as const },
    docker: { ok: false },
    disk: { ok: true, freeMb: 12345 },
    hardFailure: false,
  });
}

function makeStore() {
  return createSettingsStore({});
}

function makeSecretStore(): SecretStore {
  return {
    set: vi.fn().mockResolvedValue({ location: 'file' }),
    get: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAgentTarget(id: AgentTarget['id']): AgentTarget {
  return {
    id,
    label: id,
    configPath: `/tmp/${id}.json`,
    serverPath: ['mcpServers', 'wigolo'],
    envPath: ['mcpServers', 'wigolo', 'env'],
    detect: vi.fn().mockResolvedValue(true),
    backupDir: () => '/tmp/backups',
  };
}

describe('WizardSteps', () => {
  it('renders Step 1 / 4 Welcome on first mount', async () => {
    const { lastFrame } = render(
      <WizardSteps
        store={makeStore()}
        catalog={CATALOG}
        configPath="/tmp/config.json"
        onDone={() => {}}
        onSkip={() => {}}
        runSystemCheckImpl={silentSystemCheck}
      />,
    );
    await wait(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Step 1 / 4');
    expect(frame).toContain('Welcome');
  });

  it('advances through Welcome → System → LLM → Agents in order', async () => {
    const { stdin, lastFrame } = render(
      <WizardSteps
        store={makeStore()}
        catalog={CATALOG}
        configPath="/tmp/config.json"
        onDone={() => {}}
        onSkip={() => {}}
        runSystemCheckImpl={silentSystemCheck}
      />,
    );

    await wait(30);
    expect(lastFrame() ?? '').toContain('Step 1 / 4');

    // Step 1 → Step 2
    stdin.write(ENTER);
    await wait(40);
    expect(lastFrame() ?? '').toContain('Step 2 / 4');

    // Wait for the system check to resolve, then advance to step 3.
    await wait(60);
    stdin.write(ENTER);
    await wait(40);
    expect(lastFrame() ?? '').toContain('Step 3 / 4');

    // Step 3 (LLM) — visible hint changed from 's continue' to '⏎ continue'.
    expect(lastFrame() ?? '').toContain('⏎ continue');

    // Press Enter to advance to step 4.
    stdin.write(ENTER);
    await wait(60);
    expect(lastFrame() ?? '').toContain('Step 4 / 4');
    expect(lastFrame() ?? '').toContain('⏎ Finish');
  });

  it('Esc on the Welcome step skips to home (onSkip fires)', async () => {
    const onSkip = vi.fn();
    const { stdin } = render(
      <WizardSteps
        store={makeStore()}
        catalog={CATALOG}
        configPath="/tmp/config.json"
        onDone={() => {}}
        onSkip={onSkip}
        runSystemCheckImpl={silentSystemCheck}
      />,
    );
    await wait(30);
    stdin.write(ESC);
    await wait(40);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('Esc on the System step skips to home (onSkip fires)', async () => {
    const onSkip = vi.fn();
    const { stdin } = render(
      <WizardSteps
        store={makeStore()}
        catalog={CATALOG}
        configPath="/tmp/config.json"
        onDone={() => {}}
        onSkip={onSkip}
        runSystemCheckImpl={silentSystemCheck}
      />,
    );
    await wait(30);
    stdin.write(ENTER);
    await wait(40);
    stdin.write(ESC);
    await wait(40);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('final step calls propagation.save() once and installAgent per selected agent', async () => {
    const saveImpl = vi.fn().mockResolvedValue({
      saved: ['llmProvider'],
      propagated: [],
      failed: [],
    });
    const installImpl = vi.fn().mockResolvedValue({ ok: true });
    const onDone = vi.fn();

    // Pre-stage an agent selection in the store so step 4's "save" knows
    // what to install. We don't need to drive multiselect through the
    // keyboard for this assertion — the wizard's commit path reads from
    // the store regardless of how the value landed there.
    const store = makeStore();
    store.set('agents', ['claude-code', 'cursor']);

    const agentTargets: AgentTarget[] = [
      makeAgentTarget('claude-code'),
      makeAgentTarget('cursor'),
    ];

    const { stdin } = render(
      <WizardSteps
        store={store}
        catalog={CATALOG}
        configPath="/tmp/config.json"
        agents={agentTargets}
        secretStore={makeSecretStore()}
        onDone={onDone}
        onSkip={() => {}}
        runSystemCheckImpl={silentSystemCheck}
        saveImpl={saveImpl}
        installAgentImpl={installImpl}
      />,
    );

    // Welcome → System
    await wait(30);
    stdin.write(ENTER);
    await wait(40);
    // System → LLM (after the check resolves)
    await wait(60);
    stdin.write(ENTER);
    await wait(40);
    // LLM → Agents (Enter advances per new ⏎ continue hint)
    stdin.write(ENTER);
    await wait(60);
    // Agents → save (Enter triggers ⏎ Finish)
    stdin.write(ENTER);
    await wait(80);

    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(installImpl).toHaveBeenCalledTimes(2);
    // Each selected agent should have been targeted.
    const ids = installImpl.mock.calls.map((c) => c[0].target.id);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('cursor');
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
