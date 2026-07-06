import { _electron as electron, type ElectronApplication } from 'playwright';

/**
 * Launch the built studio app for e2e, retrying transient launch failures.
 * CI runners can hit `spawn ETXTBSY` (the freshly-extracted electron binary is
 * briefly exec-locked) or a partial-install race; a bounded retry clears it.
 * A genuinely broken install still throws after the retries (CI verifies the
 * electron binary in a dedicated step before e2e runs).
 */
export async function launchStudio(
  opts: Parameters<typeof electron.launch>[0],
): Promise<ElectronApplication> {
  const TRANSIENT = /ETXTBSY|failed to launch|install correctly|ESRCH/i;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await electron.launch(opts);
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}
