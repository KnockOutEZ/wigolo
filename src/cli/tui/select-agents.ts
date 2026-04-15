import { checkbox } from '@inquirer/prompts';
import type { AgentId, DetectedAgent } from './agents.js';

export class NotTtyError extends Error {
  constructor() {
    super('Cannot prompt for agent selection: stdout is not a TTY. Use --agents flag in non-interactive mode.');
    this.name = 'NotTtyError';
  }
}

export async function selectAgents(detected: DetectedAgent[]): Promise<AgentId[]> {
  if (!process.stdout.isTTY) {
    throw new NotTtyError();
  }
  if (detected.length === 0) {
    return [];
  }

  const choices = detected.map((a) => ({
    name: a.displayName,
    value: a.id,
    checked: a.detected,
    disabled: a.detected ? (false as const) : ('(not installed)' as const),
  }));

  const selected = await checkbox<AgentId>({
    message: 'Select agents to configure (space to toggle, enter to confirm)',
    choices,
    loop: false,
  });

  return selected;
}
