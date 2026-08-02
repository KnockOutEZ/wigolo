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

const { saveInitConfigMock } = vi.hoisted(() => ({ saveInitConfigMock: vi.fn() }));
vi.mock('../../../../../src/cli/tui/utils/config-writer.js', () => ({
  saveInitConfig: saveInitConfigMock,
  readInitConfig: vi.fn(() => ({})),
}));

afterEach(() => {
  cleanup();
  saveInitConfigMock.mockClear();
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

    // Step 1 → Step 2 (Enter on Welcome's Begin row)
    stdin.write(ENTER);
    await wait(40);
    expect(lastFrame() ?? '').toContain('Step 2 / 4');

    // Wait for the system check to resolve, then advance to step 3 via Continue row.
    await wait(60);
    stdin.write(ENTER);
    await wait(40);
    expect(lastFrame() ?? '').toContain('Step 3 / 4');

    // Step 3 (LLM) — updated hint text shows navigation cue.
    expect(lastFrame() ?? '').toContain('↓ to Continue');

    // LLM category has 2 fields (Provider, API key). Navigate past both to Continue row.
    stdin.write('\x1b[B'); // ↓ field 0 → field 1
    await wait(25);
    stdin.write('\x1b[B'); // ↓ field 1 → Continue
    await wait(25);
    stdin.write(ENTER);   // Enter on Continue → advance to step 4
    await wait(60);
    expect(lastFrame() ?? '').toContain('Step 4 / 4');
    expect(lastFrame() ?? '').toContain('Finish');
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

    // Welcome → System (Enter on Begin row)
    await wait(30);
    stdin.write(ENTER);
    await wait(40);
    // System → LLM (after check resolves, Enter on Continue row)
    await wait(60);
    stdin.write(ENTER);
    await wait(40);
    // LLM has 2 fields; navigate past them to Continue row, then Enter.
    stdin.write('\x1b[B'); // ↓ → field 1
    await wait(25);
    stdin.write('\x1b[B'); // ↓ → Continue
    await wait(25);
    stdin.write(ENTER);    // Enter on Continue → step 4
    await wait(60);
    // Agents category has a multiselect field; navigate to Finish row (1 field).
    stdin.write('\x1b[B'); // ↓ → Finish
    await wait(25);
    stdin.write(ENTER);    // Enter on Finish → save
    await wait(80);
    // Save+install complete; ceremony screen is now showing.
    // Press Enter to dismiss the Setup complete ceremony.
    stdin.write(ENTER);
    await wait(40);

    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(installImpl).toHaveBeenCalledTimes(2);
    // Each selected agent should have been targeted.
    const ids = installImpl.mock.calls.map((c) => c[0].target.id);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('cursor');
    expect(onDone).toHaveBeenCalledTimes(1);

    // The wizard persists the selected agents into the init-config so runInit's
    // wizard branch can read them back and install skills. This is the hand-off
    // seam between the Ink shell and the shared skills engine.
    expect(saveInitConfigMock).toHaveBeenCalled();
    const payload = saveInitConfigMock.mock.calls.at(-1)?.[1] as { configuredAgents: string[] };
    expect(payload.configuredAgents.sort()).toEqual(['claude-code', 'cursor']);
  });

  // Bug #105 — install state was detected once and never refreshed, so the
  // agents multiselect showed stale checkboxes/hints until restart. The wizard
  // must re-run detection after the install loop completes.
  it('re-detects agent install state after finishing (no stale checkbox until restart)', async () => {
    const saveImpl = vi.fn().mockResolvedValue({ saved: [], propagated: [], failed: [] });
    const installImpl = vi.fn().mockResolvedValue({ ok: true });

    const store = makeStore();
    store.set('agents', ['claude-code']);

    // detect() starts false (not yet installed) and flips true once install
    // has run, mirroring how a real config-file probe behaves post-write.
    let installed = false;
    const target: AgentTarget = {
      id: 'claude-code',
      label: 'claude-code',
      configPath: '/tmp/claude-code.json',
      serverPath: ['mcpServers', 'wigolo'],
      envPath: ['mcpServers', 'wigolo', 'env'],
      detect: vi.fn().mockImplementation(() => Promise.resolve(installed)),
      backupDir: () => '/tmp/backups',
    };
    const installImplFlip = vi.fn().mockImplementation(() => {
      installed = true;
      return Promise.resolve({ ok: true });
    });
    void installImpl;

    const { stdin } = render(
      <WizardSteps
        store={store}
        catalog={CATALOG}
        configPath="/tmp/config.json"
        agents={[target]}
        secretStore={makeSecretStore()}
        onDone={() => {}}
        onSkip={() => {}}
        runSystemCheckImpl={silentSystemCheck}
        saveImpl={saveImpl}
        installAgentImpl={installImplFlip}
      />,
    );

    // Mount-time detection ran (initial probe).
    await wait(40);
    const detectCallsAfterMount = (target.detect as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(detectCallsAfterMount).toBeGreaterThanOrEqual(1);

    // Drive to the finish.
    stdin.write(ENTER);            // Welcome → System
    await wait(40);
    await wait(60);
    stdin.write(ENTER);            // System → LLM
    await wait(40);
    stdin.write('\x1b[B');         // ↓ field 1
    await wait(25);
    stdin.write('\x1b[B');         // ↓ Continue
    await wait(25);
    stdin.write(ENTER);            // → step 4
    await wait(60);
    stdin.write('\x1b[B');         // ↓ Finish
    await wait(25);
    stdin.write(ENTER);            // Finish → save + install
    await wait(120);

    // Install flipped detection true; the wizard must have probed again AFTER
    // install (more detect() calls than at mount), proving the refresh ran.
    expect(installImplFlip).toHaveBeenCalledTimes(1);
    const detectCallsAfterFinish = (target.detect as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(detectCallsAfterFinish).toBeGreaterThan(detectCallsAfterMount);
  });
});
