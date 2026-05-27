/**
 * ProviderSetup — TUI screen for picking an LLM provider and entering an API key.
 *
 * Reachable from:
 *   - The wizard flow (during init, after browser setup)
 *   - The main-menu router (reconfigure mode, "Configure LLM provider")
 *
 * Features:
 *   - Provider picker (Anthropic, OpenAI, Gemini, Local/Ollama; groq hidden per spec)
 *   - Masked input for API key (password-style, never echoed)
 *   - Shows where the key will be stored (keychain or encrypted file)
 *   - Persists provider name + keyLocation to config.json via SP0 accessor
 *   - Non-interactive parity via props (providerOverride + keyOverride)
 *
 * Keys are NEVER rendered in plaintext — the masked form is shown after storage.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { PasswordInput } from '@inkjs/ui';
import { keychainAvailable } from '../../../security/keychain.js';
import { readProviderKey, saveProviderSelection, PICKER_PROVIDERS } from '../actions/provider-keys.js';
import { getConfig } from '../../../config.js';
import type { LLMProvider } from '../../../integrations/cloud/llm/types.js';

type PickableProvider = LLMProvider | 'custom';

const PROVIDER_LABELS: Record<PickableProvider, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  gemini: 'Google Gemini',
  groq: 'Groq',
  custom: 'Local / Ollama (OpenAI-compatible URL)',
};

const PROVIDER_KEY_HINT: Record<PickableProvider, string> = {
  anthropic: 'Enter your Anthropic API key (starts with sk-ant-...)',
  openai: 'Enter your OpenAI API key (starts with sk-...)',
  gemini: 'Enter your Google AI API key',
  groq: 'Enter your Groq API key',
  custom: 'Enter the OpenAI-compatible endpoint URL (e.g. http://localhost:11434)',
};

type Step = 'pick-provider' | 'enter-key' | 'saving' | 'done' | 'skip';

export interface ProviderSetupProps {
  onComplete: (result: { provider: PickableProvider | null; skipped: boolean }) => void;
  onSkip?: () => void;
  /** Non-interactive: pre-select provider, skip picker */
  providerOverride?: PickableProvider;
  /** Non-interactive: pre-supply key, skip key entry */
  keyOverride?: string;
}

export function ProviderSetup({
  onComplete,
  onSkip,
  providerOverride,
  keyOverride,
}: ProviderSetupProps) {
  const [step, setStep] = useState<Step>(providerOverride ? 'enter-key' : 'pick-provider');
  const [cursor, setCursor] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<PickableProvider | null>(
    providerOverride ?? null,
  );
  const [keyInput, setKeyInput] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [storedLocation, setStoredLocation] = useState<'keychain' | 'file' | null>(null);
  const [existingMasked, setExistingMasked] = useState<string | null>(null);

  const cfg = getConfig();
  const dataDir = cfg.dataDir;

  // Non-interactive path: both override props set → go straight to saving
  useEffect(() => {
    if (providerOverride && keyOverride) {
      setSelectedProvider(providerOverride);
      void handleSave(providerOverride, keyOverride);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On provider select, check if one is already stored
  const handleProviderSelect = useCallback(async (provider: PickableProvider) => {
    setSelectedProvider(provider);
    if (provider !== 'custom') {
      const existing = await readProviderKey(provider as LLMProvider, { dataDir });
      if (existing) setExistingMasked(existing.masked);
    }
    setStep('enter-key');
  }, [dataDir]);

  const handleSave = useCallback(async (provider: PickableProvider, value: string) => {
    if (!value.trim()) {
      setStatusMsg('Key cannot be empty');
      return;
    }
    setStep('saving');
    setStatusMsg('Saving...');

    // All side-effecting save logic lives in the action; the component just
    // renders the result (thin-handler pattern; keeps secrets out of the view).
    const result = await saveProviderSelection(provider, value.trim(), { dataDir });
    if (result.ok) {
      setStoredLocation(result.location);
      setStatusMsg(
        result.location ? `Key stored in ${result.location}` : 'Custom URL saved to config',
      );
      setStep('done');
    } else {
      setStatusMsg(`Failed: ${result.error ?? 'unknown error'}`);
      setStep('enter-key');
    }
  }, [dataDir]);

  useInput((input, key) => {
    if (step === 'pick-provider') {
      const pickerList = PICKER_PROVIDERS as readonly PickableProvider[];
      if (key.upArrow) setCursor((c) => (c > 0 ? c - 1 : pickerList.length - 1));
      else if (key.downArrow) setCursor((c) => (c < pickerList.length - 1 ? c + 1 : 0));
      else if (key.return) void handleProviderSelect(pickerList[cursor]);
      else if (key.escape || input === 'q' || input === 's') {
        onSkip?.();
        onComplete({ provider: null, skipped: true });
      }
    } else if (step === 'enter-key') {
      if (key.escape) {
        if (providerOverride) {
          onSkip?.();
          onComplete({ provider: null, skipped: true });
        } else {
          setStep('pick-provider');
        }
      } else if (key.return && keyInput.trim()) {
        void handleSave(selectedProvider!, keyInput.trim());
      }
    } else if (step === 'done') {
      if (key.return || input === 'q' || key.escape) {
        onComplete({ provider: selectedProvider, skipped: false });
      }
    }
  });

  const storageNote = keychainAvailable()
    ? 'Keys stored in OS keychain'
    : 'OS keychain unavailable — key will be stored in encrypted file (~/.wigolo/keys/)';

  if (step === 'pick-provider') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Configure LLM provider</Text>
        <Text dimColor>↑/↓ navigate · enter select · s/esc skip</Text>
        <Box flexDirection="column" marginTop={1}>
          {(PICKER_PROVIDERS as readonly PickableProvider[]).map((p, i) => {
            const focused = i === cursor;
            return (
              <Box key={p}>
                <Text>
                  {focused ? <Text color="cyan">{'❯ '}</Text> : '  '}
                  <Text bold={focused}>{PROVIDER_LABELS[p]}</Text>
                </Text>
              </Box>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{storageNote}</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'enter-key') {
    const hint = selectedProvider ? PROVIDER_KEY_HINT[selectedProvider] : 'Enter API key';
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>
          {selectedProvider ? PROVIDER_LABELS[selectedProvider] : 'API key'}
        </Text>
        {existingMasked && (
          <Text dimColor>Current key: {existingMasked} (enter new to replace)</Text>
        )}
        <Text dimColor>{hint}</Text>
        <Box marginTop={1}>
          <PasswordInput
            placeholder="Enter key..."
            onChange={setKeyInput}
            onSubmit={(val) => {
              if (val.trim()) void handleSave(selectedProvider!, val.trim());
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>esc — go back</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'saving') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text>{statusMsg}</Text>
      </Box>
    );
  }

  if (step === 'done') {
    const loc = storedLocation ? ` in ${storedLocation}` : '';
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color="green" bold>{'✓'} Provider configured</Text>
        <Text>
          Provider: <Text bold>{selectedProvider ? PROVIDER_LABELS[selectedProvider] : 'none'}</Text>
        </Text>
        {storedLocation && (
          <Text dimColor>Key stored{loc}</Text>
        )}
        <Box marginTop={1}>
          <Text dimColor>Press enter or esc to continue</Text>
        </Box>
      </Box>
    );
  }

  return null;
}
