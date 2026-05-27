import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useVerify, type VerifyItem } from '../hooks/useVerify.js';
import type { CapabilityResult, McpWiringResult, VerifyEndToEndResult } from '../actions/verify-e2e.js';

interface VerificationProps {
  dataDir: string;
  onComplete: (items: VerifyItem[]) => void;
  /** SP6: when provided, renders the end-to-end capability report after component checks. */
  e2eResult?: VerifyEndToEndResult;
}

function VerifyLine({ item }: { item: VerifyItem }) {
  const name = item.name.padEnd(14);

  switch (item.status) {
    case 'pending':
      return <Text dimColor>  {'○'} {name}</Text>;
    case 'checking':
      return (
        <Box>
          <Text>  </Text>
          <Spinner label={name} />
        </Box>
      );
    case 'pass':
      return (
        <Text>
          {'  '}<Text color="green">{'✓'}</Text> {name}
          <Text dimColor>{item.detail}</Text>
        </Text>
      );
    case 'fail':
      return (
        <Text>
          {'  '}<Text color="yellow">{'!'}</Text> {name}
          <Text color="yellow">{item.detail}</Text>
        </Text>
      );
    case 'warn':
      return (
        <Text>
          {'  '}<Text color="yellow">{'~'}</Text> {name}
          <Text dimColor>{item.detail}</Text>
        </Text>
      );
  }
}

// ---------------------------------------------------------------------------
// SP6 — per-capability result line
// ---------------------------------------------------------------------------

function CapabilityLine({ cap }: { cap: CapabilityResult }) {
  const label = cap.capability.padEnd(12);
  switch (cap.status) {
    case 'pass':
      return (
        <Text>
          {'  '}<Text color="green">{'✓'}</Text> {label}
          <Text dimColor> {cap.detail}</Text>
        </Text>
      );
    case 'fail':
      return (
        <Text>
          {'  '}<Text color="red">{'✗'}</Text> {label}
          <Text color="red"> {cap.detail}</Text>
        </Text>
      );
    case 'skipped':
      return (
        <Text>
          {'  '}<Text dimColor>{'–'}</Text> {label}
          <Text dimColor> {cap.detail}</Text>
        </Text>
      );
  }
}

function McpWiringLine({ w }: { w: McpWiringResult }) {
  const label = w.agentName.padEnd(16);
  if (w.status === 'pass') {
    return (
      <Text>
        {'    '}<Text color="green">{'✓'}</Text> {label}
        <Text dimColor> {w.detail}</Text>
      </Text>
    );
  }
  if (w.status === 'skipped') {
    return (
      <Text>
        {'    '}<Text dimColor>{'–'}</Text> {label}
        <Text dimColor> {w.detail}</Text>
      </Text>
    );
  }
  return (
    <Text>
      {'    '}<Text color="yellow">{'!'}</Text> {label}
      <Text color="yellow"> {w.detail}</Text>
    </Text>
  );
}

function E2EReport({ result }: { result: VerifyEndToEndResult }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>End-to-end capability check:</Text>
      <Box flexDirection="column" marginTop={0}>
        {result.capabilities.map((cap) => (
          <CapabilityLine key={cap.capability} cap={cap} />
        ))}
      </Box>
      {result.mcpWiringResults.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>  MCP wiring:</Text>
          {result.mcpWiringResults.map((w) => (
            <McpWiringLine key={w.agentId} w={w} />
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        {result.allPassed ? (
          <Text color="green" bold>  ✓ All capabilities confirmed</Text>
        ) : (
          <Text color="yellow" bold>
            {'  ! '}{result.hardFailureCount} capability failure(s) — see details above
          </Text>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------

export function Verification({ dataDir, onComplete, e2eResult }: VerificationProps) {
  const { items, done } = useVerify(dataDir);

  useEffect(() => {
    if (done) {
      const timer = setTimeout(() => onComplete(items), 400);
      return () => clearTimeout(timer);
    }
  }, [done, items, onComplete]);

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Verifying setup...</Text>
      <Box flexDirection="column" marginTop={1}>
        {items.filter((i) => i.status !== 'pending').map((item) => (
          <VerifyLine key={item.id} item={item} />
        ))}
      </Box>
      {done && e2eResult && <E2EReport result={e2eResult} />}
    </Box>
  );
}

export type { VerifyItem };
