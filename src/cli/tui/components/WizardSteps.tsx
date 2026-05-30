/**
 * WizardSteps — first-run 4-step wizard for the schema-driven settings TUI.
 *
 *   Step 1 / 4   Welcome    — banner; press Enter to begin, Esc to skip
 *   Step 2 / 4   System     — runs runSystemCheck() and surfaces the result
 *   Step 3 / 4   LLM        — CategoryScreen against llmCategory
 *   Step 4 / 4   Agents     — CategoryScreen against agentsCategory, then
 *                             on confirm calls propagation.save() once with
 *                             every staged edit, and installs wigolo into
 *                             each selected agent target.
 *
 * Esc from any step skips remaining steps and lands on SettingsHome with
 * any staged defaults committed via store.commit(). The wizard never
 * blocks on completion: on save failure the wizard surfaces a one-line
 * error and still proceeds to home so the user can recover.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { semantic } from '../theme/palette.js';
import type { CategoryDef } from '../schema/types.js';
import type { SettingsStore } from '../state/settings-store.js';
import type { AgentTarget } from '../state/agent-targets.js';
import { CategoryScreen } from './CategoryScreen.js';
import { save as runSave, installAgent, type SecretStore } from '../state/propagation.js';
import {
  runSystemCheck,
  type SystemCheckResult,
} from '../system-check.js';

/** One Ink render cycle plus margin — prevents double-advance on rapid Enter. */
const ADVANCE_GUARD_MS = 50;

type StepIndex = 1 | 2 | 3 | 4;

const STEP_LABEL: Record<StepIndex, string> = {
  1: 'Welcome',
  2: 'System',
  3: 'LLM Provider',
  4: 'MCP Agents',
};

export interface WizardStepsProps {
  store: SettingsStore;
  catalog: ReadonlyArray<CategoryDef>;
  /** Path to ~/.wigolo/config.json (or test temp). */
  configPath: string;
  /** Agents registry used at save time. */
  agents?: ReadonlyArray<AgentTarget>;
  /** Secret store used at save time. */
  secretStore?: SecretStore;
  /** Called after the final save completes (success or surfaced failure). */
  onDone: () => void;
  /** Called when the user presses Esc to abandon the wizard early. */
  onSkip: () => void;
  /** Test seam — overrides the default runSystemCheck(). */
  runSystemCheckImpl?: () => Promise<SystemCheckResult>;
  /** Test seam — overrides propagation.save(). */
  saveImpl?: typeof runSave;
  /** Test seam — overrides propagation.installAgent(). */
  installAgentImpl?: typeof installAgent;
}

function StepHeader({ step }: { step: StepIndex }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{`Step ${step} / 4`}</Text>
      <Text bold>{STEP_LABEL[step]}</Text>
    </Box>
  );
}

interface WelcomeStepProps {
  onNext: () => void;
  onSkip: () => void;
}

function WelcomeStep(props: WelcomeStepProps): React.ReactElement {
  useInput((_input, key) => {
    if (key.return) {
      props.onNext();
      return;
    }
    if (key.escape) {
      props.onSkip();
    }
  });
  return (
    <Box flexDirection="column">
      <StepHeader step={1} />
      <Text>Welcome to wigolo — local-first web intelligence for AI agents.</Text>
      <Box marginTop={1}>
        <Text dimColor>Press Enter to begin · Esc to skip and use defaults</Text>
      </Box>
    </Box>
  );
}

interface SystemStepProps {
  onNext: () => void;
  onSkip: () => void;
  runSystemCheckImpl?: () => Promise<SystemCheckResult>;
}

function SystemStep(props: SystemStepProps): React.ReactElement {
  const [result, setResult] = useState<SystemCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const impl = props.runSystemCheckImpl ?? runSystemCheck;
    let cancelled = false;
    void (async () => {
      try {
        const r = await impl();
        if (!cancelled) setResult(r);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.runSystemCheckImpl]);

  useInput((_input, key) => {
    if (key.escape) {
      props.onSkip();
      return;
    }
    if (key.return && (result !== null || error !== null)) {
      props.onNext();
    }
  });

  return (
    <Box flexDirection="column">
      <StepHeader step={2} />
      {result === null && error === null ? (
        <Text dimColor>Checking your system…</Text>
      ) : null}
      {error !== null ? (
        <Text color={semantic.warn}>{`System check error: ${error}`}</Text>
      ) : null}
      {result !== null ? (
        <Box flexDirection="column">
          <Text>
            {result.node.ok ? '✓' : '!'} Node {result.node.version ?? '(unknown)'}
          </Text>
          <Text>
            {result.python.ok ? '✓' : '!'} Python {result.python.version ?? '(missing)'}
          </Text>
          <Text>
            {result.docker.ok ? '✓' : '·'} Docker{' '}
            {result.docker.version ?? '(optional, not detected)'}
          </Text>
          <Text>
            {result.disk.ok ? '✓' : '!'} Disk{' '}
            {result.disk.freeMb !== undefined ? `${result.disk.freeMb} MB free` : '(unknown)'}
          </Text>
          {result.hardFailure ? (
            <Box marginTop={1}>
              <Text color={semantic.warn}>
                One or more required tools are missing. You can continue and fix later.
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>Press Enter to continue · Esc to skip remaining steps</Text>
      </Box>
    </Box>
  );
}

function findCategory(
  catalog: ReadonlyArray<CategoryDef>,
  id: CategoryDef['id'],
): CategoryDef | undefined {
  return catalog.find((c) => c.id === id);
}

export function WizardSteps(props: WizardStepsProps): React.ReactElement {
  const {
    store,
    catalog,
    configPath,
    agents,
    secretStore,
    onDone,
    onSkip,
    runSystemCheckImpl,
    saveImpl,
    installAgentImpl,
  } = props;

  const [step, setStep] = useState<StepIndex>(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const llmCategory = useMemo(() => findCategory(catalog, 'llm'), [catalog]);
  const agentsCategory = useMemo(() => findCategory(catalog, 'agents'), [catalog]);

  // Global Esc-from-anywhere fallback — but only when CategoryScreen isn't
  // actively owning the keyboard. Step 1/2 own their own input; steps 3/4
  // route Esc through CategoryScreen, which already calls `onBack` on Esc,
  // so we trip the same exit in `runFinish` and chain through `onDone`.
  // CategoryScreen has no edit buffer for the wizard categories at first
  // render, so Esc from idle = onBack = our `onNext` callback below. To
  // implement "Esc skips remaining steps" we wire each step's Esc to
  // `onSkip` instead of `onNext`.
  //
  // Per-step routing keeps the contract explicit; nothing global here.

  const runFinish = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);

    try {
      // 1. Snapshot the selected agents from pending OR current — we need
      //    this BEFORE save commits the store, since installAgent runs from
      //    the same propagation set.
      const pending = store.getPending();
      const current = store.getCurrent();
      const selectedAgentsRaw =
        pending.agents !== undefined ? pending.agents : current.agents;
      const selectedAgentIds = Array.isArray(selectedAgentsRaw)
        ? (selectedAgentsRaw as string[])
        : [];

      // 2. Build the env block we'll seed into each selected agent. Pull
      //    every propagateable field from current + pending. Mirrors the
      //    propagation.save() merge but kept local so installAgent has a
      //    deterministic set even if save() is mocked in tests.
      const envBlock: Record<string, string> = {};
      for (const cat of catalog) {
        for (const field of cat.fields) {
          if (field.propagateToAgents === false) continue;
          const path = field.settingsPath;
          const raw = pending[path] !== undefined ? pending[path] : current[path];
          if (raw === undefined || raw === null) continue;
          // Arrays + objects don't fit a string env block; skip them. The
          // `agents` field is itself a multiselect and is what we just
          // consumed, so this also avoids leaking it into env.
          if (typeof raw === 'object') continue;
          envBlock[field.key] = String(raw);
        }
      }

      // 3. Run propagation.save() once — atomic config.json + secret +
      //    fanout to detected agents. If `agents` was not provided we
      //    still want to commit the store, so call save() with an empty
      //    agent list rather than skipping it entirely.
      if (secretStore) {
        const save = saveImpl ?? runSave;
        const result = await save({
          store,
          catalog,
          configPath,
          agents: agents ?? [],
          secretStore,
        });
        if (result.errors && result.errors.length > 0) {
          setSaveError(result.errors.map((e) => `${e.key}: ${e.reason}`).join('; '));
        }
      } else {
        // No secret store wired up (test or partial caller) — at minimum
        // commit so the wizard's accumulated edits aren't lost on the way
        // out. Real callers always provide one.
        store.commit();
      }

      // 4. Install each selected agent. Keyed by id; we look up the target
      //    in the registry the caller passed in.
      if (agents && agents.length > 0 && selectedAgentIds.length > 0) {
        const install = installAgentImpl ?? installAgent;
        for (const id of selectedAgentIds) {
          const target = agents.find((a) => a.id === id);
          if (!target) continue;
          try {
            await install({ target, env: envBlock });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            setSaveError(reason);
          }
        }
      }
    } finally {
      setSaving(false);
      onDone();
    }
  }, [
    saving,
    store,
    catalog,
    configPath,
    agents,
    secretStore,
    saveImpl,
    installAgentImpl,
    onDone,
  ]);

  // Steps 3 + 4 render a CategoryScreen. Esc from CategoryScreen calls
  // `onBack` which we wire to `onSkip` so Esc skips remaining steps.
  // Advance / finish is triggered by Enter — a dedicated useInput here
  // catches Enter when on steps 3/4. CategoryScreen also handles Enter
  // for field navigation; both run, which is acceptable since the user
  // leaving a step via Enter is intentional.
  const advanceFromCategory = useCallback(() => {
    if (step === 3) {
      setStep(4);
      return;
    }
    if (step === 4) {
      void runFinish();
    }
  }, [step, runFinish]);

  // Guard against re-entrancy: if Enter fires twice quickly, only the
  // first invocation should advance.
  const advancingRef = useRef(false);

  useInput(
    (_input, key) => {
      if (key.return && !advancingRef.current) {
        advancingRef.current = true;
        advanceFromCategory();
        // Reset after a tick so subsequent Enter presses on the next step work.
        setTimeout(() => {
          advancingRef.current = false;
        }, ADVANCE_GUARD_MS);
      }
    },
    { isActive: step === 3 || step === 4 },
  );

  if (step === 1) {
    return <WelcomeStep onNext={() => setStep(2)} onSkip={onSkip} />;
  }

  if (step === 2) {
    return (
      <SystemStep
        onNext={() => setStep(3)}
        onSkip={onSkip}
        {...(runSystemCheckImpl ? { runSystemCheckImpl } : {})}
      />
    );
  }

  if (step === 3) {
    if (!llmCategory) {
      // Defensive — shouldn't happen with the real catalog.
      return <WelcomeStep onNext={() => setStep(4)} onSkip={onSkip} />;
    }
    return (
      <Box flexDirection="column">
        <StepHeader step={3} />
        <CategoryScreen
          category={llmCategory}
          store={store}
          onBack={onSkip}
        />
        <Box marginTop={1}>
          <Text dimColor>⏎ continue · Esc to skip remaining steps</Text>
        </Box>
      </Box>
    );
  }

  // step === 4
  if (!agentsCategory) {
    return <WelcomeStep onNext={onDone} onSkip={onSkip} />;
  }
  return (
    <Box flexDirection="column">
      <StepHeader step={4} />
      <CategoryScreen
        category={agentsCategory}
        store={store}
        onBack={onSkip}
      />
      {saving ? (
        <Box marginTop={1}>
          <Text dimColor>Saving…</Text>
        </Box>
      ) : null}
      {saveError !== null ? (
        <Box marginTop={1}>
          <Text color={semantic.warn}>{saveError}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>⏎ Finish · Esc to skip and use defaults</Text>
      </Box>
    </Box>
  );
}

