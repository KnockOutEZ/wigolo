import type { ControlToken } from 'wigolo/studio';

/**
 * Per-tab preemption state machine (spec §5). Layers over the salvaged
 * single-driver ControlToken: the token remains the authoritative single holder
 * (so two drivers are impossible by construction); the FSM adds the human⇄agent⇄
 * paused surface and the "native human input preempts the agent instantly" rule.
 *
 * The agent's in-flight act stamps the epoch returned by agentAcquire(); a human
 * input calls the token's reclaim() (holder→human, epoch++), so the stamped epoch
 * goes stale and the act's next dispatch fence (canAgentStep) fails → the act
 * reports the `preempted` stage rather than corrupting a half-driven page.
 */
export type PreemptionState = 'human' | 'agent' | 'paused';

export class PreemptionFsm {
  private preempted = false;

  constructor(private readonly token: ControlToken) {}

  state(): PreemptionState {
    if (this.token.holder === 'agent') return 'agent';
    return this.preempted ? 'paused' : 'human';
  }

  /** Grant the agent control of this tab; returns the epoch the agent must stamp on its units. */
  agentAcquire(): number {
    this.token.grant('agent');
    this.preempted = false;
    return this.token.epoch;
  }

  /** Native human input on this tab. If the agent was driving, preempt instantly (→paused). */
  onHumanInput(): void {
    if (this.token.holder === 'agent') {
      this.token.reclaim(); // holder→human, epoch++ → in-flight agent unit is fenced
      this.preempted = true;
    }
    // If the human already holds, reclaim() would be a no-op; do not bump the epoch.
  }

  /** Agent yields control back to the human (end of an autonomous run). */
  agentRelease(): void {
    this.token.release();
    this.preempted = false;
  }

  /** Epoch fence for an agent input unit: true only if the agent still holds at the stamped epoch. */
  canAgentStep(epoch: number): boolean {
    return this.token.canDrive('agent', epoch);
  }

  epoch(): number {
    return this.token.epoch;
  }
}
