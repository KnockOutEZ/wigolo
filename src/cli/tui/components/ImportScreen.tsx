/**
 * ImportScreen — import flow.
 *
 * Three phases:
 *   1. prompt — user types a file path (~/-relative ok)
 *   2. review — file parsed; known/unknown keys listed; user confirms to stage
 *   3. done   — known keys staged into the store as pending; user reviews
 *               them as the dirty marker on SettingsHome before committing.
 *
 * The store mutation is staged-only — we call store.set(settingsPath, value)
 * for each known key, leaving them in the pending bucket. The existing
 * propagation/save path on SettingsHome owns the actual config.json write.
 *
 * The import file format mirrors what DashboardExport writes: a JSON envelope
 * with a top-level `settings` map keyed by settingsPath. Unknown keys are
 * surfaced as warnings, not errors.
 */
import React, { useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { CategoryDef } from '../schema/types.js';
import type { SettingsStore } from '../state/settings-store.js';
import type { ActivityStore } from '../state/activity-store.js';
import { activityStore as defaultActivityStore } from '../state/activity-store-instance.js';
import { semantic } from '../theme/palette.js';

type Phase = 'prompt' | 'review' | 'done' | 'error';

interface ImportScreenProps {
  store: SettingsStore;
  catalog: ReadonlyArray<CategoryDef>;
  onBack: () => void;
  activityStore?: ActivityStore;
}

interface ParsedImport {
  known: Array<{ key: string; value: unknown }>;
  unknown: string[];
  total: number;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return homedir() + path.slice(1);
  return path;
}

function readAndValidate(
  path: string,
  knownKeys: ReadonlySet<string>,
): { ok: true; result: ParsedImport } | { ok: false; error: string } {
  const resolved = expandHome(path.trim());
  if (resolved.length === 0) {
    return { ok: false, error: 'Path is empty' };
  }
  if (!existsSync(resolved)) {
    return { ok: false, error: `File not found: ${resolved}` };
  }
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf-8');
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Import file is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'Import file root is not a JSON object' };
  }
  const envelope = parsed as Record<string, unknown>;
  // Accept both the export envelope shape ({ settings: {...} }) and a flat
  // { key: value } map — flat lets users hand-edit a minimal file.
  let settings: Record<string, unknown>;
  if (
    typeof envelope.settings === 'object' &&
    envelope.settings !== null &&
    !Array.isArray(envelope.settings)
  ) {
    settings = envelope.settings as Record<string, unknown>;
  } else {
    settings = envelope;
  }

  const known: Array<{ key: string; value: unknown }> = [];
  const unknown: string[] = [];
  let total = 0;
  for (const [k, v] of Object.entries(settings)) {
    total++;
    if (knownKeys.has(k)) {
      known.push({ key: k, value: v });
    } else {
      unknown.push(k);
    }
  }
  return { ok: true, result: { known, unknown, total } };
}

export function ImportScreen({
  store,
  catalog,
  onBack,
  activityStore = defaultActivityStore,
}: ImportScreenProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('prompt');
  const [buffer, setBuffer] = useState<string>('~/wigolo-config-export.json');
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [stagedCount, setStagedCount] = useState<number>(0);

  const knownKeys = useMemo(() => {
    const set = new Set<string>();
    for (const cat of catalog) {
      for (const field of cat.fields) {
        set.add(field.settingsPath);
      }
    }
    return set;
  }, [catalog]);

  const handleSubmitPath = useCallback(() => {
    const r = readAndValidate(buffer, knownKeys);
    if (!r.ok) {
      setErrorMsg(r.error);
      setPhase('error');
      return;
    }
    setParsed(r.result);
    setPhase('review');
  }, [buffer, knownKeys]);

  const handleConfirmStage = useCallback(() => {
    if (!parsed) return;
    const end = activityStore.begin('import');
    try {
      for (const { key, value } of parsed.known) {
        store.set(key, value);
      }
      setStagedCount(parsed.known.length);
      setPhase('done');
    } finally {
      end();
    }
  }, [parsed, store, activityStore]);

  useInput(useCallback((input, key) => {
    if (phase === 'prompt') {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.return) {
        handleSubmitPath();
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setBuffer((b) => b + input);
        return;
      }
      return;
    }
    if (phase === 'review') {
      if (key.escape || input === 'n' || input === 'N') {
        onBack();
        return;
      }
      if (input === 'y' || input === 'Y' || key.return) {
        handleConfirmStage();
        return;
      }
      return;
    }
    if (phase === 'error') {
      if (key.escape || input === 'q') {
        onBack();
        return;
      }
      if (key.return) {
        setErrorMsg('');
        setPhase('prompt');
        return;
      }
      return;
    }
    // done
    if (key.escape || input === 'q' || key.return) {
      onBack();
    }
  }, [phase, handleSubmitPath, handleConfirmStage, onBack]));

  if (phase === 'prompt') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Import config</Text>
        <Box marginTop={1}>
          <Text>Path: </Text>
          <Text>{buffer}</Text>
          <Text color={semantic.accent}>_</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Enter the path to an exported config file. ~/ is expanded.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>enter load · esc cancel</Text>
        </Box>
      </Box>
    );
  }

  if (phase === 'error') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold color={semantic.err}>Import error</Text>
        <Box marginTop={1}>
          <Text color={semantic.err}>{errorMsg}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>enter retry · q/esc back</Text>
        </Box>
      </Box>
    );
  }

  if (phase === 'review' && parsed) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Import: review</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color={semantic.ok}>{parsed.known.length}</Text> known key
            {parsed.known.length === 1 ? '' : 's'} will be staged into pending.
          </Text>
          {parsed.unknown.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={semantic.warn}>
                {parsed.unknown.length} unknown key
                {parsed.unknown.length === 1 ? '' : 's'} ignored:
              </Text>
              {parsed.unknown.slice(0, 10).map((k) => (
                <Box key={k} paddingLeft={2}>
                  <Text dimColor>{k}</Text>
                </Box>
              ))}
              {parsed.unknown.length > 10 ? (
                <Box paddingLeft={2}>
                  <Text dimColor>… and {parsed.unknown.length - 10} more</Text>
                </Box>
              ) : null}
            </Box>
          ) : null}
        </Box>
        <Box marginTop={1}>
          <Text color={semantic.warn}>
            Stage {parsed.known.length} change
            {parsed.known.length === 1 ? '' : 's'} into pending? (y/N)
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Staged values appear as the (N pending) marker on the Settings
            screen until you commit them.
          </Text>
        </Box>
      </Box>
    );
  }

  // done
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold color={semantic.ok}>
        Staged {stagedCount} pending change{stagedCount === 1 ? '' : 's'}
      </Text>
      <Box marginTop={1}>
        <Text dimColor>
          Open the affected categories on Settings to review or discard.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press enter or q/esc to return</Text>
      </Box>
    </Box>
  );
}
