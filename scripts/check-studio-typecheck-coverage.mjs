#!/usr/bin/env node
/*
 * Coverage guard for the Studio app's own type-check (known issue P7).
 *
 * P7's aphorism: *a gate that cannot see a file reports the same thing as a gate that sees it and
 * finds nothing.* The app IS type-checked — `npm run lint -w apps/studio` runs `tsc --noEmit` over
 * `apps/studio/tsconfig.json`, and `.github/workflows/ci.yml` invokes it in the `studio-unit` job.
 * But nothing asserted that the arrangement stays true.
 *
 * The first two shipped versions of this guard described that arrangement and checked its SHAPE: the
 * tsconfig's file set, `options.strict`, the `lint` script string, a regex over the workflow text.
 * Every bypass found since was a costume the shape-checks did not recognise — a decoy project named
 * by `-p`, `strict: true` with its member flags individually off, a `run:` line living inside a YAML
 * block scalar, `if: false` on the real step. Describing a check is not the same as running it, so
 * the core assertion here is now BEHAVIOURAL:
 *
 *   run the exact command CI runs — `npm run lint -w apps/studio`, resolved through the app's own
 *   `lint` script — twice over an isolated mirror of the app: once clean (must exit 0) and once with
 *   a planted type error per strict check (must exit non-zero AND name every planted error).
 *
 * That is un-foolable by construction: whatever the arrangement IS, a type error either gets
 * reported or it does not. A decoy project reports nothing. A disabled member flag drops exactly its
 * own probe. `"lint": "true"` reports nothing. The shape-checks survive only as fast pre-filters
 * that produce a better message for the blunt cases, and each one owns a fixture that identifies it
 * by message.
 *
 * Two things stay outside the behavioural check because nothing local can execute them:
 *
 *   - **Is the command wired into CI at all?** Asserted by parsing ci.yml with a real YAML parser and
 *     requiring an enabled `run:` step in an enabled job. The previous regex over comment-stripped
 *     but unparsed text was satisfied by a `run:`-looking line inside an unrelated block scalar, and
 *     was blind to `if: false` on the step it was checking — while simultaneously rejecting the
 *     inline `- run: …` form that four other steps in the same file use.
 *
 *     Proving the invocation SITS in an enabled step is still not proving the shell RUNS it, or that
 *     its failure reaches the job's conclusion, and the gap between those two was a live bypass: with
 *     the `Lint studio` step's body replaced by `# npm run lint -w apps/studio` plus an `echo`, this
 *     guard printed "invoked by an enabled ci.yml step" and exited 0. So the wiring check now also
 *     asks about EXECUTION SEMANTICS — the invocation must be in command position (not a comment, a
 *     quoted string or a substitution), its exit code must not be discarded (`|| …`, a pipeline, `&`,
 *     `!`, a `set` that disarms errexit), neither the step nor its job may be `continue-on-error`,
 *     the job's `strategy` must be provably worth at least one leg, and the workflow's `on:` must
 *     actually fire for this branch on `pull_request` and `push`.
 *
 *     **That analysis is DEFAULT-DENY, and that is the whole mechanism.** Rounds 3, 4, 5 and 6 of
 *     review each enumerated the edits their author could imagine — five, four, six and then seven
 *     more pass-direction bypasses — because the guard re-implemented bash and GitHub Actions
 *     semantics as a blacklist, and a blacklist's silence is indistinguishable from approval. So
 *     the trigger reader, the KEY reader and the `run:` reader now accept ONLY the shapes they model
 *     completely:
 *
 *       - a step's and a job's KEYS are an allowlist (`MODELED_STEP_KEYS`, `MODELED_JOB_KEYS`), and
 *         anything else FAILs naming the key. Round 7 found this layer still a blacklist after the
 *         body grammar had been fixed: `shell:` was never read — so the whole `;`-is-safe argument
 *         was made about a shell nobody had checked, and `shell: bash --noprofile --norc {0}` drops
 *         `-e` while reading like the default — and `needs:`, `container:`, `services:`,
 *         `working-directory:`, `uses:` and a workflow- or job-level `defaults:` were all silently
 *         ignored. `shell:` itself is modeled by VALUE: `bash`, or absent on a runner that cannot be
 *         Windows (where the default is pwsh and there is no errexit at all).
 *
 *       - `on.push` / `on.pull_request` may carry `branches` or `branches-ignore` and nothing else,
 *         as a list of patterns built from `[A-Za-z0-9._/-]` and `*`. `paths`, `paths-ignore`,
 *         `types`, `tags`, a scalar `branches`, a negated `!branch` entry, a `?`/`+`/`[…]` glob —
 *         every one of them FAILS, with a message saying the guard cannot prove the run starts.
 *         (Other top-level events — `workflow_dispatch`, `workflow_call` — are ignored on purpose:
 *         an extra event can only ADD runs, never remove the two this asserts.)
 *       - a `run:` body must tokenise into simple commands joined by `&& || | & ; <newline>` and
 *         nothing else. A heredoc, a subshell, a brace group, `if`/`for`/`while`/`case`, a `${{ }}`
 *         expression the runner rewrites before the shell sees it, a `set` spelling this cannot
 *         parse — each is a FAIL rather than a construct to guess at.
 *       - the invocation must HEAD its `&&`/`||` list (nothing may short-circuit whether it runs)
 *         and no `||` may appear anywhere later in that list (bash's list is left-associative, so
 *         `A && echo done || true` exits 0 when A fails) — including past a pipe further along,
 *         which the scan used to stop at.
 *       - the matched command is the ENTIRE list element, byte for byte. A prefix match let
 *         `npm run lint -w apps/studio -- --help` through while the behavioural half ran the bare
 *         constant, so the command measured and the command CI runs were different commands.
 *
 *     A shape this guard does not understand is a red, never a green. The cost is that a future
 *     legitimate edit — a `paths:` filter, a loop in the step — fails until someone either simplifies
 *     it or teaches the guard the construct, which is the loud direction. An author who WANTS the
 *     step to lie can still write one (`bash -c "$(printf …)"`), and that is out of threat model —
 *     the same stance the rest of this guard takes.
 *   - **Does anything invoke this guard?** Deleting `check:studio-typecheck` from `gate:studio`
 *     makes it a local command nobody runs. Nothing here can see that, so it is asserted from the
 *     guard's tests instead, following `tests/unit/electron-quarantine.test.ts`.
 *
 * The file-coverage walk stays too, and is not redundant with the behavioural check: a file outside
 * the project is checked by nothing, and a planted error inside the project cannot notice its
 * absence.
 *
 * The behavioural half needs a built `dist/`, because the app imports `wigolo/studio` and that
 * specifier resolves through the root package's exports. The `gate` CI job deliberately has no build
 * step (A216: a build failure there would hide the type errors the job exists to find), so the two
 * halves are invoked from two places: `gate:studio` runs `--shape-only` on three OS, and the
 * `studio-unit` job — which already builds core in order to run the app lint at all — runs the full
 * guard. Nothing asserts that wiring from inside this file; its tests do, the same way they assert
 * that anything invokes the guard at all.
 *
 * Pass a root directory as the first positional argument to point it at a fixture tree (used by its
 * own tests), and `--shape-only` to skip the behavioural half.
 */
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo this script lives in, which is NOT necessarily the tree under test: argv[2] points the
// checks at a fixture tree, but the behavioural run always needs a real `node_modules` to resolve
// `tsc` and the app's own dependencies from, and that only ever exists here.
const OWN_REPO = fileURLToPath(new URL('..', import.meta.url));
const ARGS = process.argv.slice(2);
const SHAPE_ONLY = ARGS.includes('--shape-only');
const TARGET = ARGS.find((a) => !a.startsWith('--'));
const ROOT = TARGET ? resolve(TARGET) : OWN_REPO;
const APP = join(ROOT, 'apps', 'studio');
const CONFIG = join(APP, 'tsconfig.json');
const PACKAGE = join(APP, 'package.json');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');

// The exact command the workflow must invoke, and the exact command the behavioural check runs.
const CI_INVOCATION = 'npm run lint -w apps/studio';

// What `npm run lint -w apps/studio` has to actually BE. Kept as a fast pre-filter with a precise
// message; the behavioural check is what makes it un-foolable. `-p <path>` stays allowed — naming
// the project explicitly is the same check written differently, and if the named project is a decoy
// the planted errors go unreported, so the behavioural check decides rather than this regex.
const LINT_SCRIPT = /^tsc(?:\s+(?:-p|--project)\s+\S+)?\s+--noEmit(?:\s+(?:-p|--project)\s+\S+)?$/;

// Build output and installed dependencies are not source the app must type-check, and a guard that
// flagged them would fire on every correctly wired tree — i.e. it would be switched off rather than
// satisfied. `release` is electron-builder's output directory (`directories.output` in
// `electron-builder.config.ts`): on any machine that has packaged the app it holds an unpacked copy
// of the tree, so walking into it reported the app's own files back as uncovered.
const NOT_SOURCE = new Set(['node_modules', 'out', 'dist', 'release']);

// tsconfig paths are always `/`-separated; `path.join` yields `\` on win32. Compare in POSIX form on
// both sides or the guard flags EVERY file as missing on Windows — the exact way
// `check-typecheck-gate.mjs` broke (it named all 58 gated files missing from a config that listed
// them). Casing is folded on the platforms TypeScript itself treats as case-insensitive, so a win32
// drive letter (`C:/` vs `c:/`) cannot reproduce that failure in a second costume.
const posix = (p) => p.split(sep).join('/');
const key = (p) => (ts.sys.useCaseSensitiveFileNames ? posix(p) : posix(p).toLowerCase());
// Every extension TypeScript itself compiles from a directory `include`. Knowing only `.ts`/`.tsx`
// made `.mts`/`.cts` invisible to the guard and therefore checkable by nothing.
const isChecked = (name) => /\.(?:ts|tsx|mts|cts)$/.test(name);

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NOT_SOURCE.has(entry.name)) out.push(...walk(p));
    } else if (isChecked(entry.name)) out.push(p);
  }
  return out;
}

/*
 * One probe per strict check, each an error that appears ONLY while its flag is in effect. The flag
 * list is TypeScript's own (`strictFlag` on the option declarations) rather than a hand-copied one,
 * so a strict check added by a future compiler release arrives here as an unprobed flag rather than
 * as a silent hole. Every probe was validated both ways: with the whole family on, all of them
 * report; with one flag off, exactly that probe's diagnostic disappears.
 *
 * `expect` is the diagnostic code, not merely "some error in this file". A probe that errored for an
 * unrelated reason (a `lib` too old for `Array.prototype.values`, say) would otherwise read as
 * "this check is in effect" when it is not. That tightening is deliberately unproven: no fixture
 * found so far makes a probe file report a DIFFERENT code while its own flag is off, so loosening
 * this to "any error in the probe file" survives the guard's tests. It is kept because it can only
 * reject, never admit — but do not read the mutation battery as covering it.
 */
const PROBES = [
  {
    flag: null,
    name: 'baseline',
    expect: 2322,
    source: "export const probeBaseline: number = 'not a number';\n",
  },
  {
    flag: 'noImplicitAny',
    name: 'noImplicitAny',
    expect: 7006,
    source: 'export function probeNoImplicitAny(a) {\n  return a;\n}\n',
  },
  {
    flag: 'strictNullChecks',
    name: 'strictNullChecks',
    expect: 2322,
    source: 'export const probeStrictNullChecks: string = null;\n',
  },
  {
    flag: 'strictFunctionTypes',
    name: 'strictFunctionTypes',
    expect: 2322,
    source:
      'const takesString = (value: string): void => {\n  void value;\n};\nexport const probeStrictFunctionTypes: (value: unknown) => void = takesString;\n',
  },
  {
    flag: 'strictBindCallApply',
    name: 'strictBindCallApply',
    expect: 2345,
    source:
      "function probeTarget(a: number): number {\n  return a;\n}\nexport const probeStrictBindCallApply = probeTarget.call(undefined, 'not a number');\n",
  },
  {
    flag: 'strictPropertyInitialization',
    name: 'strictPropertyInitialization',
    expect: 2564,
    source: 'export class ProbeStrictPropertyInitialization {\n  declared: number;\n}\n',
  },
  {
    flag: 'strictBuiltinIteratorReturn',
    name: 'strictBuiltinIteratorReturn',
    expect: 2322,
    source: 'export const probeStrictBuiltinIteratorReturn: number = [1, 2].values().next().value;\n',
  },
  {
    flag: 'noImplicitThis',
    name: 'noImplicitThis',
    expect: 2683,
    source: 'export function probeNoImplicitThis(): unknown {\n  return this;\n}\n',
  },
  {
    flag: 'useUnknownInCatchVariables',
    name: 'useUnknownInCatchVariables',
    expect: 18046,
    source:
      "export function probeUseUnknownInCatchVariables(): string {\n  try {\n    return '';\n  } catch (err) {\n    return err.message;\n  }\n}\n",
  },
];

/*
 * The strict family, as the INSTALLED compiler declares it, pinned against what this file probes.
 *
 * The previous version computed the unprobed set and printed it in the OK line. Prose on stdout is
 * not a gate: a strict check added by a compiler upgrade would arrive as a sentence in a passing run,
 * which is P7's own failure class (a check nothing performs, reported the same as a check that
 * passes) scoped to a single compiler option. Pinned in both directions on purpose — a flag ADDED is
 * a check with no probe, and a flag REMOVED means the probe below proves nothing and should go.
 *
 * `P7_EXTRA_STRICT_FLAGS` and `P7_HIDE_STRICT_FLAGS` exist so both directions have a fixture: the
 * list otherwise comes from the installed TypeScript and cannot be moved from a test. Neither can
 * switch a check off — adding a name leaves it unprobed, and hiding one leaves it undeclared, so
 * every setting of either makes this guard redder than not setting it.
 *
 * That licence held only because the two hooks were independent, and round 6 found they were not:
 * the hide-set was applied to the COMBINED list while `UNDECLARED_FLAGS` was computed against the
 * expected list alone, so `P7_EXTRA_STRICT_FLAGS=x P7_HIDE_STRICT_FLAGS=x` added an unprobed flag
 * and then deleted it before anything looked — green, with the sentence above still in the file
 * claiming it could not be. The hide-set is therefore filtered through `EXPECTED_STRICT_FLAGS`
 * first: hiding a flag this guard expects removes it and reds the undeclared pin, and hiding
 * anything else is a no-op, so neither hook can cancel the other.
 */
const EXPECTED_STRICT_FLAGS = [
  'noImplicitAny',
  'noImplicitThis',
  'strictBindCallApply',
  'strictBuiltinIteratorReturn',
  'strictFunctionTypes',
  'strictNullChecks',
  'strictPropertyInitialization',
  'useUnknownInCatchVariables',
];
const envFlags = (name) => (process.env[name] ?? '').split(',').map((f) => f.trim()).filter(Boolean);
const hidden = new Set(envFlags('P7_HIDE_STRICT_FLAGS').filter((f) => EXPECTED_STRICT_FLAGS.includes(f)));
const STRICT_FLAGS = [
  ...ts.optionDeclarations.filter((o) => o.strictFlag).map((o) => o.name),
  ...envFlags('P7_EXTRA_STRICT_FLAGS'),
].filter((f) => !hidden.has(f));
const UNPROBED_FLAGS = STRICT_FLAGS.filter((f) => !PROBES.some((p) => p.flag === f));
const UNDECLARED_FLAGS = EXPECTED_STRICT_FLAGS.filter((f) => !STRICT_FLAGS.includes(f));

// A GitHub Actions `if:` cannot be evaluated locally, so the guard treats every condition it does
// not recognise as always-true as capable of disabling the step. That direction is deliberate: it can
// only produce a loud false FAIL (fixable by hoisting the condition elsewhere), never a silent pass
// on a step that never executes — which is what `if: false` bought before this existed.
const ALWAYS_TRUE = new Set(['true', 'always()', 'success()']);
const enabled = (condition) => {
  if (condition === undefined || condition === null) return true;
  const normalised = String(condition)
    .trim()
    .replace(/^\$\{\{(.*)\}\}$/s, '$1')
    .trim()
    .toLowerCase();
  return ALWAYS_TRUE.has(normalised);
};

// `continue-on-error` runs the step and then throws its result away: the type-check goes red in the
// step list and the job — and therefore the required check on the pull request — still concludes
// SUCCESS. Read in the same conservative direction as `enabled()`: only an explicit `false` (or the
// absence of the key) enforces, because an expression cannot be evaluated here and guessing it is
// false is the guess that fails silently.
const enforcing = (value) => value === undefined || value === null || String(value).trim().toLowerCase() === 'false';

/*
 * The commands a `run:` block actually executes, in order — not the text it contains.
 *
 * Every check above this line asks whether the invocation is PRESENT. None of them asks whether the
 * shell runs it: `# npm run lint -w apps/studio` is present and inert, and so is
 * `echo "npm run lint -w apps/studio"`. Both were live bypasses, the first reproduced on the real
 * tree with the step still named `Lint studio` and the guard still printing OK.
 *
 * This is not a shell parser and does not try to become one. It is a RECOGNISER for one small
 * language — simple commands joined by `&& || | & ; <newline>` — and everything outside that
 * language is rejected by name. It blanks out the regions a command can hide in without being one
 * (quoted strings, command substitutions, comments), splits what remains on the operators that
 * separate commands, and records the operator on each side.
 *
 * The rejection half is what earlier rounds lacked. `commandPositions` used to fall off the end of
 * its own switch: a heredoc body was scanned as if it were commands, `set +ex` matched no `set +e`
 * pattern, and an unrecognised construct simply left the invocation matched and the step approved.
 * Every one of those was a green bypass. So a construct this cannot model now sets `unmodeled` and
 * the caller reports that the step CANNOT BE PROVEN to run, which is the only honest verdict a
 * recogniser can give about a sentence outside its grammar.
 */
const UNMODELED_WORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi',
  'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'select', 'function', 'coproc', 'time',
  '{', '}',
]);

/*
 * Words that rewrite the block's OWN control flow rather than doing work inside it. A228 settled
 * that an opaque neighbour command (`eval …`, `bash -c …`) is not denied — if the invocation hides
 * inside one it is already `absent` — but these four are a different class: none of them is a
 * neighbour, each of them decides whether the commands around it run or whether their failure
 * reaches the step.
 *
 *   trap 'exit 0' ERR   the errexit abort is caught and turned into a success
 *   exit 0              everything below it never runs, and the step exits 0
 *   return 0            the same, inside a sourced body
 *   exec …              the shell is replaced, so nothing after it exists
 *
 * All four were green with the guard printing "errexit armed", and `trap`/`exit` were bash-verified
 * to exit 0 over a failing type-check.
 */
const CONTROL_FLOW_WORDS = new Set(['trap', 'exit', 'return', 'exec']);

/*
 * `set` as bash reads it: a run of `-`/`+` clusters, where an `o` inside a cluster consumes the next
 * word as a long option name. Only the errexit bit matters here, but the whole thing is PARSED
 * rather than pattern-matched, because every spelling-based detector missed a spelling — the regex
 * `/^set\s+\+[a-zA-Z]*e\b/` was written for `set +e` and matched none of `set +ex`,
 * `set +euo pipefail` or `set +o errexit`, each of which switches errexit off and each of which was
 * a live green bypass. A `set` this cannot parse is unmodeled, never benign.
 */
function readSet(words) {
  let disablesErrexit = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const sign = word[0];
    if ((sign !== '-' && sign !== '+') || !/^[a-zA-Z]+$/.test(word.slice(1))) {
      return { unmodeled: `\`set ${words.join(' ')}\` — this guard reads only \`-\`/\`+\` option clusters` };
    }
    for (const letter of word.slice(1)) {
      if (letter === 'o') {
        const name = words[i + 1];
        if (name === undefined) {
          return { unmodeled: `\`set ${words.join(' ')}\` — \`${sign}o\` with no option name` };
        }
        i++;
        if (name === 'errexit' && sign === '+') disablesErrexit = true;
        continue;
      }
      if (letter === 'e' && sign === '+') disablesErrexit = true;
    }
  }
  return { disablesErrexit };
}

/** Tokenise a `run:` body, or report the first construct outside the modeled grammar. */
function readRun(runText) {
  // Scanned on the RAW body, before anything below blanks a quoted region. The runner substitutes a
  // workflow expression before the shell sees this text, and QUOTING DOES NOT STOP IT: with
  // `matrix.suffix: ["x' || true #"]`, the body `… '${{ matrix.suffix }}'` reaches bash as
  // `… 'x' || true #'`. The unquoted spelling was denied while the quoted one `continue`d past the
  // check inside the loop, so adding two quotes flipped the verdict on the identical bypass.
  if (runText.includes('${{')) {
    return {
      unmodeled:
        'a `${{ … }}` workflow expression — the runner rewrites the body before the shell sees it, so what runs is not the text in the file (quoting it changes nothing: the substitution happens first)',
    };
  }
  const commands = [];
  let buf = '';
  let before = null;
  let quote = null;
  let subst = 0;
  let unmodeled = null;
  // Whether the NEXT raw character begins a word, tracked on the raw text rather than inferred from
  // `buf`. Quoted regions blank to spaces so that `-w "apps/studio"` still reads as the invocation,
  // and that blanking used to manufacture a word boundary bash does not have: `… apps/studio ""#`
  // became `… apps/studio   #`, so the guard saw a comment swallowing the `|| true` after it while
  // bash — for which `#` mid-word is an ordinary character — ran the rescue. Bash-verified:
  // `false ""# || echo RESCUED` prints RESCUED and exits 0.
  let atWordStart = true;
  const deny = (why) => {
    if (!unmodeled) unmodeled = why;
  };
  const finish = (after) => {
    if (buf.trim() === '') {
      // A blank line, a comment-only line, or the newline bash treats as a continuation after a
      // trailing `&&`. None of them is a command, and swallowing them keeps `a &&\nb` reading as one
      // list rather than as two — which is what bash does.
      buf = '';
      if (after !== null && after !== '\n' && after !== ';') deny(`an empty command in front of \`${after}\``);
      return;
    }
    commands.push({ text: buf.replace(/\s+/g, ' ').trim(), before, after });
    buf = '';
    before = after;
  };
  for (let i = 0; i < runText.length; i++) {
    const c = runText[i];
    const two = runText.slice(i, i + 2);
    if (quote) {
      if (c === '\\' && quote !== "'") { buf += '  '; i++; atWordStart = false; continue; }
      if (c === quote) quote = null;
      buf += ' ';
      atWordStart = false;
      continue;
    }
    if (subst > 0) {
      if (two === '$(') { subst++; buf += '  '; i++; atWordStart = false; continue; }
      if (c === ')') subst--;
      buf += ' ';
      atWordStart = false;
      continue;
    }
    if (two === '$(') { subst = 1; buf += '  '; i++; atWordStart = false; continue; }
    // A heredoc redirects the lines that follow into a command's stdin. Round 6 put the invocation
    // inside a `cat <<EOF` body: every line there was scanned as a command in command position
    // while `cat` swallowed the lot.
    if (two === '<<') {
      deny('a heredoc (`<<`) — its body is data for another command, not commands, and this guard cannot tell where it ends');
      break;
    }
    if (c === '\\') {
      // A line continuation joins two lines into one command; any other escape is opaque, and in
      // particular `\;` and `\&` are characters rather than command separators.
      if (two === '\\\n') { i++; atWordStart = true; continue; }
      buf += '  ';
      i++;
      atWordStart = false;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; buf += ' '; atWordStart = false; continue; }
    if (c === '#' && atWordStart) {
      while (i < runText.length && runText[i] !== '\n') i++;
      finish('\n');
      atWordStart = true;
      continue;
    }
    if (c === '(' || c === ')') {
      deny('a subshell or grouping construct (`(` … `)`) — this guard does not model what runs inside one');
      break;
    }
    if (two === '&&' || two === '||') { finish(two); i++; atWordStart = true; continue; }
    if (two === '|&') {
      deny('`|&` — a pipeline of both output streams, which this guard does not model');
      break;
    }
    if (c === '|') { finish('|'); atWordStart = true; continue; }
    // `2>&1` and `>& log` are redirections, and so is `&> log` — splitting at any of them would
    // report a redirected invocation as backgrounded, a false FAIL on an ordinary way to write the
    // step. The backwards test alone missed `&>`, which is the same operator written the other way
    // round.
    if (c === '&' && !/>\s*$/.test(buf) && runText[i + 1] !== '>') { finish('&'); atWordStart = true; continue; }
    if (two === ';;') {
      deny('`;;` — a `case` clause terminator, which this guard does not model');
      break;
    }
    if (c === ';') { finish(';'); atWordStart = true; continue; }
    if (c === '\n') { finish('\n'); atWordStart = true; continue; }
    buf += c;
    atWordStart = /\s/.test(c);
  }
  finish(null);
  if (unmodeled) return { unmodeled };

  for (const command of commands) {
    const words = command.text.replace(/^!\s+/, '').split(' ').filter(Boolean);
    const head = words[0];
    if (head !== undefined && UNMODELED_WORDS.has(head)) {
      return { unmodeled: `the shell keyword \`${head}\` — a compound command or condition context, where a failure need not abort the block at all` };
    }
    if (head !== undefined && CONTROL_FLOW_WORDS.has(head)) {
      return {
        unmodeled: `the control-flow builtin \`${head}\` — it rewrites which commands run and whether their failure reaches the step (\`trap '…' ERR\` catches the errexit abort, \`exit\`/\`return\` end the body early, \`exec\` replaces the shell), and this guard does not model that`,
      };
    }
    if (words.includes('{') || words.includes('}')) {
      return { unmodeled: 'a `{ … }` brace group — this guard does not model what runs inside one' };
    }
    if (head === 'set') {
      const effect = readSet(words.slice(1));
      if (effect.unmodeled) return { unmodeled: effect.unmodeled };
      command.disablesErrexit = effect.disablesErrexit;
    }
  }
  return { commands };
}

// Operators that throw away the exit code of the command to their left. `;` and a newline are NOT
// among them: GitHub runs `run:` blocks under `bash -e` (`shell: bash` adds `-o pipefail` on top), so
// a failing command aborts the block and its status becomes the step's. That is why a multi-line
// block grouping output around the invocation stays legal — rejecting it would forbid the one
// multi-line form CI actually uses, and a guard that forbids correct code gets switched off.
const DISCARDS_EXIT_CODE = {
  '||': 'the command to its right runs instead and the step reports that one',
  '|': 'the pipeline reports its LAST stage, so a failing type-check is masked by whatever consumes it',
  '&': 'a backgrounded command is never waited for, so its exit code reaches nothing',
};

// The operators that START a new `&&`/`||` list rather than continuing one. A command introduced by
// any of them heads its own list, which is the only position where errexit can carry its failure out
// to the step.
const LIST_HEAD = new Set([null, '\n', ';']);

/*
 * Redirections attached to a command, which move its streams and leave its exit code alone. They
 * are stripped before the invocation is compared so that `npm run lint -w apps/studio > lint.log
 * 2>&1` still reads as the invocation — a correctly wired step written the ordinary way, and a
 * false FAIL is how a guard gets deleted rather than obeyed. Every OTHER trailing word is an
 * argument, and arguments are not stripped: see `appended` below.
 */
const REDIRECTION = /(?:^|\s)(?:\d*(?:>>?|<)&?\s*\S*|&>>?\s*\S*)/g;
const bareCommand = (text) => text.replace(/^!\s*/, '').replace(REDIRECTION, ' ').replace(/\s+/g, ' ').trim();

/** Where the invocation sits in a `run:` block, and whether its failure can still fail the step. */
function invocationSemantics(runText) {
  const read = readRun(runText);
  if (read.unmodeled) return { kind: 'unmodeled', why: read.unmodeled };
  const commands = read.commands;
  // The match is the ENTIRE list element, exactly. A prefix match accepted anything beginning with
  // the invocation plus a space while the behavioural half below ran the bare `CI_INVOCATION`
  // constant — so the command this guard measures and the command CI runs were different commands.
  // `npm run lint -w apps/studio -- --help` makes CI run `tsc --noEmit --help`, which prints help,
  // checks nothing and exits 0, while the guard reported every planted error found.
  const index = commands.findIndex(({ text }) => bareCommand(text) === CI_INVOCATION);
  if (index === -1) {
    const appended = commands.find(({ text }) => bareCommand(text).startsWith(`${CI_INVOCATION} `));
    if (appended) {
      return { kind: 'appended', extra: bareCommand(appended.text).slice(CI_INVOCATION.length).trim() };
    }
    return { kind: 'absent' };
  }
  const command = commands[index];
  if (/^!\s*/.test(command.text)) {
    return { kind: 'discarded', why: '`!` inverts it, so the step passes exactly when the type-check fails' };
  }
  // `git diff --quiet apps/studio || npm run lint -w apps/studio` runs the type-check only on the
  // runs where the predecessor failed; on every other run the list exits 0 having checked nothing.
  // `&&` in front is the same class one notch quieter. Neither is a shape a correct step needs, so
  // the invocation is required to HEAD its list.
  if (!LIST_HEAD.has(command.before)) {
    return { kind: 'conditional', operator: command.before };
  }
  // Bash's `&&`/`||` list is left-associative and a failure walks RIGHT along it looking for a `||`
  // to hand control to: `A && echo done || true` exits 0 when A fails. Reading only the invocation's
  // immediate `after` operator therefore proved nothing — the whole list to the end has to be clean.
  for (let j = index; j < commands.length; j++) {
    const after = commands[j].after;
    if (after === null || after === '\n' || after === ';') break;
    // `A && (B | C)` binds the pipe tighter than the list, so a pipe further along cannot touch the
    // invocation's own status. Only a pipe on the invocation itself does. But the SCAN must go on:
    // this used to `break`, which abandoned the rest of the list, so
    // `npm run lint -w apps/studio && echo done | cat || true` never reached its `||` — and bash
    // reads that as `A && (echo done|cat) || true`, which rescues A's failure and exits 0
    // (bash-verified; the same line without the `|| true` correctly exits 1).
    if (after === '|' && j > index) continue;
    // `&&` is the one operator that carries a failure onward, so it is the one with no entry here.
    // Every verdict below is read OUT of the table rather than decided beside it, which is what
    // makes deleting a row from the table a behaviour change that a fixture can catch.
    const why = DISCARDS_EXIT_CODE[after];
    if (!why) continue;
    return {
      kind: 'discarded',
      operator: after,
      why:
        after === '||' && j > index
          ? "a `||` further along the same left-associative list rescues the whole chain — a failure walks right past every `&&` to the first `||` and the list exits with THAT command's status"
          : why,
    };
  }
  const disarmed = commands.slice(0, index).some((c) => c.disablesErrexit);
  if (disarmed) return { kind: 'disarmed' };
  return { kind: 'enforced' };
}

const failures = [];

// ---------------------------------------------------------------------------------------------
// 1. Does the project contain every TypeScript file the app has on disk?
// ---------------------------------------------------------------------------------------------

const raw = ts.readConfigFile(CONFIG, ts.sys.readFile);
if (raw.error) {
  failures.push(`apps/studio/tsconfig.json is unreadable: ${ts.flattenDiagnosticMessageText(raw.error.messageText, ' ')}`);
}

const parsed = raw.error ? { fileNames: [], options: {} } : ts.parseJsonConfigFileContent(raw.config, ts.sys, APP);

const covered = new Set(parsed.fileNames.map(key));

// Every TypeScript file under the app, not an enumerated list of the places we happen to keep them.
// The enumeration was the hole: it named `src`, `tests` and the root `*.config.ts` files, so an
// `apps/studio/scripts/x.ts` was expected by nothing and checked by nothing — P7 reproduced inside
// its own guard. Asking the filesystem what exists cannot go stale as the app grows.
const expected = walk(APP);

const uncovered = expected.filter((p) => !covered.has(key(p)));
if (uncovered.length) {
  failures.push(
    `apps/studio/tsconfig.json does not cover ${uncovered.length} file(s) that exist on disk — they are type-checked by nothing:\n` +
      uncovered.map((p) => `    - ${posix(relative(ROOT, p))}`).join('\n')
  );
}

// ---------------------------------------------------------------------------------------------
// 2. Fast pre-filters. Each produces a sharper message than the behavioural run would for the
//    blunt case it names, and each is identified by that message in the guard's tests.
// ---------------------------------------------------------------------------------------------

if (!raw.error && parsed.options.strict !== true) {
  failures.push('apps/studio/tsconfig.json must set `strict: true` — a non-strict project sees every file and finds almost nothing.');
}

if (UNPROBED_FLAGS.length) {
  failures.push(
    `the installed TypeScript (${ts.version}) declares ${UNPROBED_FLAGS.length} strict check(s) with no probe in this guard: ${UNPROBED_FLAGS.join(', ')}. ` +
      'A strict check nothing plants an error for is asserted only by `strict: true`, which stays true while the check is individually switched off — the bypass this guard already closed once. Add a probe to PROBES, or state why it cannot have one.'
  );
}

if (UNDECLARED_FLAGS.length) {
  failures.push(
    `this guard probes ${UNDECLARED_FLAGS.length} strict check(s) the installed TypeScript (${ts.version}) no longer declares: ${UNDECLARED_FLAGS.join(', ')}. ` +
      'Their probes now prove nothing about the app; remove them from PROBES and from EXPECTED_STRICT_FLAGS together.'
  );
}

if (!existsSync(PACKAGE)) {
  failures.push('apps/studio/package.json is missing — nothing defines what `npm run lint -w apps/studio` runs.');
} else {
  let scripts = null;
  try {
    scripts = JSON.parse(readFileSync(PACKAGE, 'utf8')).scripts ?? {};
  } catch (err) {
    failures.push(`apps/studio/package.json is unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (scripts) {
    const lint = typeof scripts.lint === 'string' ? scripts.lint.trim() : '';
    if (!LINT_SCRIPT.test(lint)) {
      failures.push(
        `apps/studio's \`lint\` script is ${lint ? `\`${lint}\`` : 'not defined'} — CI runs \`${CI_INVOCATION}\`, so this script IS the app's type-check. It must run \`tsc --noEmit\` (optionally with \`-p <path>\`).`
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Is the command wired into CI, in a step that can actually execute?
// ---------------------------------------------------------------------------------------------

/*
 * The branch this program's pull requests target. A workflow whose triggers exclude it is a file
 * full of correct, unconditional, dead steps — a state this repo has already been in once: until
 * `e29d14d7`, `pull_request` was `main`-only, so the 3-OS matrix and the type gate ran on PUSH, i.e.
 * after merge, and every slice merged with the gate having blocked nothing.
 *
 * Reversal condition: when the Studio program merges to `main` and this branch retires, this becomes
 * `main` (or both). Recorded in DECISIONS-AUTO as A224.
 */
const ENFORCED_BRANCH = 'studio-handoff';

/**
 * A GitHub branch filter — `main`, `studio-*`, `**` — as a matcher.
 *
 * Runs of `*` collapse to one BEFORE compiling. `MODELED_PATTERN` admits any number of them, and
 * each became a `.*`, so `'*'.repeat(24) + 'zzz'` compiled to 24 chained `.*` in front of a literal
 * that cannot match: the engine then walks every way of splitting the branch name between them and
 * the guard runs past 60 seconds, i.e. a workflow file can hang its own gate. Collapsing is
 * behaviour-preserving — `.*.*` matches exactly what `.*` matches — and was checked across `main`,
 * `*`, `**`, `studio-*`, `releases/**` and `feat/**\/x`.
 */
const branchFilter = (pattern) =>
  new RegExp(
    `^${String(pattern)
      .replace(/\*+/g, '*')
      .split('*')
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`
  );

// The only two per-event keys this guard models. Everything else changes WHETHER a run starts in a
// way it cannot evaluate from the file alone, so everything else is a FAIL:
//   - `paths` / `paths-ignore` decide by the diff. `paths-ignore: [apps/**]` means an edit touching
//     only the studio app starts no run at all — the step is present, enabled, correct and never
//     reached, which is P7 moved one layer up.
//   - `types` narrows a `pull_request` to activity types. `types: [labeled]` never fires for a code
//     push to the PR branch.
//   - `tags` / `tags-ignore` on `push` never fire for a branch push.
// Round 6 reproduced all of these green, because the previous reader inspected `branches` and
// `branches-ignore` and returned `true` for a config carrying anything else.
const MODELED_EVENT_KEYS = new Set(['branches', 'branches-ignore']);

// A GitHub filter pattern this guard can compile. `*` and `**` are handled by `branchFilter`;
// `!`, `?`, `+` and character classes are not, and `!` is the dangerous one — it is an EXCLUSION, so
// `['**', '!studio-handoff']` reads to `branchFilter` as a literal branch named `!studio-handoff`
// (matching nothing, hence harmless) while GitHub reads it as "every branch EXCEPT this one".
const MODELED_PATTERN = /^[A-Za-z0-9._/*-]+$/;

/**
 * Does `event` fire for `ENFORCED_BRANCH`? `null`/absent config means no filter at all, which fires
 * for every branch — the most permissive wiring there is, and one this must not reject. Anything
 * else must be a mapping built only from keys and patterns this guard models; if it is not, the
 * answer is "cannot prove it does", which is a FAIL.
 */
function firesForBranch(config, event) {
  if (config === null || config === undefined) return true;
  if (typeof config !== 'object' || Array.isArray(config)) {
    return `\`on.${event}\` is ${Array.isArray(config) ? 'a list' : `a ${typeof config}`}, not a filter mapping — this guard cannot prove the workflow runs for \`${ENFORCED_BRANCH}\`. Simplify the trigger, or extend the guard`;
  }
  const unknown = Object.keys(config).filter((k) => !MODELED_EVENT_KEYS.has(k));
  if (unknown.length) {
    return (
      `\`on.${event}\` carries ${unknown.map((k) => `\`${k}\``).join(', ')}, which this guard does not model — ` +
      `it cannot prove a run starts for \`${ENFORCED_BRANCH}\`, and a filter that stops the run makes every step below it dead. ` +
      `(\`paths\`/\`paths-ignore\` decide by the diff, so an app-only edit can start nothing; \`types\` can narrow a pull_request to activity a code push never raises; a tag filter never fires for a branch push.) ` +
      'Reduce the trigger to `branches`/`branches-ignore`, or extend the guard'
    );
  }
  if ('branches' in config && 'branches-ignore' in config) {
    return `\`on.${event}\` sets both \`branches\` and \`branches-ignore\`, which GitHub rejects — this guard will not guess which one wins`;
  }
  for (const listKey of ['branches', 'branches-ignore']) {
    if (!(listKey in config)) continue;
    const list = config[listKey];
    if (!Array.isArray(list)) {
      return `\`on.${event}.${listKey}\` is ${list === null ? 'empty' : `a ${typeof list}`}, not a list of patterns — this guard models only a list, so it cannot prove the workflow runs for \`${ENFORCED_BRANCH}\``;
    }
    const unreadable = list.filter((p) => typeof p !== 'string' || !MODELED_PATTERN.test(p));
    if (unreadable.length) {
      return (
        `\`on.${event}.${listKey}\` contains ${unreadable.map((p) => `\`${String(p)}\``).join(', ')}, a pattern this guard does not model — ` +
        `a leading \`!\` is an EXCLUSION, so \`['**', '!${ENFORCED_BRANCH}']\` never fires for this branch while reading like the most permissive filter there is. ` +
        '`?`, `+` and character classes are unmodelled for the same reason. Cannot prove this runs'
      );
    }
  }
  const ignore = config['branches-ignore'];
  if (Array.isArray(ignore) && ignore.some((p) => branchFilter(p).test(ENFORCED_BRANCH))) {
    return `\`on.${event}.branches-ignore\` excludes \`${ENFORCED_BRANCH}\``;
  }
  const branches = config.branches;
  if (Array.isArray(branches)) {
    return branches.some((p) => branchFilter(p).test(ENFORCED_BRANCH))
      ? true
      : `\`on.${event}.branches\` is [${branches.join(', ')}] — it never fires for \`${ENFORCED_BRANCH}\``;
  }
  return true;
}

// `strategy` decides how many times a job runs, and ZERO is a legal answer: a matrix whose only
// dimension evaluates to an empty list produces no legs, and a job with no legs is reported as
// skipped — which rolls up to the run's conclusion as SUCCESS. The step is present, enabled,
// correctly written and executed zero times. Read default-deny like everything else here: a
// `strategy` whose leg count this cannot compute from literals in the file is a FAIL.
const MODELED_STRATEGY_KEYS = new Set(['matrix', 'fail-fast', 'max-parallel']);

function strategyRuns(job) {
  const strategy = job.strategy;
  if (strategy === undefined || strategy === null) return true;
  if (typeof strategy !== 'object' || Array.isArray(strategy)) {
    return 'its `strategy` is not a mapping, so this guard cannot prove the job runs at all';
  }
  const unknown = Object.keys(strategy).filter((k) => !MODELED_STRATEGY_KEYS.has(k));
  if (unknown.length) {
    return `its \`strategy\` carries ${unknown.map((k) => `\`${k}\``).join(', ')}, which this guard does not model`;
  }
  if (!('matrix' in strategy)) return true;
  const matrix = strategy.matrix;
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    return `its \`strategy.matrix\` is ${matrix === null || matrix === undefined ? 'empty' : `a ${typeof matrix}`} rather than a mapping of literal lists — a matrix that evaluates to zero legs runs the step zero times and reports SUCCESS`;
  }
  if ('exclude' in matrix) {
    return 'its `strategy.matrix` carries `exclude`, which can remove every remaining combination — this guard cannot compute the surviving leg count';
  }
  // `include` is not a dimension: it only ADDS legs (or adds keys to legs the dimensions already
  // produced), so it can never take the count to zero. Treating it as one made
  // `os: [ubuntu-latest]` + `include: []` a FAIL on a job that provably runs once — a false
  // accusation on a healthy tree, the same class the `exclude` special-case above already handles
  // from the other direction.
  const entries = Object.entries(matrix).filter(([name]) => name !== 'include');
  if (!entries.length) {
    // With no dimensions left, `include` alone decides the count — one leg per entry.
    if (Array.isArray(matrix.include) && matrix.include.length > 0) return true;
    return 'its `strategy.matrix` declares no dimensions, so it produces no legs and the job runs the step zero times';
  }
  for (const [name, values] of entries) {
    if (!Array.isArray(values) || values.length === 0) {
      return `its \`strategy.matrix.${name}\` is ${Array.isArray(values) ? 'an empty list' : `a ${typeof values}`} rather than a non-empty literal list — this guard cannot prove the job produces even one leg, and a job with zero legs is skipped, which reports SUCCESS`;
    }
  }
  return true;
}

/*
 * THE KEY LAYER — one layer out from the `run:` grammar, and the layer round 7 found still open.
 *
 * Rounds 3–6 made the `run:` BODY default-deny. But the step and job KEYS that decide what that body
 * MEANS stayed a blacklist: the reader looked at `if`, `continue-on-error`, `strategy` and `run`, and
 * every other key was invisible. `shell:` was never read at all, so the entire `;`/newline safety
 * argument below — which rests on GitHub running the body under a shell with errexit — was asserted
 * about a shell nobody had checked; `needs:` was never read, so a `needs:` on a job that is skipped
 * takes this job with it and a skipped job rolls up as SUCCESS; and `container:`, `services:`,
 * `working-directory:`, `defaults:` and `uses:` were all silently ignored while each of them changes
 * where or whether the command runs.
 *
 * So the keys are an ALLOWLIST, exactly like the `run:` grammar. A key not named here is a FAIL that
 * names the key. The three tolerated keys that do NOT change whether the step runs are in the list on
 * purpose, because the real `ci.yml` carries them and a guard that fires on the tree it guards gets
 * deleted rather than obeyed:
 *
 *   - `env` — an environment mapping. It CAN in principle redirect a command (an `npm_config_*`), and
 *     that is the same class as `bash -c "$(printf …)"`: out of threat model here, as A228 settled.
 *   - `timeout-minutes` — a cap. It can only turn a slow step RED, never green.
 *   - `runs-on` / `name` / `id` — the label and the machine, neither of which is execution semantics.
 *
 * Everything else — including keys nobody has thought of yet — is denied by DEFAULT rather than by
 * enumeration, which is the whole point of A227.
 */
const MODELED_JOB_KEYS = new Set([
  'name', 'runs-on', 'steps', 'strategy', 'if', 'continue-on-error', 'env', 'timeout-minutes',
]);
const MODELED_STEP_KEYS = new Set([
  'name', 'id', 'run', 'shell', 'if', 'continue-on-error', 'env', 'timeout-minutes',
]);

const unmodeledKeys = (value, modeled) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).filter((k) => !modeled.has(k))
    : [];

/*
 * `shell:` — the key every verdict about `;` and newlines silently assumed.
 *
 * GitHub invokes an explicit `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`, and an
 * absent `shell:` as `bash -e {0}` on Linux and macOS. Both arm errexit, which is what makes
 * `A; B` and a multi-line body safe: A's failure aborts the block and becomes the step's status.
 *
 * A TEMPLATE value does not. `shell: bash --noprofile --norc {0}` is still bash, still reads like
 * the default, and has no `-e` at all: `npm run lint -w apps/studio; echo done` then exits 0 over a
 * failing type-check while this guard printed "errexit armed". So only the two spellings above are
 * accepted, and every other value FAILs naming the key rather than being assumed to be a shell.
 */
const MODELED_SHELLS = new Set(['bash']);

/**
 * Can this job land on a Windows runner? Positive evidence only — a literal `runs-on`, or a
 * `runs-on: ${{ matrix.X }}` resolved through a literal `matrix.X` list. It matters because an
 * ABSENT `shell:` is only `bash -e` on Linux and macOS; on Windows the default is pwsh, which has
 * no errexit, so deleting the explicit `shell: bash` from the real 3-OS `studio-unit` job would
 * quietly move one leg to a shell none of the reasoning above applies to.
 */
function runsOnWindows(job) {
  const target = job['runs-on'];
  const candidates = [];
  const collect = (v) => {
    if (typeof v === 'string') candidates.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
  };
  collect(target);
  const viaMatrix = typeof target === 'string' && /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(target.trim());
  if (viaMatrix) collect(job.strategy?.matrix?.[viaMatrix[1]]);
  return candidates.some((c) => /windows/i.test(c));
}

/** The shell the step's body runs under, or why this guard cannot name it. */
function shellSemantics(job, step) {
  const shell = step.shell;
  if (shell === undefined || shell === null) {
    return runsOnWindows(job)
      ? 'has no `shell:` key while its job can run on a Windows runner — the default there is pwsh, which has no errexit, so a failing command does not abort the body and every `;`/newline verdict this guard makes about the body is false. Spell the shell out as `shell: bash`'
      : null;
  }
  if (typeof shell === 'string' && MODELED_SHELLS.has(shell.trim())) return null;
  return `carries \`shell: ${String(shell).trim()}\`, which this guard does not model — only \`shell: bash\` (which GitHub invokes as \`bash --noprofile --norc -eo pipefail {0}\`) and an absent \`shell:\` on a non-Windows runner arm the errexit that every \`;\`/newline verdict below depends on. A template form such as \`bash --noprofile --norc {0}\` looks like the default and drops \`-e\``;
}

/**
 * Workflow-level `defaults:` sets the shell and working directory for EVERY step in the file,
 * including this one, from a place the step-level reader never looks. The job-level spelling is
 * denied by `MODELED_JOB_KEYS`; this is the same key one level up.
 */
function checkWorkflowDefaults(doc) {
  if (doc.defaults === undefined || doc.defaults === null) return [];
  return [
    '.github/workflows/ci.yml sets a workflow-level `defaults:`, which this guard does not model — it can set `run.shell` and `run.working-directory` for every step in the file, so the shell the app type-check runs under is decided somewhere the step does not say. Move the setting onto the step, or extend the guard.',
  ];
}

/**
 * `on:` — the layer above every other check here. A step can be present, enabled, unconditional,
 * correctly written and never executed, because nothing ever starts the run that would execute it.
 */
function checkTriggers(doc) {
  // YAML 1.1 parsers read a bare `on` as the boolean `true`; this one (YAML 1.2 core schema) keeps
  // it a string. Accept both rather than depend on which schema the parser was built with.
  const raw = doc.on ?? doc[true] ?? doc['true'];
  if (raw === undefined || raw === null) {
    return ['.github/workflows/ci.yml declares no `on:` — a workflow with no triggers never runs, so every step in it enforces nothing.'];
  }
  let events;
  if (typeof raw === 'string') events = { [raw]: null };
  else if (Array.isArray(raw)) events = Object.fromEntries(raw.map((e) => [String(e), null]));
  else if (typeof raw === 'object') events = raw;
  else return [`.github/workflows/ci.yml has an unreadable \`on:\` (${typeof raw}).`];

  const out = [];
  for (const event of ['pull_request', 'push']) {
    if (!(event in events)) {
      out.push(
        `.github/workflows/ci.yml never runs on \`${event}\` — the app type-check is wired into a workflow that this branch's ${event === 'pull_request' ? 'pull requests' : 'pushes'} never start, so the step is present, enabled and dead. A type gate that does not run on \`pull_request\` blocks nothing.`
      );
      continue;
    }
    const fires = firesForBranch(events[event], event);
    if (fires !== true) {
      out.push(`.github/workflows/ci.yml does not run for \`${ENFORCED_BRANCH}\`: ${fires}. The step is present and enabled, and never executes on this branch.`);
    }
  }
  return out;
}

function checkWorkflow() {
  if (!existsSync(WORKFLOW)) {
    return ['.github/workflows/ci.yml is missing — the app type-check cannot be CI-enforced.'];
  }
  let doc;
  try {
    doc = parseYaml(readFileSync(WORKFLOW, 'utf8'));
  } catch (err) {
    return [`.github/workflows/ci.yml is not parseable YAML: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (!doc || typeof doc !== 'object') {
    return ['.github/workflows/ci.yml is empty — nothing in it can invoke the app type-check.'];
  }
  const workflowFailures = [...checkTriggers(doc), ...checkWorkflowDefaults(doc)];
  const jobs = doc.jobs;
  if (!jobs || typeof jobs !== 'object') {
    return [...workflowFailures, '.github/workflows/ci.yml declares no `jobs:` — nothing in it can invoke the app type-check.'];
  }
  const rejected = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object' || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!step || typeof step !== 'object' || typeof step.run !== 'string') continue;
      if (!step.run.includes(CI_INVOCATION)) continue;
      // Named on every rejection: "somewhere in ci.yml" is not actionable in a file with 20 steps,
      // and the shape this issue reproduced live left the step's NAME correct while gutting its body.
      const where = `job \`${jobName}\` step \`${typeof step.name === 'string' ? step.name : '(unnamed)'}\``;
      const unmodeledJobKeys = unmodeledKeys(job, MODELED_JOB_KEYS);
      if (unmodeledJobKeys.length) {
        rejected.push(
          `job \`${jobName}\` carries the unmodelled key(s) ${unmodeledJobKeys.map((k) => `\`${k}\``).join(', ')} — each of them can change whether the step runs, where it runs, or whether its result is believed, and this guard reads none of them. ` +
            '(`needs:` ties this job to another that may be skipped, and a skipped job rolls up as SUCCESS; `container:`/`services:` move the whole job elsewhere; `defaults:` sets the shell from outside the step.) Remove the key, or extend the guard to model it'
        );
        continue;
      }
      const unmodeledStepKeys = unmodeledKeys(step, MODELED_STEP_KEYS);
      if (unmodeledStepKeys.length) {
        rejected.push(
          `${where} carries the unmodelled key(s) ${unmodeledStepKeys.map((k) => `\`${k}\``).join(', ')} — each of them can change what the step actually executes, and this guard reads none of them. ` +
            '(`working-directory:` resolves `-w apps/studio` against a different tree, so the command can type-check a decoy; `uses:` replaces the body entirely.) Remove the key, or extend the guard to model it'
        );
        continue;
      }
      const shellWhy = shellSemantics(job, step);
      if (shellWhy) {
        rejected.push(`${where} ${shellWhy}`);
        continue;
      }
      if (!enabled(job.if)) {
        rejected.push(`job \`${jobName}\` is conditional on \`if: ${String(job.if).trim()}\``);
        continue;
      }
      if (!enabled(step.if)) {
        rejected.push(`the step in job \`${jobName}\` is conditional on \`if: ${String(step.if).trim()}\``);
        continue;
      }
      const legs = strategyRuns(job);
      if (legs !== true) {
        rejected.push(`job \`${jobName}\` cannot be proven to run: ${legs}`);
        continue;
      }
      if (!enforcing(job['continue-on-error'])) {
        rejected.push(
          `job \`${jobName}\` is marked \`continue-on-error: ${String(job['continue-on-error']).trim()}\` — it runs the type-check and reports SUCCESS however it went`
        );
        continue;
      }
      if (!enforcing(step['continue-on-error'])) {
        rejected.push(
          `${where} is marked \`continue-on-error: ${String(step['continue-on-error']).trim()}\` — the type-check runs, fails red in the step list, and the job still concludes SUCCESS`
        );
        continue;
      }
      const semantics = invocationSemantics(step.run);
      if (semantics.kind === 'unmodeled') {
        rejected.push(
          `${where} carries \`${CI_INVOCATION}\` in a \`run:\` body this guard cannot fully read — it contains ${semantics.why}. Cannot prove this runs, so it will not report that it does: simplify the step, or extend the guard to model the construct`
        );
        continue;
      }
      if (semantics.kind === 'conditional') {
        rejected.push(
          `${where} runs \`${CI_INVOCATION}\` with \`${semantics.operator}\` in FRONT of it, so a predecessor decides whether it runs at all — with \`||\` the type-check is skipped on every run where the predecessor succeeded, and the step passes having checked nothing`
        );
        continue;
      }
      if (semantics.kind === 'appended') {
        rejected.push(
          `${where} runs \`${CI_INVOCATION}\` with \`${semantics.extra}\` APPENDED, so CI does not run the command this guard measures — npm forwards everything after \`--\` to the script, and \`-- --help\` makes it \`tsc --noEmit --help\`, which prints help, checks nothing and exits 0, while \`-- -p tsconfig.decoy.json\` re-points the project at a decoy. The behavioural half below runs \`${CI_INVOCATION}\` bare, so an appended argument makes the measured command and the CI command two different commands. The invocation must be the ENTIRE command, exactly`
        );
        continue;
      }
      if (semantics.kind === 'absent') {
        rejected.push(
          `${where} mentions \`${CI_INVOCATION}\` but not as a command it runs — it is inside a shell comment, a quoted string, a command substitution or a construct this guard does not read as a command. Text the shell does not execute enforces nothing`
        );
        continue;
      }
      if (semantics.kind === 'discarded') {
        rejected.push(
          `${where} runs \`${CI_INVOCATION}\`${semantics.operator ? ` followed by \`${semantics.operator}\`` : ''}, which discards its exit code — ${semantics.why}. The type-check runs, prints its errors, and the step passes`
        );
        continue;
      }
      if (semantics.kind === 'disarmed') {
        rejected.push(
          `${where} switches errexit off (a \`set +e\` in any of its spellings — \`+e\`, \`+ex\`, \`+euo pipefail\`, \`+o errexit\`) before \`${CI_INVOCATION}\`, which disarms the abort the step's exit code depends on — a failing type-check no longer fails the step`
        );
        continue;
      }
      return workflowFailures;
    }
  }
  if (rejected.length) {
    return [
      ...workflowFailures,
      `.github/workflows/ci.yml invokes \`${CI_INVOCATION}\` only from a step that cannot be relied on to run and enforce it:\n` +
        rejected.map((d) => `    - ${d}`).join('\n') +
        '\n    A step that never executes, or whose failure reaches nothing, enforces nothing — which is exactly known issue P7. This reader is DEFAULT-DENY at both layers: any step or job key outside the modeled set, any `shell:` other than `bash`, conditions other than `true`/`always()`/`success()`, any `continue-on-error` other than a literal `false`, a matrix whose leg count is not a non-empty literal, and any shell construct outside `simple commands joined by && || | & ; newline` are all reported as unproven rather than assumed benign.',
    ];
  }
  return [
    ...workflowFailures,
    `.github/workflows/ci.yml has no enabled \`run:\` step invoking \`${CI_INVOCATION}\` — the app type-check is a local command nobody runs, which is exactly known issue P7. (A comment, or the text appearing anywhere other than a step's \`run:\`, does not count.)`,
  ];
}

failures.push(...checkWorkflow());

// ---------------------------------------------------------------------------------------------
// 4. The behavioural assertion. Everything above describes the check; this one runs it.
// ---------------------------------------------------------------------------------------------

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mirror the app into `dst`, skipping the directories that are not source. */
function mirror(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!NOT_SOURCE.has(entry.name)) mirror(join(src, entry.name), join(dst, entry.name));
    } else if (entry.isFile()) {
      copyFileSync(join(src, entry.name), join(dst, entry.name));
    }
  }
}

/*
 * Fault injection for this guard's own tests: `P7_FORCE_SIGNAL_ON_RUN=<n>` makes the nth
 * `runAppLint` report a signal kill, which is the shape a spawn killed under load produces and the
 * only way to reach the signal clauses deterministically. Hoping for the real thing is not a pin —
 * the planted run's missing clause was hit once for real, in 1 of 79 runs.
 *
 * Like `P7_EXTRA_STRICT_FLAGS`, it can only make the guard REDDER: every signal path below is a
 * FAIL, so no setting of it switches a check off.
 */
let appLintRuns = 0;
const FORCED_SIGNAL_RUN = Number(process.env.P7_FORCE_SIGNAL_ON_RUN ?? '');

function runAppLint(cwd) {
  appLintRuns++;
  // `shell: true` with a constant command so the same string works on win32, where `npm` is a shim
  // rather than an executable. Judged by `status`, never by a pipeline's exit code.
  const r = spawnSync(CI_INVOCATION, { cwd, shell: true, encoding: 'utf8', timeout: 600_000 });
  const forced = FORCED_SIGNAL_RUN === appLintRuns;
  return {
    // `spawnSync` reports a failure to launch on `error`; a `throw` never happens, so a missing npm
    // would otherwise read as `status: null` and be indistinguishable from a crash.
    error: r.error ? (r.error instanceof Error ? r.error.message : String(r.error)) : null,
    status: forced ? null : r.status,
    signal: forced ? 'SIGKILL' : r.signal,
    output: forced ? '' : `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

/**
 * Write every probe into a directory the project actually compiles, verified with TypeScript's own
 * config parser rather than assumed from `include`. Guessing `src` would make the check silently
 * vacuous the day the app reorganises — a planted error outside the project is never reported, which
 * is indistinguishable from a type-check that does not run.
 */
function plantProbes(appDir) {
  const configPath = join(appDir, 'tsconfig.json');
  const conf = ts.readConfigFile(configPath, ts.sys.readFile);
  if (conf.error) return { error: 'the mirrored tsconfig.json could not be re-read' };

  const fileNames = ts.parseJsonConfigFileContent(conf.config, ts.sys, appDir).fileNames;
  const byDir = new Map();
  for (const f of fileNames) {
    const d = dirname(f);
    byDir.set(d, (byDir.get(d) ?? 0) + 1);
  }
  const dirs = [...byDir.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);

  // `.config.ts` is the second shape because the app's root files are matched by a `*.config.ts`
  // glob rather than a directory include, so a plain `.ts` sibling there is outside the project.
  for (const dir of dirs) {
    for (const suffix of ['.ts', '.config.ts']) {
      const placed = PROBES.map((p) => ({ probe: p, file: join(dir, `__p7_probe_${p.name}__${suffix}`) }));
      for (const { probe, file } of placed) writeFileSync(file, probe.source);
      const after = ts.parseJsonConfigFileContent(conf.config, ts.sys, appDir).fileNames.map(key);
      if (placed.every(({ file }) => after.includes(key(file)))) return { placed };
      for (const { file } of placed) rmSync(file, { force: true });
    }
  }
  return {
    error:
      'no directory in the project accepts a planted file — the guard cannot prove the type-check runs. Widen `include` in apps/studio/tsconfig.json.',
  };
}

function checkBehaviour() {
  // The mirror lives under the app's own `node_modules` so that `tsc` and every workspace-local
  // dependency (react-dom, electron-vite …) resolve by ordinary upward lookup. A temp directory
  // elsewhere would need symlinks, which behave differently on win32; this needs none. `node_modules`
  // is gitignored, so a mirror can never dirty `git status`.
  const cacheRoot = join(OWN_REPO, 'apps', 'studio', 'node_modules', '.cache');
  if (!existsSync(join(OWN_REPO, 'apps', 'studio', 'node_modules'))) {
    return [
      'apps/studio/node_modules is missing — the app type-check cannot be run, so this guard cannot verify it. Run `npm ci`.',
    ];
  }
  mkdirSync(cacheRoot, { recursive: true });
  const work = mkdtempSync(join(cacheRoot, 'p7-behaviour-'));
  try {
    const workApp = join(work, 'apps', 'studio');
    mkdirSync(join(work, 'apps'), { recursive: true });
    mirror(APP, workApp);
    // The root `package.json` is what resolves the `-w apps/studio` selector, so CI's command is
    // reproduced with CI's own workspace declaration rather than a synthetic one.
    copyFileSync(join(ROOT, 'package.json'), join(work, 'package.json'));

    const clean = runAppLint(work);
    if (clean.error) return [`\`${CI_INVOCATION}\` could not be launched: ${clean.error}`];
    if (clean.status !== 0) {
      return [
        `\`${CI_INVOCATION}\` does not currently pass${clean.signal ? ` (killed by ${clean.signal} — it did not finish, so this is not a type error)` : ''}, so this guard cannot tell a working type-check from a broken one. Fix the app's type errors first:\n` +
          clean.output
            .split('\n')
            .filter((l) => l.trim())
            .slice(0, 15)
            .map((l) => `    ${l}`)
            .join('\n'),
      ];
    }

    const planted = plantProbes(workApp);
    if (planted.error) return [planted.error];

    const dirty = runAppLint(work);
    if (dirty.error) return [`\`${CI_INVOCATION}\` could not be launched: ${dirty.error}`];
    // The clean run has guarded `signal` since it was written; the planted run guarded only `error`,
    // so a signal-killed planted run arrived here with `status: null` and no output, fell through to
    // the missed-probe branch, and accused the tree of reopening P7 because a spawn was killed. Same
    // clause, same reason: a command that did not finish reported nothing, and reporting nothing is
    // not evidence that it checks nothing.
    if (dirty.signal) {
      return [
        `\`${CI_INVOCATION}\` was killed by ${dirty.signal} over the planted tree, so it never finished — this guard cannot tell a type-check that found nothing from one that never ran. Re-run it; this is a probe that did not complete, not a P7 finding.`,
      ];
    }
    if (dirty.status === 0) {
      return [
        `\`${CI_INVOCATION}\` exited 0 over a tree carrying ${PROBES.length} planted type errors — whatever that command is, it is not type-checking this project's files. This is known issue P7 with every other assertion in this guard still true.`,
      ];
    }

    const missed = planted.placed.filter(
      ({ probe, file }) => !new RegExp(`${escapeRegExp(posix(relative(workApp, file)))}\\(\\d+,\\d+\\): error TS${probe.expect}\\b`).test(posix(dirty.output))
    );
    if (missed.length) {
      const flags = missed.filter((m) => m.probe.flag).map((m) => m.probe.flag);
      const baseline = missed.some((m) => !m.probe.flag);
      return [
        `\`${CI_INVOCATION}\` ran but did not report ${missed.length} of ${PROBES.length} planted type errors, so those checks are not in effect:\n` +
          missed.map(({ probe }) => `    - ${probe.name} (expected TS${probe.expect})`).join('\n') +
          (baseline
            ? '\n    The baseline probe is a plain assignment mismatch: missing it means the command does not check these files at all (a decoy `-p <project>`, or a `lint` script that only looks like a type-check).'
            : `\n    Set \`strict: true\` without switching its members off — ${flags.join(', ')} ${flags.length === 1 ? 'is' : 'are'} disabled in apps/studio/tsconfig.json.`),
      ];
    }
    return [];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Skipped when a pre-filter already failed — the behavioural run costs two type-checks, and its
// message cannot be clearer than the specific one already queued — and in `--shape-only` mode, which
// exists for the one CI job that has no build and therefore cannot resolve `wigolo/studio`.
if (!SHAPE_ONLY && !failures.length) failures.push(...checkBehaviour());

if (failures.length) {
  console.error('FAIL: the apps/studio type-check gap (P7) is open again.');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log(
  SHAPE_ONLY
    ? `OK (shape only): apps/studio type-check covers all ${expected.length} TypeScript files under the app, is strict, runs \`tsc --noEmit\`, and is invoked by an enabled ci.yml step — in a job with at least one proven matrix leg, from a step and a job carrying only keys this guard models, under a shell it models, as the ENTIRE command of a \`run:\` body fully modeled by this guard, heading its own command list with no later \`||\` and with errexit armed — in a workflow whose \`on:\` carries only filters this guard models and fires for \`${ENFORCED_BRANCH}\`. All ${STRICT_FLAGS.length} strict checks TypeScript ${ts.version} declares are probed. The planted-error check was NOT run — it needs a built \`dist/\` and rides the \`studio-unit\` job.`
    : `OK: apps/studio type-check covers all ${expected.length} TypeScript files under the app, reports every one of ${PROBES.length} planted type errors when \`${CI_INVOCATION}\` is run, and is invoked by an enabled ci.yml step — in a job with at least one proven matrix leg, from a step and a job carrying only keys this guard models, under a shell it models, as the ENTIRE command of a \`run:\` body fully modeled by this guard, heading its own command list with no later \`||\` and with errexit armed — in a workflow whose \`on:\` carries only filters this guard models and fires for \`${ENFORCED_BRANCH}\`. All ${STRICT_FLAGS.length} strict checks TypeScript ${ts.version} declares are probed.`
);
