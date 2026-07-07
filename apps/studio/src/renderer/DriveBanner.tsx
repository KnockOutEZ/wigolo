import { IconPause } from './icons';

/**
 * The drive banner (spec §3): shown ONLY while the agent drives the visible tab. It names the current
 * step (the agent's per-act narration), offers an explicit Pause, and reminds the human that touching
 * anything takes over instantly — it is the takeover affordance.
 */
export function DriveBanner(props: { show: boolean; step: string; onPause: () => void }) {
  if (!props.show) return null;
  return (
    <div className="drive-banner">
      <span className="drive-banner__dot" />
      <span className="drive-banner__step">{props.step || 'The agent is driving this tab…'}</span>
      <span className="drive-banner__hint">Touch anything to take over instantly</span>
      <button className="drive-banner__pause" onClick={props.onPause} title="Pause the agent">
        <IconPause /> Pause
      </button>
    </div>
  );
}
