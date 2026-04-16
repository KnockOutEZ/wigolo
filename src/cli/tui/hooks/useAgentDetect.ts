import { useState, useEffect } from 'react';
import { detectAgents, type DetectedAgent } from '../agents.js';

export function useAgentDetect(): {
  agents: DetectedAgent[];
  done: boolean;
} {
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    try {
      const detected = detectAgents({});
      setAgents(detected);
    } catch {
      // detection failed, show empty list
    }
    setDone(true);
  }, []);

  return { agents, done };
}
