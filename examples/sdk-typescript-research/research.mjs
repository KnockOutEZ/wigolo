// wigolo-sdk embedded local mode: ensure a local wigolo daemon is running
// (reuse one, or spawn `wigolo serve` on a free loopback port), run a research
// call, print the brief's highlights, and clean up after ourselves.
//
//   npm install
//   node research.mjs
//
// The spawn command resolves `wigolo` on PATH — override with WIGOLO_CLI
// (a path, or a JSON argv array) if yours lives elsewhere.
import { createLocalClient } from 'wigolo-sdk/local';

const question = process.argv[2] ?? 'how does http caching interact with service workers';

const { client, owned, close } = await createLocalClient();
console.log(`daemon: ${owned ? 'spawned for this run (stopped on exit)' : 'reused an already-running one'}`);

try {
  const res = await client.research({ question, depth: 'quick' });
  const brief = res.brief ?? {};

  console.log(`\nquestion: ${question}`);
  console.log(`topics:   ${(brief.topics ?? []).join(' | ')}`);
  console.log(`\ntop highlights (${(brief.highlights ?? []).length} total):`);
  for (const h of (brief.highlights ?? []).slice(0, 3)) {
    console.log(`\n- ${h.text}`);
    console.log(`  source: ${h.source_url}`);
  }
} finally {
  await close(); // stops the daemon only if this run spawned it
}
