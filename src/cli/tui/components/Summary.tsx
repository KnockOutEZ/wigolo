import React, { useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import type { InstallItem } from '../hooks/useInstall.js';
import type { VerifyItem } from '../hooks/useVerify.js';

interface AgentResult { id: string; displayName: string; ok: boolean }
interface SkillResult { id: string; status: string; name: string; detail: string }

interface SummaryProps {
  agentResults: AgentResult[];
  skillResults: SkillResult[];
  installItems: InstallItem[];
  verifyItems: VerifyItem[];
}

export function Summary({ agentResults, skillResults, installItems, verifyItems }: SummaryProps) {
  const { exit } = useApp();

  useEffect(() => {
    const timer = setTimeout(exit, 1000);
    return () => clearTimeout(timer);
  }, [exit]);

  const installOk = installItems.filter((i) => i.status === 'done');
  const installFail = installItems.filter((i) => i.status === 'failed');
  const verifyOk = verifyItems.filter((i) => i.status === 'pass');
  const verifyFail = verifyItems.filter((i) => i.status === 'fail');
  const agentsOk = agentResults.filter((r) => r.ok);
  const agentsFail = agentResults.filter((r) => !r.ok);
  const skillsInstalled = skillResults.filter((r) => r.status === 'installed');

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="green"
        paddingX={2}
        paddingY={1}
      >
        <Text color="green" bold>{'✓'} Setup complete!</Text>

        {/* Recap: what got installed */}
        {installItems.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Installed:</Text>
            {installOk.map((i) => (
              <Text key={i.id}>  <Text color="green">{'✓'}</Text> {i.name}</Text>
            ))}
            {installFail.map((i) => (
              <Text key={i.id}>  <Text color="red">{'✗'}</Text> {i.name} <Text color="red">{i.error}</Text></Text>
            ))}
          </Box>
        )}

        {/* Recap: verification */}
        {verifyItems.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Verified:</Text>
            {verifyOk.map((i) => (
              <Text key={i.id}>  <Text color="green">{'✓'}</Text> {i.name} <Text dimColor>{i.detail}</Text></Text>
            ))}
            {verifyFail.map((i) => (
              <Text key={i.id}>  <Text color="yellow">{'!'}</Text> {i.name} <Text color="yellow">{i.detail}</Text></Text>
            ))}
          </Box>
        )}

        {/* Recap: MCP config */}
        {agentResults.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>MCP configured:</Text>
            {agentsOk.map((r) => (
              <Text key={r.id}>  <Text color="green">{'✓'}</Text> {r.displayName}</Text>
            ))}
            {agentsFail.map((r) => (
              <Text key={r.id}>  <Text color="red">{'✗'}</Text> {r.displayName}</Text>
            ))}
          </Box>
        )}

        {/* Recap: skills */}
        {skillsInstalled.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Skills installed:</Text>
            {skillsInstalled.map((r) => (
              <Text key={r.id}>  <Text color="green">{'✓'}</Text> {r.name} <Text dimColor>{r.detail}</Text></Text>
            ))}
          </Box>
        )}

        {/* Next steps */}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Try it now:</Text>
          <Text>  Open your AI tool and ask:</Text>
          <Text color="cyan">  {'"Search for Next.js authentication setup"'}</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Commands:</Text>
          <Text>  <Text color="cyan">wigolo doctor</Text>    system diagnostics</Text>
          <Text>  <Text color="cyan">wigolo shell</Text>     interactive REPL</Text>
          <Text>  <Text color="cyan">wigolo status</Text>    quick health check</Text>
          <Text>  <Text color="cyan">wigolo init</Text>      re-run this setup</Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>Docs: https://github.com/KnockOutEZ/wigolo</Text>
        </Box>
      </Box>
    </Box>
  );
}
