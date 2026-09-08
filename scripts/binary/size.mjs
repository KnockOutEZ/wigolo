/*
 * The §7 size budget, as a build assertion.
 *
 * WHY THIS IS A BUILD STEP AND NOT A REVIEW HABIT (DR-5): the budget is a user-story number —
 * 200 MB compressed is about a minute on a 30 Mbps line — so the thing that breaks it is never
 * a deliberate decision. It is a dependency bump three levels down that adds a 300 MB CUDA
 * provider nobody reads the diff of. A build that goes red naming `onnxruntime-node` is a
 * five-minute fix; a slow download discovered by users is not.
 *
 * WHY THE BREACH MESSAGE MUST NAME THE LARGEST TERM. "artifact is 428 MB, budget is 200 MB" is
 * a number, not a lead. The spike's own linux failure was 2.1x over and the entire overage was
 * one file (`libonnxruntime_providers_cuda.so`, 327 MB) inside one package. Naming the term
 * turns the red into the fix.
 *
 * Decimal MB, not MiB, deliberately: the budget's derivation is download TIME over a link
 * quoted in decimal bits, so the unit that makes the number mean what DR-5 says it means is
 * the decimal one. (The spike reported MiB; 174 MiB = 182.6 MB, comfortably inside either
 * reading, so nothing about the verdict turns on this.)
 */
import { SIZE_BUDGET } from './layout.mjs';

/** Decimal MB, one decimal place — the unit the budget is quoted in. */
export function mb(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * @typedef {{ name: string, bytes: number }} Term
 *   One accountable chunk of the artifact — a sidecar package, the executable, the app mirror.
 *   Terms are UNPACKED sizes: compression ratios differ per term, so attributing compressed
 *   bytes to a term would be a guess, and a guess in a failure message is worse than a fact
 *   about the other axis.
 */

/**
 * Decide the budget. Returns a verdict rather than throwing so the build can print the full
 * picture (both axes, top terms) before it exits — and so the unit tests can assert on the
 * verdict without catching.
 *
 * @param {{ compressedBytes: number, unpackedBytes: number, terms?: Term[], budget?: typeof SIZE_BUDGET }} input
 */
export function checkSizeBudget({ compressedBytes, unpackedBytes, terms = [], budget = SIZE_BUDGET }) {
  const breaches = [];
  if (compressedBytes > budget.compressedBytes) {
    breaches.push({ axis: 'compressed', actual: compressedBytes, limit: budget.compressedBytes });
  }
  if (unpackedBytes > budget.unpackedBytes) {
    breaches.push({ axis: 'unpacked', actual: unpackedBytes, limit: budget.unpackedBytes });
  }

  const ranked = [...terms].sort((a, b) => b.bytes - a.bytes);
  return { ok: breaches.length === 0, breaches, largest: ranked[0] ?? null, ranked };
}

/**
 * The red. One message carrying every breached axis and the term to go look at.
 *
 * The largest term is reported even when the largest term is innocent (the embedded runtime is
 * ~100 MB and is not going anywhere): the message says where the bytes ARE, and the reader
 * decides. Claiming to have found the culprit would be the guess this file exists to avoid.
 */
export function sizeBudgetFailure(verdict) {
  if (verdict.ok) return null;
  const axes = verdict.breaches
    .map((b) => `${b.axis} ${mb(b.actual)} exceeds the ${mb(b.limit)} budget by ${mb(b.actual - b.limit)}`)
    .join('; ');
  const top = verdict.ranked
    .slice(0, 3)
    .map((t) => `${t.name} ${mb(t.bytes)}`)
    .join(', ');
  return (
    `SIZE BUDGET BREACHED (mini-spec 7) — ${axes}.\n` +
    `  largest term: ${verdict.largest ? `${verdict.largest.name} (${mb(verdict.largest.bytes)})` : '(none measured)'}\n` +
    `  top 3 unpacked terms: ${top || '(none measured)'}\n` +
    `  Raising the budget requires a DECISIONS-AUTO entry naming the term that grew (DR-5).`
  );
}

/** Convenience for the build script: check, and throw the named failure if it breached. */
export function assertSizeBudget(input) {
  const verdict = checkSizeBudget(input);
  if (!verdict.ok) throw new Error(sizeBudgetFailure(verdict));
  return verdict;
}
