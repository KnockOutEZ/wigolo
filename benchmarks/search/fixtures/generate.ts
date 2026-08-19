/**
 * S14-0 — expand `corpus-spec.ts` into the three frozen artifacts the runner reads.
 *
 * Committed alongside its output on purpose: "synthesised, not harvested" is a provenance claim, and a
 * reader can only check it against the thing that did the synthesising. The emitted files are the frozen
 * corpus; this script is how they came to be, and re-running it must reproduce them byte-for-byte.
 *
 *   npx tsx benchmarks/search/fixtures/generate.ts
 *
 * DETERMINISM IS LOAD-BEARING. G-S14-0c requires two consecutive benchmark runs to agree within 0.001 on
 * MRR, so nothing here may use a clock or a random source: distractor selection is a modular walk over a
 * fixed list, and every string is derived from the spec entry.
 */
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS, type CorpusEntry } from './corpus-spec.js';

const HERE = join(process.cwd(), 'benchmarks/search/fixtures');
const RESPONSES = join(process.cwd(), 'benchmarks/search/responses');
const RESULTS_PER_QUERY = 10;

/** A stable pseudo-engine name per position, so `engine` is populated without implying a real one ran. */
const ENGINES = ['synthetic-a', 'synthetic-b', 'synthetic-c'];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/**
 * Build one query's result list: the graded answers planted at `rank` onward, distractors elsewhere.
 *
 * `relevance_score` descends monotonically with position so the list is self-consistent — a fixture whose
 * scores disagreed with its own order would make every downstream metric ambiguous.
 */
function resultsFor(entry: CorpusEntry): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const graded = [...entry.graded].sort((a, b) => b.grade - a.grade);
  // 1-based rank → 0-based slot, clamped so a spec typo cannot push the answer off the list entirely.
  const firstSlot = Math.min(Math.max(entry.rank, 1), RESULTS_PER_QUERY) - 1;

  for (let i = 0; i < RESULTS_PER_QUERY; i += 1) {
    const gradedIndex = i - firstSlot;
    const g = gradedIndex >= 0 && gradedIndex < graded.length ? graded[gradedIndex] : undefined;
    if (g) {
      out.push({
        title: `${g.title} — ${entry.domain}`,
        url: `https://${entry.domain}${g.path}`,
        snippet: `Reference material for ${entry.query}. Written for the wigolo retrieval corpus.`,
        relevance_score: Number((1 - i * 0.07).toFixed(4)),
        engine: ENGINES[i % ENGINES.length],
      });
      continue;
    }
    const host = entry.distractors[i % entry.distractors.length];
    out.push({
      title: `${entry.query} notes (${i + 1})`,
      url: `https://${host}/${slug(entry.query)}/${i + 1}`,
      snippet: `Unjudged filler for ${entry.query}. Written for the wigolo retrieval corpus.`,
      relevance_score: Number((1 - i * 0.07).toFixed(4)),
      engine: ENGINES[i % ENGINES.length],
    });
  }
  return out;
}

function main(): void {
  const ids = new Set<string>();
  for (const e of CORPUS) {
    if (ids.has(e.id)) throw new Error(`duplicate corpus id: ${e.id}`);
    ids.add(e.id);
    if (e.graded.length === 0) throw new Error(`${e.id}: a judged query needs at least one graded answer`);
  }

  const queries = CORPUS.map((e) => ({
    id: e.id,
    query: e.query,
    category: e.category,
    expectedDomains: [e.domain],
    ...(e.tags ? { tags: e.tags } : {}),
  }));

  const judgments = CORPUS.flatMap((e) =>
    e.graded.map((g) => ({ queryId: e.id, url: `https://${e.domain}${g.path}`, grade: g.grade })),
  );

  writeFileSync(join(HERE, 'queries.json'), `${JSON.stringify({ queries }, null, 2)}\n`, 'utf-8');
  writeFileSync(join(HERE, 'relevance.json'), `${JSON.stringify({ judgments }, null, 2)}\n`, 'utf-8');

  // Rebuilt from empty so a removed spec entry cannot leave an orphan response behind, which would be
  // counted by `responses.size` and silently inflate the corpus.
  if (existsSync(RESPONSES)) rmSync(RESPONSES, { recursive: true, force: true });
  mkdirSync(RESPONSES, { recursive: true });
  for (const e of CORPUS) {
    const doc = {
      queryId: e.id,
      licence: 'synthetic',
      licenceNote:
        'Authored for this corpus. No engine output, ranking or snippet is reproduced; the URLs name public documentation paths.',
      results: resultsFor(e),
    };
    writeFileSync(join(RESPONSES, `${e.id}.json`), `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  }

  process.stdout.write(
    `corpus written: ${String(queries.length)} queries, ${String(judgments.length)} judgments, ${String(CORPUS.length)} responses\n`,
  );
}

main();
