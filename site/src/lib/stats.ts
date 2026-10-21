/**
 * Reach figures for the sponsor page, read once at build time. A failed
 * request returns null and the figure is left off the page — never a guess.
 */

const NPM_PACKAGES = ["wigolo", "wigolo-sdk", "wigolo-vercel-ai-sdk"];

export async function npmMonthlyDownloads(): Promise<number | null> {
  try {
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-month/${NPM_PACKAGES.join(",")}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, { downloads?: number } | null>;
    const total = NPM_PACKAGES.reduce((sum, p) => sum + (body[p]?.downloads ?? 0), 0);
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

/** "3,751" → "3.7k+": rounded down, so the page never overstates. */
export function compact(n: number): string {
  if (n < 1000) return `${n}`;
  return `${Math.floor(n / 100) / 10}k+`;
}
