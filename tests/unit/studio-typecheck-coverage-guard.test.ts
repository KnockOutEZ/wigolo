/**
 * Negative + positive tests for `scripts/check-studio-typecheck-coverage.mjs` (known issue P7).
 *
 * The guard exists because a one-line edit silently restores P7 — the gap where a file is checked by
 * nothing and every gate stays green. Its first two shipped forms checked the SHAPE of the
 * arrangement: the tsconfig's file set, `options.strict`, the `lint` script string, a regex over the
 * workflow text. Four bypasses survived that, all reproduced at SD0 phase-exit, and every one of them
 * is a costume a shape-check does not recognise:
 *
 *   1. `"lint": "tsc --noEmit -p tsconfig.decoy.json"` — the script regex allowed `-p <path>` while
 *      every other check only ever read `apps/studio/tsconfig.json`, so a decoy project that compiles
 *      one trivial file type-checked nothing and the guard printed OK,
 *   2. `strict: true` with `noImplicitAny`, `strictNullChecks`, … individually `false` — keeps
 *      `options.strict === true`, disables almost all checking,
 *   3. a `run:`-looking line inside an unrelated YAML block scalar — the CI assertion was a
 *      line-anchored regex over unparsed text, satisfied with no real step present at all,
 *   4. `if: false` on the real step — the regex asserts the line exists, never that it can execute.
 *
 * So the guard's core assertion is no longer a description of the check but the check itself: it runs
 * `npm run lint -w apps/studio` over a mirror of the app, once clean and once with a planted type
 * error per strict flag, and requires the clean run to exit 0 and the planted run to report every
 * probe. None of the four bypasses reports a planted error, which is why one assertion closes all
 * four — and why the cases below assert on WHICH message fires, not merely that the guard failed:
 * the shape-checks survive as fast pre-filters, and a test that only counted the exit code could not
 * tell a live pre-filter from a dead one.
 *
 * A third pass then found that proving the invocation SITS in an enabled step is not the same as
 * proving the shell RUNS it and lets its failure fail the job. Six more costumes, all reproduced on
 * the real tree or on fixture trees: the invocation commented out inside its own step (the live SD0
 * repro), present only as a quoted string, suffixed with `|| true`, piped so `$?` belongs to `tee`,
 * disarmed by `set +e`, and marked `continue-on-error` on the step or its job. A seventh sits above
 * all of them — a workflow whose `on:` never fires for this branch, where every step is correct and
 * none of them ever runs — and an eighth below them, a strict check with no probe.
 *
 * Four false FAILs are covered too, because a guard that fires on a healthy tree gets deleted rather
 * than obeyed: the old regex rejected the inline `- run: …` form that four other ci.yml steps use,
 * the source walk descended into electron-builder's gitignored `release/` output and reported the
 * unpacked app's own files back as uncovered, a `run: |` block may legitimately group output around
 * the invocation, and `on: [push, pull_request]` is the most permissive wiring there is.
 *
 * A sixth pass found seven MORE, and that is the number that changed the design. Rounds 3, 4, 5 and
 * 6 closed five, four, six and seven bypasses respectively, each by enumerating the edits its author
 * could imagine, and each time the next round found more — because the trigger and step analysis
 * were blacklists, and a blacklist's silence is indistinguishable from approval. So the readers are
 * now DEFAULT-DENY: `on.push`/`on.pull_request` may carry only `branches`/`branches-ignore` built
 * from patterns the guard compiles, a `run:` body must tokenise into simple commands joined by
 * `&& || | & ; <newline>`, and anything else is reported as "cannot prove this runs". The round-6
 * fixtures below are therefore evidence that the MECHANISM changed, not seven more blacklist rows;
 * the assertion that the class is closed is that unmodelled constructs nobody enumerated — a
 * subshell, an `if` condition, a `${{ }}` expression — fail too, while the must-not-fire controls
 * beside them still pass.
 *
 * The test side had its own instance of the same bug: `commandChain` split on `&&` and trusted the
 * pieces, so `npm run check:studio-typecheck && anything || true` produced an exact first link and
 * satisfied the very assertions that claim a swallow cannot hide inside an exact match. It encoded
 * bug 5 rather than catching it, and now reads default-deny like the guard it mirrors.
 *
 * Cases run against a synthetic repo root rather than the real one: the guard's whole job is to
 * notice a broken arrangement, and the real tree is (by construction) never broken. The exceptions are
 * the last two — "is this guard wired to anything" is a fact about THIS repo, so they read this repo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const GUARD = fileURLToPath(new URL('../../scripts/check-studio-typecheck-coverage.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Every fixture carries the trigger block, because a workflow that never fires enforces nothing no
 * matter what its steps say — the guard asserts `on:` for exactly that reason, and a fixture without
 * one would fail for a reason it is not about.
 */
const TRIGGERS = `on:
  push:
    branches: [main, studio-handoff]
  pull_request:
    branches: [main, studio-handoff]
`;

const wf = (jobs: string): string => `name: CI\n${TRIGGERS}${jobs}`;

const WORKFLOW_WITH_STEP = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

const WORKFLOW_WITHOUT_STEP = wf(`jobs:
  studio-unit:
    steps:
      - name: Unit tests (studio)
        run: npm test -w apps/studio
`);

/**
 * The real ci.yml carries the invocation inside a prose comment explaining why it must not be
 * removed. A substring check over the raw file is satisfied by that comment alone, so deleting the
 * only real step is a green edit.
 */
const WORKFLOW_COMMENT_ONLY = wf(`jobs:
  studio-unit:
    steps:
      # Removing this step reopens P7. The step below is \`npm run lint -w apps/studio\`.
      - name: Unit tests (studio)
        run: npm test -w apps/studio
`);

/**
 * A real step annotated in place. The step is present and correct, so the guard must not fire on it.
 */
const WORKFLOW_TRAILING_COMMENT = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio  # do not remove — this IS the app's type-check
`);

/**
 * Bypass 3. `NOTES: |` is a block scalar: every line inside it is a string value, not YAML structure.
 * The old assertion was a line-anchored regex over comment-stripped but unparsed text, so this file
 * satisfied it with no step invoking the app type-check anywhere.
 */
const WORKFLOW_BLOCK_SCALAR_DECOY = wf(`jobs:
  studio-unit:
    steps:
      - name: Unit tests (studio)
        env:
          NOTES: |
            The studio lint step is
            run: npm run lint -w apps/studio
            and it must not be removed.
        run: npm test -w apps/studio
`);

/** Bypass 4. The line the regex asserted is present, on a step that can never execute. */
const WORKFLOW_STEP_IF_FALSE = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        if: false
        run: npm run lint -w apps/studio
`);

/** Bypass 4, one level up: the step is live, the job it lives in is not. */
const WORKFLOW_JOB_IF_FALSE = wf(`jobs:
  studio-unit:
    if: false
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/**
 * False FAIL 5. ci.yml uses this inline form for four other steps; the old regex allowed only
 * whitespace before `run:`, so collapsing the studio step onto one line broke the guard with the
 * check still entirely correct.
 */
const WORKFLOW_INLINE_RUN = wf(`jobs:
  studio-unit:
    steps:
      - run: npm run lint -w apps/studio
`);

/** Must-not-fire: `always()` is a condition that cannot disable the step. */
const WORKFLOW_IF_ALWAYS = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        if: \${{ always() }}
        run: npm run lint -w apps/studio
`);

// -----------------------------------------------------------------------------------------------
// Execution semantics. Everything above proves the invocation SITS in an enabled step; none of it
// proves the shell EXECUTES it and lets its failure fail the step. Each fixture below satisfies
// every earlier check — parsed step, no `if:`, real `run:` — and enforces nothing.
// -----------------------------------------------------------------------------------------------

/**
 * The live repro from the SD0 exit-4 session: the step is still named `Lint studio`, still
 * unconditional, still carries the invocation in its `run:` — as a shell comment. The guard printed
 * "invoked by an enabled ci.yml step" and exited 0.
 */
const WORKFLOW_SHELL_COMMENTED = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          # npm run lint -w apps/studio
          echo "temporarily disabled"
`);

/** The invocation as data rather than as a command. Nothing runs a quoted string. */
const WORKFLOW_ECHOED = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: echo "npm run lint -w apps/studio"
`);

/**
 * The same, unquoted — and the fixture that pins the invocation to the HEAD of a command rather than
 * to somewhere inside one. Both `echo` forms are inert, but only this one survives a match loosened
 * from "the command starts with it" to "the command contains it".
 */
const WORKFLOW_ECHOED_BARE = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: echo npm run lint -w apps/studio
`);

/** Exit-code swallowing, the shortest form. */
const WORKFLOW_OR_TRUE = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio || true
`);

/** Exit-code swallowing through a pipeline: `$?` becomes `tee`'s, which always succeeds. */
const WORKFLOW_PIPED = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio | tee studio-lint.log
`);

/** Exit-code swallowing by switching off the abort the runner's `bash -e` provides. */
const WORKFLOW_SET_PLUS_E = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          set +e
          npm run lint -w apps/studio
          echo "done"
`);

/** The step runs and fails; the job reports success anyway. */
const WORKFLOW_STEP_CONTINUE_ON_ERROR = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        continue-on-error: true
        run: npm run lint -w apps/studio
`);

/** Same, one level up. */
const WORKFLOW_JOB_CONTINUE_ON_ERROR = wf(`jobs:
  studio-unit:
    continue-on-error: true
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/**
 * Must-not-fire. A `run: |` block with benign neighbours: under the runner's `bash -e` the
 * invocation's failure aborts the script, so its exit code IS the step's. A guard that rejected this
 * would forbid the one multi-line form CI actually uses.
 */
const WORKFLOW_MULTILINE_BENIGN = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        shell: bash
        run: |
          # the app's own type-check — see known issue P7
          echo "::group::studio type-check"
          npm run lint -w apps/studio
          echo "::endgroup::"
`);

/**
 * Must-not-fire, and the only fixture the quote-tracking half of the scan owns: a metacharacter
 * inside an argument is a character, not an operator. Without quote tracking the `||` here splits the
 * command and the guard reports a correctly wired step as swallowing its own exit code — a false FAIL
 * on a healthy tree, which is how a guard gets deleted rather than obeyed.
 *
 * The quoted argument sits on the NEIGHBOUR rather than on the invocation, because round 7 made the
 * invocation an exact match: any appended argument — even one npm consumes itself, like
 * `--loglevel warn` — is now a FAIL, since nothing here can tell npm's own flags from a forwarded
 * `-- --help`. That spelling moved to `WORKFLOW_APPENDED_NPM_FLAG` as a must-FIRE case.
 */
const WORKFLOW_QUOTED_ARGUMENT = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          echo "warn || error"
          npm run lint -w apps/studio
`);

/**
 * Must-not-fire, and the only fixture the comment-stripping half owns. A YAML plain scalar loses its
 * trailing `#` comment to the parser, so the shape only exists inside a block scalar — where the
 * likeliest comment to write is one naming the very operator that would break the step.
 */
const WORKFLOW_COMMENT_NAMING_AN_OPERATOR = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          npm run lint -w apps/studio # never weaken this to || true — see known issue P7
`);

/**
 * `continue-on-error` as an expression — the form ci.yml already uses on another job. It cannot be
 * evaluated here, so it is read as disabling: guessing it is false is the guess that fails silently.
 */
const WORKFLOW_CONTINUE_ON_ERROR_EXPRESSION = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        continue-on-error: \${{ matrix.os == 'windows-latest' }}
        run: npm run lint -w apps/studio
`);

/** Must-not-fire: `continue-on-error: false` is the explicit spelling of the default. */
const WORKFLOW_CONTINUE_ON_ERROR_FALSE = wf(`jobs:
  studio-unit:
    continue-on-error: false
    steps:
      - name: Lint studio (tsc --noEmit)
        continue-on-error: false
        run: npm run lint -w apps/studio
`);

/** A workflow that only ever runs on a tag: the step is present, unconditional and dead. */
const WORKFLOW_NO_PR_TRIGGER = `name: CI
on:
  push:
    tags: ['v*']
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

/** Fires for pull requests, but never for the branch this program merges into. */
const WORKFLOW_PUSH_MAIN_ONLY = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

/** Must-not-fire: the unfiltered shorthand fires for every branch, including this one. */
const WORKFLOW_TRIGGER_SHORTHAND = `name: CI
on: [push, pull_request]
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

// -----------------------------------------------------------------------------------------------
// Round 6 — the default-deny rework. Seven more pass-direction bypasses, after rounds 3, 4 and 5
// closed five, four and six. Every round enumerated the edits its author could imagine and the next
// round found more, because the trigger and step analysis were BLACKLISTS: a construct they did not
// recognise fell off the end of the switch and left the step approved. The shapes below are the
// seven; each one is here as evidence that the mechanism changed, not that seven more entries were
// added to a list. The real assertion that the class is closed is that the readers now reject by
// default and the must-not-fire controls beside them still pass.
// -----------------------------------------------------------------------------------------------

/** The job every trigger fixture below carries: present, enabled, correct, and reached by nothing. */
const STUDIO_JOB = `jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;
const wfTriggers = (triggers: string): string => `name: CI\n${triggers}${STUDIO_JOB}`;
const wfRun = (run: string): string => wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: ${run}
`);

/**
 * Shape 1. GitHub reads a leading `!` as an EXCLUSION, so this fires for every branch EXCEPT the one
 * the program merges into. The old matcher compiled the entry to a literal branch named
 * `!studio-handoff`, which matches nothing and is therefore harmless — so the list read as `['**']`,
 * the most permissive filter there is, and the guard printed OK.
 */
const WORKFLOW_NEGATED_BRANCH = wfTriggers(`on:
  push:
    branches: ['**', '!studio-handoff']
  pull_request:
    branches: ['**', '!studio-handoff']
`);

/**
 * Shape 2. A path filter decides by the DIFF, so an edit touching only `apps/**` — the exact edit
 * this gate exists to catch — starts no run at all. Nothing about `branches` changes, which is why a
 * reader that only inspected `branches`/`branches-ignore` approved it.
 */
const WORKFLOW_PATHS_IGNORE = wfTriggers(`on:
  push:
    branches: [main, studio-handoff]
    paths-ignore: ['apps/**']
  pull_request:
    branches: [main, studio-handoff]
    paths-ignore: ['apps/**']
`);

/** Shape 2, the allowlist direction: a `paths:` filter that never names the app. */
const WORKFLOW_PATHS_FILTER = wfTriggers(`on:
  push:
    branches: [main, studio-handoff]
    paths: ['docs/**']
  pull_request:
    branches: [main, studio-handoff]
    paths: ['docs/**']
`);

/**
 * Shape 2, same family. `types: [labeled]` narrows a `pull_request` to activity a code push never
 * raises, so pushing a commit to an open PR runs nothing. It is only mitigated while a clean `push`
 * trigger survives, and nothing in the file guarantees that pair stays intact.
 */
const WORKFLOW_PR_TYPES = wfTriggers(`on:
  push:
    branches: [main, studio-handoff]
  pull_request:
    branches: [main, studio-handoff]
    types: [labeled]
`);

/** A `branches` written as a scalar rather than a list — the old reader's `Array.isArray` fell through to "fires". */
const WORKFLOW_SCALAR_BRANCHES = wfTriggers(`on:
  push:
    branches: main
  pull_request:
    branches: main
`);

/** Must-not-fire: a glob built only from `*` is a pattern the guard models, and it fires for this branch. */
const WORKFLOW_BRANCH_GLOB = wfTriggers(`on:
  push:
    branches: ['main', 'studio-*']
  pull_request:
    branches: ['main', 'studio-*']
`);

/** Must-not-fire: extra top-level events can only ADD runs, so they are not the guard's business. */
const WORKFLOW_EXTRA_EVENTS = wfTriggers(`on:
  push:
    branches: [main, studio-handoff]
  pull_request:
    branches: [main, studio-handoff]
  workflow_call:
  workflow_dispatch:
`);

/**
 * Shape 4. `commandPositions` recorded a `before` operator on every command and `invocationSemantics`
 * never read it: with `git diff --quiet` succeeding — i.e. on every run where the app was not touched
 * — the `||` short-circuits and the type-check does not execute, and the step exits 0.
 */
const WORKFLOW_OR_PREDECESSOR = wfRun('git diff --quiet apps/studio || npm run lint -w apps/studio');

/**
 * Shape 5. Only the invocation's IMMEDIATE `after` operator was inspected, and bash's `&&`/`||` list
 * is left-associative: a failure walks right past every `&&` to the first `||` and the list exits
 * with that command's status. `false && echo done || true` exits 0.
 */
const WORKFLOW_LATER_OR = wfRun('npm run lint -w apps/studio && echo done || true');

/**
 * Shape 6. The scanner had no notion of heredocs, so every line of the body was matched as a command
 * in command position while `cat` swallowed the lot.
 */
const WORKFLOW_HEREDOC = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          cat <<EOF
          npm run lint -w apps/studio
          EOF
`);

/** Shape 7. `set +ex` — errexit off, in a spelling the `/^set\\s+\\+[a-zA-Z]*e\\b/` detector missed. */
const WORKFLOW_SET_PLUS_EX = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          set +ex
          npm run lint -w apps/studio
`);

/** Shape 7, the spelling that looks most like the correct one. `+euo pipefail` still clears errexit. */
const WORKFLOW_SET_PLUS_EUO = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          set +euo pipefail
          npm run lint -w apps/studio
`);

/** Shape 7, the long-option spelling. */
const WORKFLOW_SET_PLUS_O_ERREXIT = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          set +o errexit
          npm run lint -w apps/studio
`);

/**
 * Shape 7's tail. A matrix dimension that evaluates empty produces no legs; a job with no legs is
 * SKIPPED, and a skipped job reports Success to the required-checks list. The step is present,
 * enabled, correctly written and executed zero times.
 */
const WORKFLOW_EMPTY_MATRIX = wf(`jobs:
  studio-unit:
    strategy:
      matrix:
        os: []
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/** The same, with the leg count hidden behind an expression this guard cannot evaluate. */
const WORKFLOW_EXPRESSION_MATRIX = wf(`jobs:
  studio-unit:
    strategy:
      matrix:
        os: \${{ fromJSON(needs.plan.outputs.targets) }}
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/** Must-not-fire: the 3-OS matrix the real `studio-unit` job carries. Three literal legs, provably ≥1. */
const WORKFLOW_MATRIX_THREE_OS = wf(`jobs:
  studio-unit:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/** Mutation gap: the `&` entry in DISCARDS_EXIT_CODE. A backgrounded command is never waited for. */
const WORKFLOW_BACKGROUNDED = wfRun('npm run lint -w apps/studio &');

/**
 * Mutation gap: the `!` block. The step passes exactly when the type-check fails.
 *
 * Quoted because a bare leading `!` is a YAML tag, not a character: `run: ! npm run lint …` parses
 * to the scalar with the `!` stripped, i.e. to a correctly wired step. The shell shape only survives
 * a round-trip through the parser in quotes.
 */
const WORKFLOW_NEGATED_INVOCATION = wfRun("'! npm run lint -w apps/studio'");

/**
 * Mutation gap: the redirection exemption. `2>&1` is a redirection, not a background operator, and
 * dropping the exemption reports this correctly wired step as backgrounded — a false FAIL on a
 * healthy tree, which is how a guard gets deleted rather than obeyed.
 */
const WORKFLOW_REDIRECT_STDERR = wfRun('npm run lint -w apps/studio > lint.log 2>&1');

/** Must-not-fire: the same redirection written the other way round. */
const WORKFLOW_REDIRECT_AMP_GT = wfRun('npm run lint -w apps/studio >& lint.log');

/**
 * The one RED-direction defect of round 6: the operator test looked backwards for a `>` but not
 * forwards, so `&>` — the same redirection, third spelling — was reported as a backgrounded command.
 * A false FAIL on a correctly wired step.
 */
const WORKFLOW_REDIRECT_AMP = wfRun('npm run lint -w apps/studio &> lint.log');

/** Must-not-fire: `set +x` switches TRACING off and leaves errexit alone. A parsed `set` knows that. */
const WORKFLOW_SET_PLUS_X = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          set +x
          npm run lint -w apps/studio
`);

/** Must-not-fire: the armed spelling, which is what a careful step actually writes. */
const WORKFLOW_SET_MINUS_EUO = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          set -euo pipefail
          npm run lint -w apps/studio
`);

/** Default-deny, not a blacklist entry: a condition context, where a failure aborts nothing. */
const WORKFLOW_IF_BLOCK = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          if npm run lint -w apps/studio; then
            echo ok
          fi
`);

/** Default-deny: a subshell. Whatever happens inside one, this guard does not model it. */
const WORKFLOW_SUBSHELL = wfRun('(npm run lint -w apps/studio)');

/**
 * Default-deny: the runner substitutes a workflow expression before the shell ever sees the body, so
 * the command that runs is not the command in the file — `\${{ matrix.suffix }}` can be `|| true`.
 */
const WORKFLOW_GHA_EXPRESSION = wfRun('npm run lint -w apps/studio \${{ matrix.suffix }}');

// -----------------------------------------------------------------------------------------------
// ROUND 7 — the KEY layer.
//
// Rounds 3-6 moved the `run:` BODY grammar to default-deny. Round 7 reproduced eight more
// pass-direction bypasses, and every one of them lives one layer OUT from that grammar: in the step
// and job KEYS that decide what the body means, in what counts as a match for the invocation, and in
// two places where the tokeniser's own blanking diverged from bash. The keys were still a blacklist,
// so `shell:` — the key the whole "a `;` is safe because errexit aborts the block" argument depends
// on — was never read at all.
//
// The fixtures below are therefore NOT eight more blacklist rows. Their evidence that the mechanism
// changed is `WORKFLOW_JOB_CONTAINER`, `WORKFLOW_JOB_SERVICES`, `WORKFLOW_STEP_WORKING_DIRECTORY`
// and `WORKFLOW_STEP_USES`: four constructs nobody enumerated, denied by the same allowlist that
// denies `needs:`, with the must-not-fire controls beside them still passing.
// -----------------------------------------------------------------------------------------------

/**
 * Shape 1, the sharpest: the invocation was matched by PREFIX, so anything beginning with it plus a
 * space was accepted — while the behavioural half runs the bare `CI_INVOCATION` constant. The two
 * halves therefore measured different commands. `-- --help` makes CI run `tsc --noEmit --help`,
 * which prints help, checks nothing and exits 0, and the guard printed "reports every one of 9
 * planted type errors" over it.
 */
const WORKFLOW_APPENDED_HELP = wfRun('npm run lint -w apps/studio -- --help');

/** The same hole wearing round 1's costume: the decoy project, closed in the lint script, reopened here. */
const WORKFLOW_APPENDED_DECOY = wfRun('npm run lint -w apps/studio -- -p tsconfig.decoy.json');

/**
 * An argument npm consumes itself rather than forwarding. Denied anyway: nothing here can tell
 * npm's own flags from a forwarded `--`, and guessing is the guess that fails silently. This is the
 * cost of exactness, and it is stated rather than hidden.
 */
const WORKFLOW_APPENDED_NPM_FLAG = wfRun('npm run lint -w apps/studio --loglevel "warn || error"');

/**
 * Shape 2. The list scan `break`s at a pipe further along, so it never reached the `||` behind it.
 * Bash reads this as `A && (echo done|cat) || true`: a failure walks right past the `&&`, the pipe
 * binds tighter than the list, and `true` supplies the exit code. Bash-verified — this exits 0 with
 * a failing A, and the control below exits 1.
 */
const WORKFLOW_LATER_OR_PAST_PIPE = wfRun('npm run lint -w apps/studio && echo done | cat || true');

/** Must-not-fire control: the same pipe with no later `||`. A pipe on a NEIGHBOUR cannot rescue A. */
const WORKFLOW_PIPE_NO_LATER_OR = wfRun('npm run lint -w apps/studio && echo done | cat');

/** Shape 3. `trap '…' ERR` catches the errexit abort; bash-verified to exit 0 over a failing command. */
const WORKFLOW_TRAP_ERR = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          trap 'exit 0' ERR
          npm run lint -w apps/studio
`);

/** Shape 3, second spelling: everything below `exit 0` never runs, and the step exits 0. */
const WORKFLOW_BARE_EXIT = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          exit 0
          npm run lint -w apps/studio
`);

/** Shape 3, third spelling: `exec` replaces the shell, so nothing after it exists. */
const WORKFLOW_EXEC = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          exec true
          npm run lint -w apps/studio
`);

/**
 * Must-not-fire control for shape 3: the denial is on the command's HEAD, not on the text appearing
 * anywhere. A neighbour that merely mentions the words still runs.
 */
const WORKFLOW_CONTROL_WORDS_AS_ARGUMENTS = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          echo trap exit return exec
          npm run lint -w apps/studio
`);

/**
 * Shape 4. The unquoted spelling was already denied; the quote branch `continue`d before the check,
 * so adding two quotes flipped the verdict on the identical bypass. The runner substitutes BEFORE
 * the shell sees the text, so with `matrix.suffix: ["x' || true #"]` this reaches bash as
 * `npm run lint -w apps/studio 'x' || true #'`.
 */
const WORKFLOW_QUOTED_GHA_EXPRESSION = wf(`jobs:
  studio-unit:
    strategy:
      matrix:
        suffix: ["x' || true #"]
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio '\${{ matrix.suffix }}'
`);

/** Must-not-fire control for shape 4: a shell variable is not a workflow expression. */
const WORKFLOW_SHELL_VARIABLE = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          echo "$HOME"
          npm run lint -w apps/studio
`);

/**
 * Shape 5. `shell:` was never read. A template value is still bash, still reads like the default,
 * and has no `-e`: the `;` below then leaves the step exiting 0 over a failing type-check, while
 * the guard reported "errexit armed".
 */
const WORKFLOW_SHELL_TEMPLATE = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        shell: bash --noprofile --norc {0}
        run: |
          npm run lint -w apps/studio; echo done
`);

/** Shape 5's deletion hazard: on Windows the default shell is pwsh, which has no errexit at all. */
const WORKFLOW_SHELL_ABSENT_ON_WINDOWS = wf(`jobs:
  studio-unit:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/** Must-not-fire control: the real job's spelling — the same 3-OS matrix with the shell named. */
const WORKFLOW_SHELL_BASH_ON_WINDOWS = wf(`jobs:
  studio-unit:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - name: Lint studio (tsc --noEmit)
        shell: bash
        run: npm run lint -w apps/studio
`);

/** Must-not-fire control: an absent `shell:` on a runner that provably is not Windows. */
const WORKFLOW_SHELL_ABSENT_ON_UBUNTU = wf(`jobs:
  studio-unit:
    runs-on: ubuntu-latest
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/**
 * Shape 6. `plan` is `if: false`, so it is SKIPPED — and a job whose dependency is skipped is
 * skipped too, which rolls up to the run's conclusion as SUCCESS. The zero-leg-matrix reasoning
 * already in this guard is the same argument; `needs` was simply missing from it.
 */
const WORKFLOW_JOB_NEEDS = wf(`jobs:
  plan:
    if: false
    steps:
      - run: echo nothing
  studio-unit:
    needs: [plan]
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/** Unenumerated key #1: the job runs inside another image entirely. */
const WORKFLOW_JOB_CONTAINER = wf(`jobs:
  studio-unit:
    container:
      image: node:18
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/** Unenumerated key #2. */
const WORKFLOW_JOB_SERVICES = wf(`jobs:
  studio-unit:
    services:
      db:
        image: postgres
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/** Unenumerated key #3: `-w apps/studio` resolves against whatever root lives in that directory. */
const WORKFLOW_STEP_WORKING_DIRECTORY = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        working-directory: decoy
        run: npm run lint -w apps/studio
`);

/** Unenumerated key #4: `uses:` replaces the body, and the `run:` beside it is never reached. */
const WORKFLOW_STEP_USES = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        uses: ./.github/actions/noop
        run: npm run lint -w apps/studio
`);

/** Unenumerated key #5, one level further out: the shell for every step, set outside every step. */
const WORKFLOW_WORKFLOW_DEFAULTS = `name: CI
${TRIGGERS}defaults:
  run:
    shell: bash --noprofile --norc {0}
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

/** Must-not-fire control for the key allowlist: every key the real `studio-unit` job carries. */
const WORKFLOW_REAL_JOB_KEYS = wf(`jobs:
  studio-unit:
    name: studio unit (\${{ matrix.os }})
    runs-on: \${{ matrix.os }}
    timeout-minutes: 20
    env:
      ELECTRON_SKIP_BINARY_DOWNLOAD: '1'
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - id: lint-studio
        name: Lint studio (tsc --noEmit)
        shell: bash
        timeout-minutes: 10
        env:
          CI: '1'
        run: npm run lint -w apps/studio
`);

/**
 * Shape 7. Blanking `""` to spaces manufactured a word boundary bash does not have, so the guard saw
 * `#` starting a comment that swallowed the `|| true` behind it. Bash-verified:
 * `false && echo ""# || echo RESCUED` prints RESCUED and exits 0.
 */
const WORKFLOW_QUOTE_BLANK_COMMENT = wfRun('npm run lint -w apps/studio && echo ""# || true');

/** The same divergence written directly onto the invocation, where `#` is an appended argument. */
const WORKFLOW_QUOTE_BLANK_ON_INVOCATION = wfRun('npm run lint -w apps/studio ""# || true');

/**
 * Shape 8. `MODELED_PATTERN` admits unbounded `*`, and each one compiled to a `.*`: 24 of them in
 * front of a literal that cannot match makes the engine walk every way of splitting the branch name,
 * and the guard runs past a minute. A workflow file that hangs its own gate is a denial of the
 * check, so this is a red-direction availability defect rather than a bypass.
 */
const WORKFLOW_REDOS_PATTERN = `name: CI
on:
  push:
    branches: ['${'*'.repeat(24)}zzz']
  pull_request:
    branches: ['${'*'.repeat(24)}zzz']
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

/**
 * Shape 8's must-not-fire half: collapsing runs of `*` must be behaviour-preserving. `**` and a
 * doubled `studio-**` still match, and a `releases/**` entry beside them still does not — the same
 * verdicts the uncollapsed compiler gave, on the same patterns the collapse was checked against.
 */
const WORKFLOW_DOUBLE_STAR_GLOBS = `name: CI
on:
  push:
    branches: ['main', 'releases/**', 'studio-**']
  pull_request:
    branches: ['**']
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

/** And the direction that must still red: a collapsed `*` run may not start matching things it did not. */
const WORKFLOW_DOUBLE_STAR_NON_MATCH = `name: CI
on:
  push:
    branches: ['releases/**', 'feat/**/x']
  pull_request:
    branches: ['releases/**', 'feat/**/x']
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

/** Shape 9. `include` only ADDS legs, so it cannot take the count to zero — this job provably runs once. */
const WORKFLOW_MATRIX_EMPTY_INCLUDE = wf(`jobs:
  studio-unit:
    strategy:
      matrix:
        os: [ubuntu-latest]
        include: []
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/** Shape 9's other half: `include` alone is a legal matrix, one leg per entry. */
const WORKFLOW_MATRIX_ONLY_INCLUDE = wf(`jobs:
  studio-unit:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/** Must-not-fire's opposite: `include` alone and EMPTY really is zero legs, and must still red. */
const WORKFLOW_MATRIX_ONLY_EMPTY_INCLUDE = wf(`jobs:
  studio-unit:
    strategy:
      matrix:
        include: []
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

// -----------------------------------------------------------------------------------------------
// Round 8. Two of these were opened by the round-7 diff itself, and both are the same class: a
// change that made the guard read MORE of the file handed a neighbouring reader a shape it did not
// model. The rest are the shrinking `run:`-grammar tail plus two test gaps.
// -----------------------------------------------------------------------------------------------

/**
 * D1, the regression. Before the `include` exemption above, an `include`-only Windows leg never
 * reached the shell check at all — `strategyRuns` rejected the matrix first. The exemption made this
 * job "provably runs" and handed it to a Windows reader that read DIMENSIONS only, so the `os` the
 * exemption had just started trusting was invisible to it. Same runners as the 3-OS dimension
 * spelling, opposite verdict; the only delta is `include:`.
 */
const WORKFLOW_INCLUDE_WINDOWS_NO_SHELL = wf(`jobs:
  studio-unit:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
        include: [{ os: windows-latest }]
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/** D1's must-not-fire: the identical matrix with the shell named is a correctly wired step. */
const WORKFLOW_INCLUDE_WINDOWS_SHELL_BASH = wf(`jobs:
  studio-unit:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
        include: [{ os: windows-latest }]
    steps:
      - name: Lint studio (tsc --noEmit)
        shell: bash
        run: npm run lint -w apps/studio
`);

/**
 * D1's other must-not-fire, and the one that stops the fix degenerating into "deny any matrix that
 * carries `include`": an `include` leg that provably is not Windows still needs no explicit shell.
 */
const WORKFLOW_INCLUDE_UBUNTU_NO_SHELL = wf(`jobs:
  studio-unit:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
        include: [{ os: macos-latest }]
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/** D1, second spelling: a repository variable resolves outside this file entirely. */
const WORKFLOW_RUNS_ON_VARS = wf(`jobs:
  studio-unit:
    runs-on: \${{ vars.RUNNER_LABEL }}
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/** D1, third spelling: the reference is to `matrix.os` and the dimension is called something else. */
const WORKFLOW_RUNS_ON_MISSING_DIMENSION = wf(`jobs:
  studio-unit:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        runner: [ubuntu-latest, windows-latest]
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/**
 * D2, the other regression. Bash REMOVES backslash-newline before tokenising, so this joins to
 * `npm run lint -w apps/studio && echo ok# || true` — `#` is an ordinary character mid-word and the
 * `|| true` is live, rescuing a failing type-check to exit 0. Round 7 set `atWordStart` on the
 * continuation, so the guard read a comment where bash reads none.
 */
const WORKFLOW_CONTINUATION_FAKE_COMMENT = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          npm run lint -w apps/studio && echo ok\\
          # || true
`);

/** D2's must-not-fire: a continuation with nothing hidden behind it still joins two lines into one. */
const WORKFLOW_CONTINUATION_PLAIN = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          npm run lint -w apps/studio \\
            && echo done
`);

/**
 * D3. The blanked text is the bare invocation, so it matched exactly; in CI the substitution expands
 * to `-- --help`, npm forwards it, and `tsc --noEmit --help` prints help and exits 0.
 */
const WORKFLOW_COMMAND_SUBSTITUTION = wfRun("npm run lint -w apps/studio $(printf -- '-- --help')");

/** D3's backtick spelling — the same expansion, and previously read as a quoted region. */
const WORKFLOW_BACKTICK_SUBSTITUTION = wfRun('npm run lint -w apps/studio `printf -- \'-- --help\'`');

/** D3's must-not-fire: `${HOME}` is a parameter expansion the runner never touches, not `$( … )`. */
const WORKFLOW_BRACED_SHELL_VARIABLE = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          echo "building in \${HOME}"
          npm run lint -w apps/studio
`);

/** D4. One word in front of the exact string the guard already denies, and it disarms identically. */
const WORKFLOW_BUILTIN_SET_PLUS_E = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          builtin set +e
          npm run lint -w apps/studio
`);

/** D4, second introducer. `command` prefixes a builtin exactly as `builtin` does. */
const WORKFLOW_COMMAND_SET_PLUS_E = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          command set +e
          npm run lint -w apps/studio
`);

/** D4. `eval` runs a string this guard cannot read, and the string here is a `set +e`. */
const WORKFLOW_EVAL_SET_PLUS_E = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          eval "set +e"
          npm run lint -w apps/studio
`);

/**
 * D4. `source` runs another file in THIS shell, so whatever that file does to errexit applies here.
 * The disarming file is committed alongside, which is what makes this a live bypass rather than a
 * hypothetical one: nothing about the workflow text says errexit was switched off.
 */
const WORKFLOW_SOURCE_DISARMING_FILE = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          source ./apps/studio/ci/disarm.sh
          npm run lint -w apps/studio
`);

/** D4, `source`'s POSIX spelling — one character, same effect. */
const WORKFLOW_DOT_DISARMING_FILE = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          . ./apps/studio/ci/disarm.sh
          npm run lint -w apps/studio
`);

/** D4's must-not-fire: `builtin` in front of something that is not `set` acts like that something. */
const WORKFLOW_BUILTIN_ECHO = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          builtin echo starting
          npm run lint -w apps/studio
`);

/** D5. A correctly wired step, quoted the ordinary way — and reported `absent` before round 8. */
const WORKFLOW_QUOTED_WORKSPACE = wfRun('npm run lint -w "apps/studio"');

/** D5, single quotes. */
const WORKFLOW_SQUOTED_WORKSPACE = wfRun("npm run lint -w 'apps/studio'");

/**
 * D5's must-fire companion. Reading quoted CONTENT must not degenerate into "any quoted word is the
 * workspace": this step type-checks a different workspace, and the app's type-check is still absent.
 */
const WORKFLOW_QUOTED_OTHER_WORKSPACE = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          npm run lint -w "apps/other" # npm run lint -w apps/studio
`);

/** D6. `return` was the one `CONTROL_FLOW_WORDS` member with no fixture — a deny nothing proved live. */
const WORKFLOW_BARE_RETURN = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          return 0
          npm run lint -w apps/studio
`);

/** D7. The three `REDIRECTION` branches no fixture exercised: `>>`, `<` and `&>>`. */
const WORKFLOW_REDIRECT_APPEND = wfRun('npm run lint -w apps/studio >> lint.log');
const WORKFLOW_REDIRECT_STDIN = wfRun('npm run lint -w apps/studio < /dev/null');
const WORKFLOW_REDIRECT_AMP_APPEND = wfRun('npm run lint -w apps/studio &>> lint.log');

/**
 * The compiler options a fixture needs for the probe set to be meaningful: a modern lib (the
 * builtin-iterator probe needs `Array.prototype.values`) and no ambient `@types` sweep.
 */
const BASE_OPTIONS = {
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  skipLibCheck: true,
  noEmit: true,
  types: [] as string[],
};

/** Every member of the strict family switched off while `strict` itself stays `true` — bypass 2. */
const STRICT_MEMBERS_OFF = {
  noImplicitAny: false,
  strictNullChecks: false,
  strictFunctionTypes: false,
  strictBindCallApply: false,
  strictPropertyInitialization: false,
  strictBuiltinIteratorReturn: false,
  noImplicitThis: false,
  useUnknownInCatchVariables: false,
};

interface Fixture {
  readonly include?: readonly string[];
  /** `files` instead of `include`, i.e. a project no planted file can enter. */
  readonly files?: readonly string[];
  readonly strict?: boolean;
  /** Extra `compilerOptions` merged over the baseline. */
  readonly options?: Readonly<Record<string, unknown>>;
  readonly workflow?: string;
  /** Extra files to drop into `apps/studio/src` beyond the baseline one. */
  readonly extraSrc?: readonly string[];
  /** Arbitrary extra files, keyed by path relative to `apps/studio`. */
  readonly extraApp?: Readonly<Record<string, string>>;
  /** Extra tsconfig-shaped JSON files, keyed by name relative to `apps/studio`. */
  readonly extraConfigs?: Readonly<Record<string, unknown>>;
  /** `apps/studio`'s `lint` script. `null` removes the key entirely. */
  readonly lintScript?: string | null;
}

let root: string;

function buildFixture(f: Fixture = {}): void {
  const app = join(root, 'apps', 'studio');
  mkdirSync(join(app, 'src', 'main'), { recursive: true });
  mkdirSync(join(app, 'tests', 'unit'), { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });

  writeFileSync(join(app, 'src', 'main', 'index.ts'), 'export const boot = () => 1;\n');
  writeFileSync(join(app, 'tests', 'unit', 'boot.test.ts'), 'export const spec = 1;\n');
  writeFileSync(join(app, 'vitest.config.ts'), 'export default {};\n');
  for (const name of f.extraSrc ?? []) {
    writeFileSync(join(app, 'src', name), 'export const extra = 1;\n');
  }
  for (const [rel, body] of Object.entries(f.extraApp ?? {})) {
    const target = join(app, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  for (const [name, body] of Object.entries(f.extraConfigs ?? {})) {
    writeFileSync(join(app, name), JSON.stringify(body, null, 2));
  }

  const lint = f.lintScript === undefined ? 'tsc --noEmit' : f.lintScript;
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'studio', scripts: { test: 'vitest run', ...(lint === null ? {} : { lint }) } }, null, 2)
  );

  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: { ...BASE_OPTIONS, strict: f.strict ?? true, ...(f.options ?? {}) },
        ...(f.files ? { files: f.files } : { include: f.include ?? ['src', 'tests', '*.config.ts'] }),
      },
      null,
      2
    )
  );
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), f.workflow ?? WORKFLOW_WITH_STEP);
  // The behavioural half of the guard runs the real `npm run lint -w apps/studio`, and it is the
  // ROOT package.json that resolves that `-w` selector — in CI and here alike.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['apps/*'] }, null, 2));
}

function runGuard(...flags: readonly string[]): { status: number; output: string } {
  return runGuardWithEnv({}, ...flags);
}

/**
 * The workflow reader alone. Every round-7 must-FIRE case already skips the behavioural half — the
 * guard runs it only when no pre-filter has failed — so running the must-NOT-fire controls beside
 * them in `--shape-only` keeps the pair symmetric and keeps this file's serial block from growing by
 * two real type-checks per control. What the controls assert is a workflow verdict; the behavioural
 * half is asserted by the baseline case at the top of this file.
 */
function runGuardShape(): { status: number; output: string } {
  return runGuardWithEnv({}, '--shape-only');
}

function runGuardWithEnv(env: Readonly<Record<string, string>>, ...flags: readonly string[]): { status: number; output: string } {
  // A guard that hangs must fail this suite, not stall it: without a timeout a spin in the tree walk
  // blocks vitest until the job's 30-minute ceiling, which reads as infrastructure, not as a bug.
  // The budget covers two real type-checks now, which on a fixture this size are still sub-second.
  const r = spawnSync(process.execPath, [GUARD, root, ...flags], {
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ...env },
  });
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.signal ? `\nkilled by ${r.signal}` : ''}` };
}

/**
 * The links of a command chain whose every link's failure reaches the chain's exit code — which is
 * to say, a chain joined by `&&` and nothing else.
 *
 * The first version split on `&&` and trusted the pieces, and that encoded the very bug it was
 * written to catch: `npm run check:studio-typecheck && anything || true` splits into
 * `['npm run check:studio-typecheck', 'anything || true']`, so `toContain` found an exact first link
 * and passed — while the chain exits 0 with the guard having failed. Bash's `&&`/`||` list is
 * left-associative: a failure walks right past every `&&` to the first `||` and the list exits with
 * THAT command's status, so no link of a chain containing a `||` is enforced, not merely the one it
 * is glued to. A pipe, a `;` and a `&` break the same property for their own reasons.
 *
 * So this reads default-deny, like the guard it mirrors: any operator other than `&&` means the
 * chain cannot be proven to carry a failure out, and it yields NO links at all rather than a list an
 * exact-match assertion can still find something in. This is the package-script analogue of the
 * guard's own command-position rule, kept here rather than shared because npm scripts are a far
 * smaller language than a `run:` block and a shared tokeniser would be the more complex one.
 */
const commandChain = (script: string): string[] => {
  const parts = script.split(/(\|\||&&|;|\||&)/);
  const links = parts.filter((_, i) => i % 2 === 0).map((s) => s.trim());
  const operators = parts.filter((_, i) => i % 2 === 1).map((s) => s.trim());
  return operators.every((op) => op === '&&') ? links : [];
};

/** GitHub's `continue-on-error`, read the way the guard reads it: only an explicit false enforces. */
const enforcing = (value: unknown): boolean =>
  value === undefined || value === null || String(value).trim().toLowerCase() === 'false';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sd64-p7-guard-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('apps/studio type-check coverage guard (P7)', () => {
  it('passes on a correctly wired arrangement — otherwise it cannot distinguish broken from whole', () => {
    buildFixture();
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('fails when `include` is narrowed so app files drop out of the project', () => {
    // The P7 shape exactly: tsc still exits 0, over a project that no longer contains the app.
    buildFixture({ include: ['src'] });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('tests/unit/boot.test.ts');
    expect(output).toContain('vitest.config.ts');
  });

  it('fails when a new src file is not matched by `include`', () => {
    // Guards the direction a growing app breaks in: files are added, the project is not widened.
    buildFixture({ include: ['src/main', 'tests', '*.config.ts'], extraSrc: ['renderer.ts'] });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('src/renderer.ts');
  });

  it('fails when the project lists every file but checks almost nothing (`strict: false`)', () => {
    buildFixture({ strict: false });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    // The pre-filter's own wording. `strict: true` alone would not do: the behavioural failure names
    // that string too, so this fixture is caught twice and asserting the shared substring would be
    // satisfied by either mechanism — leaving the pre-filter free to be deleted unnoticed.
    expect(output).toContain('a non-strict project sees every file');
  });

  it('fails when ci.yml stops invoking the app type-check — the literal P7 state', () => {
    buildFixture({ workflow: WORKFLOW_WITHOUT_STEP });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('npm run lint -w apps/studio');
  });

  it('fails when the `lint` script no longer type-checks — the CI step runs whatever it is', () => {
    // Identified by the pre-filter's own message: `"lint": "true"` is caught behaviourally too, so
    // asserting only the exit code would leave the fast path unexercised.
    buildFixture({ lintScript: 'true' });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('so this script IS the app');
    expect(output).toContain('tsc --noEmit');
  });

  it('fails when apps/studio has no `lint` script at all', () => {
    buildFixture({ lintScript: null });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('lint');
  });

  it('accepts a `lint` script that names its project explicitly', () => {
    // Must-not-fire: `-p <path>` is a legitimate way to write the same check, and a guard that
    // rejected it would push the next author to weaken the assertion rather than satisfy it. It stays
    // allowed precisely because the behavioural check decides whether the named project is real.
    buildFixture({ lintScript: 'tsc -p tsconfig.json --noEmit' });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('fails when the invocation survives only inside a ci.yml comment', () => {
    buildFixture({ workflow: WORKFLOW_COMMENT_ONLY });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('npm run lint -w apps/studio');
  });

  it('accepts a real step carrying a trailing comment', () => {
    buildFixture({ workflow: WORKFLOW_TRAILING_COMMENT });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('fails when a .ts file outside src/tests is covered by nothing', () => {
    buildFixture({ extraApp: { 'scripts/make-icons.ts': 'export const icons = 1;\n' } });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('scripts/make-icons.ts');
  });

  it('fails when a .mts / .cts file is covered by nothing', () => {
    buildFixture({
      extraApp: { 'tooling.mts': 'export const t = 1;\n', 'legacy.cts': 'export const l = 1;\n' },
    });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('tooling.mts');
    expect(output).toContain('legacy.cts');
  });

  it('ignores node_modules, out and dist — build output is not source the app must type-check', () => {
    // Must-not-fire: the widened walk runs over a tree that always contains installed dependencies
    // and build output. Flagging those would make the guard fire on every correctly wired repo,
    // i.e. it would be turned off rather than satisfied.
    buildFixture({
      extraApp: {
        'node_modules/dep/index.d.ts': 'export declare const d: number;\n',
        'out/main/index.ts': 'export const built = 1;\n',
        'dist/renderer.mts': 'export const built = 2;\n',
      },
    });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Bypass 1 — a decoy project named by `-p`.
  // Mutant: delete the behavioural check (or stop planting probes). Blast radius: this case goes
  // green while `npm run lint -w apps/studio` compiles one trivial file and nothing else. Every
  // shape-check in the guard passes on this fixture — the tsconfig is strict and complete, the lint
  // script matches the allowed `-p` form, the CI step is present — which is why it survived two
  // hardening passes.
  // ---------------------------------------------------------------------------------------------
  it('fails when the `lint` script points `-p` at a decoy project that checks nothing', () => {
    buildFixture({
      lintScript: 'tsc --noEmit -p tsconfig.decoy.json',
      extraConfigs: {
        // A decoy that compiles cleanly: `files` names one real file, so tsc exits 0 rather than
        // erroring for want of inputs, and no planted file can ever enter this project.
        'tsconfig.decoy.json': { compilerOptions: { ...BASE_OPTIONS, strict: true }, include: [], files: ['src/main/index.ts'] },
      },
    });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('planted type errors');
    expect(output).toContain('not type-checking this project');
  });

  // ---------------------------------------------------------------------------------------------
  // Bypass 2 — `strict: true` with its members off.
  // Mutant: drop the flag probes and keep only the baseline one. Blast radius: this case goes green
  // with `options.strict === true` and almost every check disabled. The guard asserted
  // `options.strict !== true` and nothing else, so this was invisible to it by construction.
  // ---------------------------------------------------------------------------------------------
  it('fails when `strict: true` is paired with every strict member flag switched off', () => {
    buildFixture({ options: STRICT_MEMBERS_OFF });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    // Named individually, because a count would pass a guard that noticed only one of them — and by
    // the message of the mechanism that must catch them. The unprobed-flag pin also names every flag
    // it knows about, so asserting the names alone is satisfied by a guard whose probes were deleted:
    // a battery mutant that emptied PROBES left this test green while the property it names was
    // violated, which is how a collateral red reads as coverage.
    for (const flag of Object.keys(STRICT_MEMBERS_OFF)) expect(output).toContain(flag);
    expect(output).toContain('are disabled in apps/studio/tsconfig.json');
    // The baseline probe is a plain assignment mismatch, which no strict flag governs: it must still
    // be reported, or this fixture would be indistinguishable from a type-check that does not run.
    expect(output).not.toContain('- baseline');
  });

  it('fails when a single strict member flag is switched off', () => {
    // The realistic edit is one flag, not eight, and a guard that only noticed the wholesale version
    // would be satisfied by the version anyone would actually write.
    buildFixture({ options: { strictNullChecks: false } });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('strictNullChecks');
    expect(output).not.toContain('noImplicitThis');
    // The behavioural mechanism's own wording, for the same reason as the case above. (Switching one
    // member off drops four probes, not one: three of them need null checks to error at all.)
    expect(output).toContain('disabled in apps/studio/tsconfig.json');
  });

  // ---------------------------------------------------------------------------------------------
  // Bypass 3 — a `run:`-looking line inside a YAML block scalar.
  // Mutant: revert the CI assertion to a regex over the workflow text. Blast radius: this case goes
  // green with no step invoking the app type-check anywhere in the file.
  // ---------------------------------------------------------------------------------------------
  it('fails when the invocation appears only inside a YAML block scalar, not a step', () => {
    buildFixture({ workflow: WORKFLOW_BLOCK_SCALAR_DECOY });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('no enabled `run:` step');
  });

  // ---------------------------------------------------------------------------------------------
  // Bypass 4 — the step exists and cannot execute.
  // Mutant: stop consulting `if:`. Blast radius: both cases below go green while the app type-check
  // never runs in CI, which is P7's recorded state with the asserted line still in the file.
  // ---------------------------------------------------------------------------------------------
  it('fails when the real step is disabled with `if: false`', () => {
    buildFixture({ workflow: WORKFLOW_STEP_IF_FALSE });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('cannot be relied on to run');
    expect(output).toContain('if: false');
  });

  it('fails when the job carrying the step is disabled with `if: false`', () => {
    buildFixture({ workflow: WORKFLOW_JOB_IF_FALSE });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('cannot be relied on to run');
    expect(output).toContain('studio-unit');
  });

  it('accepts a step conditional on `always()` — a condition that cannot disable it', () => {
    // Must-not-fire, and the case that keeps the `if:` rule from collapsing into "any condition is
    // disabling": that reading would fire on a healthy workflow, and the fix would be to delete the
    // assertion rather than the condition.
    buildFixture({ workflow: WORKFLOW_IF_ALWAYS });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // False FAIL 5 — the inline `- run:` form.
  // Mutant: re-anchor the CI assertion to `^[ \t]*run:`. Blast radius: this case fails on a workflow
  // whose step is present and correct. ci.yml already writes four other steps this way, so the next
  // author to collapse the studio step onto one line would find the guard wrong and switch it off.
  // ---------------------------------------------------------------------------------------------
  it('accepts the inline `- run:` step form that ci.yml uses elsewhere', () => {
    buildFixture({ workflow: WORKFLOW_INLINE_RUN });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Bypasses 8-12 — execution semantics. The checks above prove the invocation SITS in an enabled
  // step; none of them proves the shell RUNS it, or that its failure reaches the job's conclusion.
  // Every fixture in this section parses as a real, unconditional `run:` step carrying the exact
  // invocation, which is why each one printed "invoked by an enabled ci.yml step" and exited 0.
  //
  // Each case asserts the wording of the rule that owns it, because several of these shapes are one
  // edit apart and a shared substring would let any one detector die unnoticed.
  // ---------------------------------------------------------------------------------------------

  it('fails when the invocation is commented out inside its own step — the live SD0 repro', () => {
    // Mutant: skip the comment strip. Blast radius: this case goes green with the studio type-check
    // switched off in one line, the step still named `Lint studio`, and every other check satisfied.
    buildFixture({ workflow: WORKFLOW_SHELL_COMMENTED });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('not as a command it runs');
    // Naming the step is the point: "somewhere in ci.yml" is not actionable when the file has 20 of
    // them, and the acceptance criterion for this issue is a message that names it.
    expect(output).toContain('Lint studio (tsc --noEmit)');
  });

  it('fails when the invocation survives only as a quoted string', () => {
    // Mutant: match the invocation anywhere in the run text instead of at a command position.
    buildFixture({ workflow: WORKFLOW_ECHOED });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('not as a command it runs');
  });

  it('fails when the invocation is only an argument to another command', () => {
    // Mutant: match anywhere in the command instead of at its head. Blast radius: this case goes
    // green while the step echoes the command it is supposed to run.
    buildFixture({ workflow: WORKFLOW_ECHOED_BARE });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('not as a command it runs');
  });

  it('accepts an argument that merely contains a shell operator', () => {
    // Must-not-fire. Mutant: stop tracking quotes. Blast radius: this case fails on a correctly
    // wired step, reporting a quoted `||` inside an argument as an exit-code swallow.
    buildFixture({ workflow: WORKFLOW_QUOTED_ARGUMENT });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('accepts a trailing comment that names an operator', () => {
    // Must-not-fire. Mutant: stop stripping comments. Blast radius: this case fails because the `||`
    // inside the warning comment is read as the thing the comment warns against.
    buildFixture({ workflow: WORKFLOW_COMMENT_NAMING_AN_OPERATOR });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('fails when the invocation is suffixed with `|| true`', () => {
    // Mutant: drop the exit-code rule. Blast radius: the type-check runs, prints its errors, and the
    // step passes — the loudest possible way to enforce nothing.
    buildFixture({ workflow: WORKFLOW_OR_TRUE });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('discards its exit code');
    expect(output).toContain('`||`');
  });

  it('fails when the invocation is piped, so `$?` belongs to the last stage', () => {
    buildFixture({ workflow: WORKFLOW_PIPED });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('discards its exit code');
    expect(output).toContain('`|`');
  });

  it('fails when `set +e` disarms the abort the step relies on', () => {
    // The subtlest of the family: the command is in command position, unpiped, unsuffixed, and its
    // failure still does not fail the step.
    buildFixture({ workflow: WORKFLOW_SET_PLUS_E });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('set +e');
  });

  it('fails when the step is marked `continue-on-error`', () => {
    // Mutant: consult `if:` only. Blast radius: the type-check runs, fails, is reported red in the
    // step list, and the job — and therefore the required check — still concludes SUCCESS.
    buildFixture({ workflow: WORKFLOW_STEP_CONTINUE_ON_ERROR });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('continue-on-error');
    expect(output).toContain('Lint studio (tsc --noEmit)');
  });

  it('fails when the job carrying the step is marked `continue-on-error`', () => {
    buildFixture({ workflow: WORKFLOW_JOB_CONTINUE_ON_ERROR });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('continue-on-error');
    expect(output).toContain('studio-unit');
  });

  it('accepts a multi-line `run:` block whose neighbours preserve the exit code', () => {
    // Must-not-fire, and the case that stops the exit-code rule collapsing into "any neighbouring
    // command is disqualifying": grouping output around a check is normal, and a guard that rejected
    // it would be worked around rather than satisfied. Under the runner's `bash -e` a failing
    // invocation aborts the block, so the step's exit code is the type-check's.
    buildFixture({ workflow: WORKFLOW_MULTILINE_BENIGN });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('fails when `continue-on-error` is an expression it cannot evaluate', () => {
    // Mutant: read `continue-on-error` as "anything but the boolean true enforces". Blast radius:
    // this case goes green, and so does the string `'true'` — and the only direction that can fail
    // silently is the one that assumes an unevaluable condition is false.
    buildFixture({ workflow: WORKFLOW_CONTINUE_ON_ERROR_EXPRESSION });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('continue-on-error');
    expect(output).toContain('Lint studio (tsc --noEmit)');
  });

  it('accepts `continue-on-error: false`, the explicit spelling of the default', () => {
    buildFixture({ workflow: WORKFLOW_CONTINUE_ON_ERROR_FALSE });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Bypass 13 — the workflow never fires. A step can be present, unconditional, correctly written
  // and dead, because nothing above it in the file ever starts the run.
  // ---------------------------------------------------------------------------------------------

  it('fails when the workflow never runs on `pull_request`', () => {
    // Mutant: drop the trigger check. Blast radius: the type gate stops blocking PRs — the exact
    // regression e29d14d7 fixed for this repo once already, when `pull_request` was main-only.
    buildFixture({ workflow: WORKFLOW_NO_PR_TRIGGER });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('never runs on');
    expect(output).toContain('pull_request');
  });

  it('fails when the triggers exclude the branch this program merges into', () => {
    buildFixture({ workflow: WORKFLOW_PUSH_MAIN_ONLY });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('studio-handoff');
  });

  it('accepts the unfiltered `on: [push, pull_request]` shorthand', () => {
    // Must-not-fire: no `branches:` filter means every branch, so this fires for more than the guard
    // demands. Rejecting it would make the guard fire on the most permissive wiring there is.
    buildFixture({ workflow: WORKFLOW_TRIGGER_SHORTHAND });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Round 6 — DEFAULT-DENY. The seven shapes reproduced live on c7375e73 (guard exits 0 and prints
  // its OK claim; the claim is false in each), plus the one false FAIL, plus their must-not-fire
  // controls.
  //
  // The mutant for this whole section is not "delete one detector" — it is "restore the blacklist",
  // i.e. make `firesForBranch` return `true` for a config key it does not recognise, or make
  // `readRun` fall off the end of its switch instead of setting `unmodeled`. Blast radius: every
  // case below goes green, and so does the next shape nobody has thought of yet, which is precisely
  // why four rounds of enumeration each found more.
  // ---------------------------------------------------------------------------------------------

  it('fails when a branch filter EXCLUDES this branch with `!`', () => {
    buildFixture({ workflow: WORKFLOW_NEGATED_BRANCH });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    // The reason, not just the branch name: `studio-handoff` appears in the OK line too, so a
    // substring assertion on the name alone would be satisfied by a guard that never fired.
    expect(output).toContain('!studio-handoff');
    expect(output).toContain('EXCLUSION');
  });

  it('fails when a path filter can stop an app-only edit starting any run', () => {
    // The gate exists to catch an edit under `apps/**`; `paths-ignore: [apps/**]` means exactly that
    // edit starts nothing. `branches` is untouched, which is why the previous reader approved it.
    buildFixture({ workflow: WORKFLOW_PATHS_IGNORE });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('`paths-ignore`');
    expect(output).toContain('does not model');
  });

  it('fails when a `paths:` allowlist never names the app', () => {
    buildFixture({ workflow: WORKFLOW_PATHS_FILTER });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('`paths`');
    expect(output).toContain('does not model');
  });

  it('fails when `pull_request` is narrowed to activity types a code push never raises', () => {
    buildFixture({ workflow: WORKFLOW_PR_TYPES });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('`types`');
    expect(output).toContain('pull_request');
  });

  it('fails when `branches` is a scalar rather than a list', () => {
    // The old reader tested `Array.isArray(branches)` and fell through to "fires" when it was false,
    // so the one spelling that names a single branch — and excludes this one — was the spelling it
    // could not see.
    buildFixture({ workflow: WORKFLOW_SCALAR_BRANCHES });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('not a list of patterns');
  });

  it('accepts a `*` glob that covers this branch', () => {
    // Must-not-fire. `studio-*` is a pattern the guard models and it matches, so default-deny must
    // not collapse into "any filter at all is a FAIL" — that reading would fire on healthy wiring.
    buildFixture({ workflow: WORKFLOW_BRANCH_GLOB });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('accepts extra top-level events beside push and pull_request', () => {
    // Must-not-fire, and the boundary of the default-deny: an extra EVENT can only add runs, so it
    // is out of scope, while an extra FILTER under push/pull_request can remove them and is not.
    // The real ci.yml carries `workflow_call`, so getting this wrong reds the tree it guards.
    buildFixture({ workflow: WORKFLOW_EXTRA_EVENTS });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('fails when a `||` predecessor decides whether the invocation runs at all', () => {
    // `git diff --quiet apps/studio || npm run lint …`: on every run where the app was untouched the
    // predecessor succeeds, the `||` short-circuits, and the step exits 0 having checked nothing.
    buildFixture({ workflow: WORKFLOW_OR_PREDECESSOR });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('in FRONT of it');
  });

  it('fails when a later `||` rescues the whole `&&` chain', () => {
    // `A && echo done || true` exits 0 when A fails. Reading only the invocation's immediate `after`
    // operator saw a clean `&&` and approved.
    buildFixture({ workflow: WORKFLOW_LATER_OR });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('discards its exit code');
    expect(output).toContain('left-associative');
  });

  it('fails when the invocation lives inside a heredoc body', () => {
    buildFixture({ workflow: WORKFLOW_HEREDOC });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('heredoc');
    expect(output).toContain('Cannot prove this runs');
  });

  it.each([
    ['set +ex', WORKFLOW_SET_PLUS_EX],
    ['set +euo pipefail', WORKFLOW_SET_PLUS_EUO],
    ['set +o errexit', WORKFLOW_SET_PLUS_O_ERREXIT],
  ])('fails when errexit is switched off by `%s`', (_name, workflow) => {
    // Three spellings of one edit. The detector was a regex written for `set +e` and matched none of
    // them — which is the whole argument for parsing `set` rather than pattern-matching it.
    buildFixture({ workflow });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('switches errexit off');
  });

  it('accepts `set +x`, which switches tracing off and leaves errexit alone', () => {
    // Must-not-fire, and the case that keeps the `set` rule from collapsing into "any `set +…` is
    // disarming". A parser can tell these apart; a regex over the whole cluster cannot.
    buildFixture({ workflow: WORKFLOW_SET_PLUS_X });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('accepts `set -euo pipefail`, the armed spelling', () => {
    buildFixture({ workflow: WORKFLOW_SET_MINUS_EUO });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('fails when the job carrying the step has a matrix that can evaluate to zero legs', () => {
    // A job with no legs is SKIPPED, and skipped rolls up to the run's conclusion as Success. The
    // step is present, enabled, unconditional, correctly written, and executed zero times.
    buildFixture({ workflow: WORKFLOW_EMPTY_MATRIX });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('zero legs');
  });

  it('fails when the matrix leg count hides behind an expression', () => {
    buildFixture({ workflow: WORKFLOW_EXPRESSION_MATRIX });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('cannot be proven to run');
  });

  it('accepts the 3-OS matrix the real studio-unit job carries', () => {
    // Must-not-fire: three literal legs are provably at least one. Getting this wrong reds the tree.
    buildFixture({ workflow: WORKFLOW_MATRIX_THREE_OS });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('fails when the invocation is backgrounded with `&`', () => {
    // Mutation gap: deleting the `&` entry from DISCARDS_EXIT_CODE leaves this case green with the
    // step never waiting for the type-check at all.
    buildFixture({ workflow: WORKFLOW_BACKGROUNDED });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('discards its exit code');
    expect(output).toContain('`&`');
  });

  it('fails when the invocation is inverted with `!`', () => {
    // Mutation gap: deleting the `!` block leaves this green with the step passing EXACTLY when the
    // type-check fails — the inverted gate, which is worse than no gate.
    buildFixture({ workflow: WORKFLOW_NEGATED_INVOCATION });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('`!` inverts it');
  });

  it.each([
    ['> lint.log 2>&1', WORKFLOW_REDIRECT_STDERR],
    ['>& lint.log', WORKFLOW_REDIRECT_AMP_GT],
    ['&> lint.log', WORKFLOW_REDIRECT_AMP],
  ])('accepts the redirection `%s` rather than reading its `&` as backgrounding', (_name, workflow) => {
    // Must-not-fire ×3, one per spelling of the same redirection. Deleting the redirection exemption
    // reds the first two; the third is the RED-direction defect round 6 found, where the operator
    // test looked backwards for a `>` but not forwards and reported a correctly wired step as
    // backgrounded. A guard that fires on a healthy tree gets deleted rather than obeyed.
    buildFixture({ workflow });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it.each([
    ['a condition context', WORKFLOW_IF_BLOCK, 'if'],
    ['a subshell', WORKFLOW_SUBSHELL, 'subshell'],
    ['a workflow expression', WORKFLOW_GHA_EXPRESSION, '${{'],
  ])('fails on %s rather than guessing what it runs', (_name, workflow, needle) => {
    // Not blacklist entries — evidence that the DEFAULT is deny. None of these was on anyone's list;
    // each falls out of the recogniser's grammar and is reported as unproven. `if npm run lint …;
    // then` is the sharpest of the three: bash suspends errexit inside a condition, so the type-check
    // can fail there and abort nothing at all.
    buildFixture({ workflow });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain(needle);
    expect(output).toContain('Cannot prove this runs');
  });

  it('fails when EXTRA and HIDE name the same unknown strict flag', () => {
    // The hide-set was applied to the COMBINED list while the undeclared pin was computed against the
    // expected list alone, so adding an unprobed flag and hiding it again cancelled out — green,
    // under a comment claiming every setting of either hook makes the guard redder. Filtering the
    // hide-set through EXPECTED_STRICT_FLAGS makes hiding anything else a no-op, so the EXTRA flag
    // survives to the unprobed alarm.
    buildFixture();
    const { status, output } = runGuardWithEnv({
      P7_EXTRA_STRICT_FLAGS: 'strictImaginaryFutureCheck',
      P7_HIDE_STRICT_FLAGS: 'strictImaginaryFutureCheck',
    });
    expect(status).toBe(1);
    expect(output).toContain('strictImaginaryFutureCheck');
    expect(output).toContain('no probe');
  });

  // ---------------------------------------------------------------------------------------------
  // Bypass 14 — a strict check with no probe. The unprobed set was computed and PRINTED, in the OK
  // line of a passing run: prose on stdout is not a gate, so a strict check added by a compiler
  // upgrade would arrive as a sentence nobody reads, with nothing planting an error for it and
  // `strict: true` staying true while it is individually switched off. It is now pinned in both
  // directions.
  // ---------------------------------------------------------------------------------------------

  it('fails when the compiler declares a strict check no probe covers', () => {
    // The flag list comes from the installed TypeScript, so the only way to move it from a test is to
    // inject one. The injection can only ADD names — there is no spelling of it that switches a check
    // off — which is what makes a test-visible hook safe here.
    buildFixture();
    const { status, output } = runGuardWithEnv({ P7_EXTRA_STRICT_FLAGS: 'strictImaginaryFutureCheck' });
    expect(status).toBe(1);
    expect(output).toContain('strictImaginaryFutureCheck');
    expect(output).toContain('no probe');
  });

  it('fails when a probe outlives the strict check it plants an error for', () => {
    // The other direction of the same pin. A probe for a flag the compiler no longer declares proves
    // nothing about the app, and its planted error would go unreported — caught by the behavioural
    // run, but with a message about a missing diagnostic rather than about a retired option.
    buildFixture();
    const { status, output } = runGuardWithEnv({ P7_HIDE_STRICT_FLAGS: 'strictNullChecks' });
    expect(status).toBe(1);
    expect(output).toContain('no longer declares');
    expect(output).toContain('strictNullChecks');
  });

  it('reports the probed strict-check count on success, so the pin is legible in a green run', () => {
    // Must-not-fire companion: the pin must hold on the compiler that is actually installed, or the
    // test above proves only that the guard can fail for some reason.
    buildFixture();
    const { status, output } = runGuard();
    expect(status).toBe(0);
    expect(output).toMatch(/All \d+ strict checks TypeScript [\d.]+ declares are probed/);
  });

  it('fails when `alwaysStrict` — strict-family but untagged by the compiler — is switched off', () => {
    // The issue that scheduled this work expected `alwaysStrict: false` to sail through: it carries
    // no `strictFlag` in TypeScript's option declarations, so it is not in the probed family at all.
    // On the installed compiler it is caught anyway, one layer down — `alwaysStrict: false` is
    // deprecated (TS5107) and the clean run therefore does not pass. Asserted rather than assumed,
    // because "caught by something else" is a claim with a truth value and it is load-bearing here:
    // it is the reason `alwaysStrict` needs no probe.
    buildFixture({ options: { alwaysStrict: false } });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('does not currently pass');
    expect(output).toContain('TS5107');
  });

  // ---------------------------------------------------------------------------------------------
  // False FAIL 6 — electron-builder's output directory.
  // Mutant: drop `release` from NOT_SOURCE. Blast radius: this case fails on any machine that has
  // packaged the app, because `directories.output = 'release'` holds an unpacked copy of the tree and
  // the walk reports the app's own files back as uncovered.
  // ---------------------------------------------------------------------------------------------
  it('ignores electron-builder`s release/ output tree', () => {
    buildFixture({
      extraApp: {
        'release/mac-arm64/Wigolo.app/Contents/Resources/app/src/main/index.ts': 'export const packaged = 1;\n',
        'release/linux-unpacked/resources/app/tooling.mts': 'export const packaged = 2;\n',
      },
    });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // The behavioural check's own preconditions. Both directions matter: a check that cannot prove
  // anything must FAIL rather than pass vacuously, which is P7's failure class applied to itself.
  // ---------------------------------------------------------------------------------------------
  it('fails when the app does not currently type-check, rather than reporting on a broken baseline', () => {
    // Mutant: drop the clean-run assertion. Blast radius: with a pre-existing error in the tree,
    // every planted probe is drowned in real diagnostics and the guard can no longer tell a working
    // type-check from a broken one — it would report OK on a tree that does not compile.
    buildFixture({ extraApp: { 'src/broken.ts': 'export const broken: number = "not a number";\n' } });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('does not currently pass');
    expect(output).toContain('src/broken.ts');
  });

  it('fails when no directory in the project can accept a planted file', () => {
    // Mutant: drop the placement verification and assume `src`. Blast radius: a project defined by
    // `files` alone admits no planted error anywhere, so the planted run reports nothing — which is
    // byte-identical to a type-check that does not run. Refusing to pass is the only safe reading.
    buildFixture({ files: ['src/main/index.ts', 'tests/unit/boot.test.ts', 'vitest.config.ts'] });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('accepts a planted file');
  });

  // ---------------------------------------------------------------------------------------------
  // The two-mode split. The behavioural half needs a built `dist/` (the app imports `wigolo/studio`
  // through the root package's exports), and the `gate` CI job has no build step on purpose, so the
  // halves run from two places. That split is only safe if `--shape-only` is what it claims: a
  // narrower check that still fires on everything the shape-checks own, and the DEFAULT is the full
  // one — an inverted or no-op flag would silently retire the planted-error check everywhere.
  // ---------------------------------------------------------------------------------------------
  it('`--shape-only` skips the planted-error check, and the default does not', () => {
    buildFixture({ options: STRICT_MEMBERS_OFF });
    const shape = runGuard('--shape-only');
    expect(shape.output).toContain('OK (shape only)');
    expect(shape.output).toContain('planted-error check was NOT run');
    expect(shape.status).toBe(0);

    const full = runGuard();
    expect(full.status).toBe(1);
    expect(full.output).toContain('strictNullChecks');
  });

  it('`--shape-only` still fires on everything the shape-checks own', () => {
    // Otherwise the mode that rides three OS on every push would be a no-op wearing a name.
    buildFixture({ include: ['src'], workflow: WORKFLOW_STEP_IF_FALSE, lintScript: 'true', strict: false });
    const { status, output } = runGuard('--shape-only');
    expect(status).toBe(1);
    expect(output).toContain('tests/unit/boot.test.ts');
    expect(output).toContain('a non-strict project sees every file');
    expect(output).toContain('so this script IS the app');
    expect(output).toContain('cannot be relied on to run');
  });

  it('is gated, not documented: both halves of the guard are invoked by something', () => {
    // The `--shape-only` half is chained into gate:studio; the planted-error half is a ci.yml step in
    // the job that builds core, because it cannot resolve `wigolo/studio` without that build. Losing
    // either invocation leaves the corresponding half a local command nobody runs — P7 one level up,
    // and now with two places to lose it from.
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    // `toContain` is satisfied by `node scripts/…mjs --shape-only || true`, which is the same
    // exit-code swallow the workflow half of this issue closes, one layer down. Compare the whole
    // command instead: a swallow cannot hide inside an exact match.
    expect(commandChain(pkg.scripts['check:studio-typecheck'])).toContain(
      'node scripts/check-studio-typecheck-coverage.mjs --shape-only'
    );
    expect(commandChain(pkg.scripts['check:studio-typecheck-runs'])).toContain('node scripts/check-studio-typecheck-coverage.mjs');
    expect(pkg.scripts['check:studio-typecheck-runs']).not.toContain('--shape-only');

    const ci = parseYaml(readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8')) as {
      jobs: Record<string, { if?: unknown; 'continue-on-error'?: unknown; steps?: { if?: unknown; 'continue-on-error'?: unknown; run?: unknown }[] }>;
    };
    const hosts = Object.entries(ci.jobs).filter(([, job]) =>
      (job.steps ?? []).some((s) => typeof s.run === 'string' && s.run.includes('check:studio-typecheck-runs'))
    );
    expect(hosts).toHaveLength(1);
    const [name, job] = hosts[0]!;
    expect(job.if).toBeUndefined();
    // A `continue-on-error` job reports SUCCESS to the required-checks list however its steps went,
    // so this half of the guard would run, fail, and block nothing.
    expect(enforcing(job['continue-on-error'])).toBe(true);
    const steps = job.steps ?? [];
    const planted = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('check:studio-typecheck-runs'));
    expect(steps[planted]!.if).toBeUndefined();
    expect(enforcing(steps[planted]!['continue-on-error'])).toBe(true);
    expect(commandChain(String(steps[planted]!.run))).toContain('npm run check:studio-typecheck-runs');
    // It must run AFTER the build, in the same job: without `dist/` the app cannot resolve
    // `wigolo/studio`, so the clean run fails and the guard reports an environment problem rather
    // than a P7 regression. `name` is asserted so a rename of the host job is a visible decision.
    const build = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('npm run build'));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(planted).toBeGreaterThan(build);
    expect(name).toBe('studio-unit');
  });

  // ---------------------------------------------------------------------------------------------
  // ROUND 7 — the key layer, the match, and two blanking divergences.
  //
  // Every case here asserts the MECHANISM'S OWN WORDING, not merely a non-zero exit: a guard with
  // eight ways to fail and eight tests that only count the exit code cannot tell a live check from a
  // dead one, which is the #60 M8 lesson. Each must-fire has a must-not-fire control beside it,
  // because a guard that reds a healthy tree gets deleted rather than obeyed.
  // ---------------------------------------------------------------------------------------------

  it('fails when an argument is APPENDED to the invocation — the measured command stops being the CI command', () => {
    // Shape 1. `-- --help` makes CI run `tsc --noEmit --help`: prints help, checks nothing, exits 0.
    // The behavioural half runs the bare constant, so before this the guard reported nine planted
    // errors found by a command CI never runs.
    buildFixture({ workflow: WORKFLOW_APPENDED_HELP });
    const { status, output } = runGuard();
    expect(output).toContain('with `-- --help` APPENDED');
    expect(output).toContain('The invocation must be the ENTIRE command, exactly');
    expect(status).toBe(1);
  });

  it('fails when the appended argument re-points the project at a decoy', () => {
    buildFixture({ workflow: WORKFLOW_APPENDED_DECOY });
    const { status, output } = runGuard();
    expect(output).toContain('with `-- -p tsconfig.decoy.json` APPENDED');
    expect(status).toBe(1);
  });

  it("fails on an appended argument npm would consume itself — nothing here can tell npm's flags from a forwarded `--`", () => {
    // The cost of exactness, pinned rather than left implicit: `--loglevel warn` is harmless in fact
    // and denied in principle. Guessing which trailing words are harmless is the guess that fails
    // silently, and A227's reversal condition covers this if it ever becomes brittle in practice.
    //
    // The reported argument is the whole of it, quotes removed — which is what bash passes. While
    // quoted regions blanked to spaces this read `--loglevel` alone, so the guard named an argument
    // shorter than the one CI forwards; the same blanking made `-w "apps/studio"` read as
    // `npm run lint -w` and reds a correctly wired step (round 8's D5).
    buildFixture({ workflow: WORKFLOW_APPENDED_NPM_FLAG });
    const { status, output } = runGuard();
    expect(output).toContain('with `--loglevel warn || error` APPENDED');
    expect(status).toBe(1);
  });

  it('fails when a `||` sits behind a pipe further along the same list', () => {
    // Shape 2. The scan used to `break` at the pipe and never reach the `||`. Bash reads this as
    // `A && (echo done|cat) || true` — a failure walks right past the `&&` and `true` supplies the
    // exit code.
    buildFixture({ workflow: WORKFLOW_LATER_OR_PAST_PIPE });
    const { status, output } = runGuard();
    expect(output).toContain('a `||` further along the same left-associative list rescues the whole chain');
    expect(status).toBe(1);
  });

  it('accepts a pipe on a NEIGHBOUR with no later `||` — a pipe alone cannot rescue the invocation', () => {
    // Must-not-fire control for shape 2. Mutant: turn the `continue` back into a `break` and this
    // still passes, which is why the case above is the one that names the mechanism; mutant: drop
    // the `j > index` exemption entirely and THIS case reds on a correctly wired step.
    buildFixture({ workflow: WORKFLOW_PIPE_NO_LATER_OR });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('fails when a `trap` catches the errexit abort the step relies on', () => {
    buildFixture({ workflow: WORKFLOW_TRAP_ERR });
    const { status, output } = runGuard();
    expect(output).toContain('the control-flow builtin `trap`');
    expect(status).toBe(1);
  });

  it('fails when a bare `exit` ends the body before the invocation', () => {
    buildFixture({ workflow: WORKFLOW_BARE_EXIT });
    const { status, output } = runGuard();
    expect(output).toContain('the control-flow builtin `exit`');
    expect(status).toBe(1);
  });

  it('fails when `exec` replaces the shell before the invocation', () => {
    buildFixture({ workflow: WORKFLOW_EXEC });
    const { status, output } = runGuard();
    expect(output).toContain('the control-flow builtin `exec`');
    expect(status).toBe(1);
  });

  it('accepts a neighbour that merely names the control-flow words as arguments', () => {
    // Must-not-fire control for shape 3: the denial is on the command HEAD. Mutant: match the words
    // anywhere in the command text and this correctly wired step reds.
    buildFixture({ workflow: WORKFLOW_CONTROL_WORDS_AS_ARGUMENTS });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('fails when a `${{ }}` expression is QUOTED — the runner substitutes before the shell sees it', () => {
    // Shape 4. The unquoted spelling was already denied; the quote branch `continue`d past the check,
    // so two quotes flipped the verdict on the identical bypass. With `suffix: ["x' || true #"]` bash
    // receives `npm run lint -w apps/studio 'x' || true #'`.
    buildFixture({ workflow: WORKFLOW_QUOTED_GHA_EXPRESSION });
    const { status, output } = runGuard();
    expect(output).toContain('a `${{ … }}` workflow expression');
    expect(output).toContain('quoting it changes nothing');
    expect(status).toBe(1);
  });

  it('accepts a shell variable — `$HOME` is not a workflow expression', () => {
    // Must-not-fire control for shape 4. Mutant: scan the raw body for `$` rather than `${{` and this
    // healthy step reds.
    buildFixture({ workflow: WORKFLOW_SHELL_VARIABLE });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('fails when `shell:` is a template form that drops errexit', () => {
    // Shape 5. `shell:` was never read, so every `;`/newline verdict this guard makes was asserted
    // about a shell nobody had checked. `bash --noprofile --norc {0}` is bash with no `-e`.
    buildFixture({ workflow: WORKFLOW_SHELL_TEMPLATE });
    const { status, output } = runGuard();
    expect(output).toContain('carries `shell: bash --noprofile --norc {0}`, which this guard does not model');
    expect(status).toBe(1);
  });

  it('fails when `shell:` is absent on a job that can land on a Windows runner', () => {
    // Shape 5's deletion hazard: the default shell on Windows is pwsh, which has no errexit, so
    // deleting `shell: bash` from the real 3-OS job silently moves one leg to a shell none of this
    // guard's reasoning applies to.
    buildFixture({ workflow: WORKFLOW_SHELL_ABSENT_ON_WINDOWS });
    const { status, output } = runGuard();
    expect(output).toContain('has no `shell:` key while its job can run on a Windows runner');
    expect(status).toBe(1);
  });

  it('accepts the real job spelling: a 3-OS matrix with `shell: bash` named', () => {
    buildFixture({ workflow: WORKFLOW_SHELL_BASH_ON_WINDOWS });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('accepts an absent `shell:` on a runner that provably is not Windows', () => {
    // Must-not-fire control: the Windows rule is POSITIVE-evidence only. Mutant: require an explicit
    // `shell:` unconditionally and this — plus most fixtures in this file — reds.
    buildFixture({ workflow: WORKFLOW_SHELL_ABSENT_ON_UBUNTU });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('fails when the job carries `needs:` — a skipped dependency skips this job, and skipped reports SUCCESS', () => {
    buildFixture({ workflow: WORKFLOW_JOB_NEEDS });
    const { status, output } = runGuard();
    expect(output).toContain('carries the unmodelled key(s) `needs`');
    expect(status).toBe(1);
  });

  // The evidence that the DEFAULT changed rather than the list growing by eight: four constructs
  // nobody enumerated in the round-7 review are denied by the same allowlist, with no entry naming
  // any of them.
  it('fails on job keys nobody enumerated — `container:` and `services:` are denied by the same allowlist', () => {
    buildFixture({ workflow: WORKFLOW_JOB_CONTAINER });
    const container = runGuard();
    expect(container.output).toContain('carries the unmodelled key(s) `container`');
    expect(container.status).toBe(1);

    buildFixture({ workflow: WORKFLOW_JOB_SERVICES });
    const services = runGuard();
    expect(services.output).toContain('carries the unmodelled key(s) `services`');
    expect(services.status).toBe(1);
  });

  it('fails on step keys nobody enumerated — `working-directory:` and `uses:` are denied by the same allowlist', () => {
    buildFixture({ workflow: WORKFLOW_STEP_WORKING_DIRECTORY });
    const cwd = runGuard();
    expect(cwd.output).toContain('carries the unmodelled key(s) `working-directory`');
    expect(cwd.status).toBe(1);

    buildFixture({ workflow: WORKFLOW_STEP_USES });
    const uses = runGuard();
    expect(uses.output).toContain('carries the unmodelled key(s) `uses`');
    expect(uses.status).toBe(1);
  });

  it('fails on a workflow-level `defaults:` — it sets the shell from outside every step', () => {
    buildFixture({ workflow: WORKFLOW_WORKFLOW_DEFAULTS });
    const { status, output } = runGuard();
    expect(output).toContain('sets a workflow-level `defaults:`, which this guard does not model');
    expect(status).toBe(1);
  });

  it('accepts every key the real `studio-unit` job and step actually carry', () => {
    // Must-not-fire control for the whole key layer, and the one that keeps the allowlist honest: an
    // allowlist tight enough to red the tree it guards is an allowlist that gets deleted. `env`,
    // `timeout-minutes`, `runs-on`, `name` and `id` are in it for exactly this reason.
    buildFixture({ workflow: WORKFLOW_REAL_JOB_KEYS });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('fails when a blanked `""` would have manufactured a comment bash does not see', () => {
    // Shape 7. Blanking quoted regions to spaces made `""#` look like a comment at a word boundary,
    // so the guard read the `|| true` behind it as commented out. Bash-verified:
    // `false && echo ""# || echo RESCUED` prints RESCUED and exits 0.
    buildFixture({ workflow: WORKFLOW_QUOTE_BLANK_COMMENT });
    const { status, output } = runGuard();
    expect(output).toContain('a `||` further along the same left-associative list rescues the whole chain');
    expect(status).toBe(1);
  });

  it('fails when the same `""#` sits on the invocation itself, where `#` is an argument', () => {
    buildFixture({ workflow: WORKFLOW_QUOTE_BLANK_ON_INVOCATION });
    const { status, output } = runGuard();
    expect(output).toContain('with `#` APPENDED');
    expect(status).toBe(1);
  });

  it('still reads a real trailing comment as a comment', () => {
    // Must-not-fire control for shape 7, beside the existing operator-naming-comment case: the word
    // boundary must come from the RAW text, and a `#` after whitespace is still a comment. Mutant:
    // never treat `#` as a comment and this correctly wired step reds.
    buildFixture({ workflow: WORKFLOW_TRAILING_COMMENT });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('compiles a branch pattern with a long `*` run without hanging its own gate', () => {
    // Shape 8, a red-direction availability defect: 24 unbounded `*` each compiled to a `.*`, and
    // against a literal that cannot match the engine walks every split of the branch name. The
    // pre-fix guard ran past 60s and was killed; this asserts it now finishes AND reaches a verdict.
    // A budget rather than a stopwatch: the collapse turns an exponential walk into a linear one, so
    // any margin distinguishes them.
    buildFixture({ workflow: WORKFLOW_REDOS_PATTERN });
    const started = Date.now();
    const { status, output } = runGuardShape();
    const elapsed = Date.now() - started;
    expect(output).toContain('it never fires for `studio-handoff`');
    expect(status).toBe(1);
    expect(elapsed).toBeLessThan(20_000);
  });

  it('collapsing `*` runs is behaviour-preserving in both directions', () => {
    // Must-not-fire and must-fire for shape 8's fix. `**` and `studio-**` still match this branch;
    // `releases/**` and `feat/**/x` still do not. Mutant: collapse to the empty string instead of to
    // one `*` and the first half reds; mutant: collapse a `*` run to `.*` unconditionally and the
    // second half greens on filters that never fire for this branch.
    buildFixture({ workflow: WORKFLOW_DOUBLE_STAR_GLOBS });
    const matching = runGuardShape();
    expect(matching.output).toContain('OK (shape only)');
    expect(matching.status).toBe(0);

    buildFixture({ workflow: WORKFLOW_DOUBLE_STAR_NON_MATCH });
    const notMatching = runGuardShape();
    expect(notMatching.output).toContain('it never fires for `studio-handoff`');
    expect(notMatching.status).toBe(1);
  });

  it('accepts `include: []` beside a dimension that provably yields a leg', () => {
    // Shape 9, red direction: `include` only ADDS legs, so it can never take the count to zero. The
    // guard treated it as a dimension and reported a job that provably runs once as unprovable.
    buildFixture({ workflow: WORKFLOW_MATRIX_EMPTY_INCLUDE });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('accepts `include: [{…}]` as the only matrix key — one leg per entry', () => {
    buildFixture({ workflow: WORKFLOW_MATRIX_ONLY_INCLUDE });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('still fails when `include` is the only matrix key AND empty — that really is zero legs', () => {
    // The exemption must not become a hole: the case above and this one differ by one character.
    buildFixture({ workflow: WORKFLOW_MATRIX_ONLY_EMPTY_INCLUDE });
    const { status, output } = runGuard();
    expect(output).toContain('declares no dimensions, so it produces no legs');
    expect(status).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // Round 8. D1 and D2 are regressions the round-7 diff introduced; D3-D5 are the `run:`-grammar
  // tail; D6 and D7 are gaps where a live deny-rule had no fixture proving it live.
  // -------------------------------------------------------------------------------------------

  it('fails when a Windows leg is declared through `matrix.include` and no `shell:` is named', () => {
    // D1. The include exemption made this job "provably runs" and handed it to a Windows reader that
    // read dimensions only — so the key the exemption started trusting was invisible to the check
    // that consumes it. Mutant: read dimensions only again, and this greens while the identical job
    // written with a 3-OS dimension reds. On the Windows leg the body runs under pwsh, which has no
    // errexit, and a failing type-check ships.
    buildFixture({ workflow: WORKFLOW_INCLUDE_WINDOWS_NO_SHELL });
    const { status, output } = runGuard();
    expect(output).toContain('has no `shell:` key while its job can run on a Windows runner');
    expect(status).toBe(1);
  });

  it('accepts the same `include` Windows leg once `shell: bash` is named', () => {
    // D1's must-not-fire. Without it the fix degenerates to "deny any matrix carrying `include`",
    // which reds a job that provably runs — and a guard that fires on a healthy tree gets deleted.
    buildFixture({ workflow: WORKFLOW_INCLUDE_WINDOWS_SHELL_BASH });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('accepts an `include` leg that provably is not Windows with no `shell:` at all', () => {
    // D1's second must-not-fire: the rule is about the LABELS, not about the presence of `include`.
    buildFixture({ workflow: WORKFLOW_INCLUDE_UBUNTU_NO_SHELL });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('fails when `runs-on` is a repository variable and no `shell:` is named', () => {
    // D1, and the reason the reader is INVERTED rather than taught one more key: a reader that only
    // ever adds Windows evidence answers "not Windows" for every spelling it cannot read. Its own
    // wording, distinct from the `can run on a Windows runner` clause above, so a fix to one is not
    // mistaken for a fix to both.
    buildFixture({ workflow: WORKFLOW_RUNS_ON_VARS });
    const { status, output } = runGuard();
    expect(output).toContain('`${{ vars.RUNNER_LABEL }}`');
    expect(output).toContain('cannot resolve that to literal runner labels');
    expect(status).toBe(1);
  });

  it('fails when `runs-on` names a matrix key no dimension and no `include` entry supplies', () => {
    // D1, third spelling. `${{ matrix.os }}` beside a dimension called `runner` resolves to nothing
    // at all, and "nothing" was read as "no Windows".
    buildFixture({ workflow: WORKFLOW_RUNS_ON_MISSING_DIMENSION });
    const { status, output } = runGuard();
    expect(output).toContain('which no `strategy.matrix.os` dimension and no `include` entry supplies a value for');
    expect(status).toBe(1);
  });

  it('fails when a line continuation is used to fake a comment boundary in front of a `|| true`', () => {
    // D2. Bash removes backslash-newline BEFORE tokenising, so it creates no word boundary:
    // `echo ok\` + `# || true` joins to `echo ok# || true`, where `#` is an ordinary character and
    // the rescue runs. Round 7 set `atWordStart` on the continuation while fixing the identical
    // mechanism on the quote branch. Mutant: set `atWordStart = true` there again and this greens.
    buildFixture({ workflow: WORKFLOW_CONTINUATION_FAKE_COMMENT });
    const { status, output } = runGuard();
    expect(output).toContain('a `||` further along the same left-associative list rescues the whole chain');
    expect(status).toBe(1);
  });

  it('accepts a plain line continuation, which joins two lines into one command', () => {
    // D2's must-not-fire: the continuation is transparent, not a separator. Mutant: treat `\`+newline
    // as a command boundary and this correctly wired step reds. The genuine trailing `# comment` with
    // no continuation is covered by the trailing-comment case near the top of this file.
    buildFixture({ workflow: WORKFLOW_CONTINUATION_PLAIN });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it.each([
    ['`$(…)`', WORKFLOW_COMMAND_SUBSTITUTION],
    ['a backtick', WORKFLOW_BACKTICK_SUBSTITUTION],
  ])('fails when %s smuggles arguments past the exact match', (_name, workflow) => {
    // D3. The region blanked to spaces, so the guard matched a bare invocation while bash builds
    // `npm run lint -w apps/studio -- --help` and CI runs `tsc --noEmit --help` — help printed,
    // nothing checked, exit 0. Its own wording: the APPENDED clause below rejects the literal
    // spelling of the same attack and must not be what catches this one.
    buildFixture({ workflow });
    const { status, output } = runGuard();
    expect(output).toContain('a command substitution');
    expect(output).toContain('its OUTPUT becomes arguments');
    expect(status).toBe(1);
  });

  it('rejects the literal `-- --help` suffix by the APPENDED clause, not the substitution one', () => {
    // D3's separation control. Two rules deny the same end state by different mechanisms, and each
    // must own its wording — the copy-pinning class that shipped in #60 and #64.
    buildFixture({ workflow: WORKFLOW_APPENDED_HELP });
    const { status, output } = runGuard();
    expect(output).toContain('with `-- --help` APPENDED');
    expect(output).not.toContain('a command substitution');
    expect(status).toBe(1);
  });

  it('accepts a braced parameter expansion — `${HOME}` is expanded by the shell, not substituted', () => {
    // D3's must-not-fire. Mutant: deny on `$` or on `${` and this healthy step reds.
    buildFixture({ workflow: WORKFLOW_BRACED_SHELL_VARIABLE });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it.each([
    ['builtin', WORKFLOW_BUILTIN_SET_PLUS_E],
    ['command', WORKFLOW_COMMAND_SET_PLUS_E],
  ])('fails when `%s` introduces the `set +e` the guard already denies', (word, workflow) => {
    // D4, and the sharpest spelling round 8 found: one word in front of the exact string the FAIL
    // message claims to catch "in ANY of its spellings", and it was green. The message now quotes the
    // offending command, so a dead prefix-stripper cannot hide behind the old wording.
    buildFixture({ workflow });
    const { status, output } = runGuard();
    expect(output).toContain(`switches errexit off with \`${word} set +e\``);
    expect(status).toBe(1);
  });

  it.each([
    ['eval', WORKFLOW_EVAL_SET_PLUS_E, {}],
    ['source', WORKFLOW_SOURCE_DISARMING_FILE, { 'ci/disarm.sh': 'set +e\n' }],
    ['.', WORKFLOW_DOT_DISARMING_FILE, { 'ci/disarm.sh': 'set +e\n' }],
  ])('fails when `%s` runs errexit-disarming text from outside the workflow file', (word, workflow, extraApp) => {
    // D4's other half. `eval`/`source`/`.` are the same class as `trap`/`exit`/`return`/`exec`: none
    // is an opaque NEIGHBOUR (A228's carve-out), each decides whether the commands around it run or
    // whether their failure reaches the step. The sourced file is committed here so the bypass is
    // the real one — nothing in the workflow text says errexit was switched off.
    buildFixture({ workflow, extraApp: extraApp as Record<string, string> });
    const { status, output } = runGuard();
    expect(output).toContain(`the control-flow builtin \`${word}\``);
    expect(status).toBe(1);
  });

  it('accepts `builtin` in front of a command that is not `set`', () => {
    // D4's must-not-fire: the introducer is stripped, not denied. Mutant: deny `builtin` as a head
    // and this reds; mutant: strip it but keep reading the ORIGINAL head and the two cases above
    // green. Together with the `set +x` and `set -euo pipefail` controls above, this pins that only
    // an errexit-disarming `set` is denied.
    buildFixture({ workflow: WORKFLOW_BUILTIN_ECHO });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it.each([
    ['"apps/studio"', WORKFLOW_QUOTED_WORKSPACE],
    ["'apps/studio'", WORKFLOW_SQUOTED_WORKSPACE],
  ])('accepts `-w %s` — quoting the workspace does not stop it being the invocation', (_name, workflow) => {
    // D5, a false FAIL on a correctly wired step: blanking the quoted region to spaces reduced this
    // to `npm run lint -w` and reported the app type-check `absent`, under a comment claiming this
    // spelling "still reads as the invocation". A guard that reds a healthy tree gets deleted.
    buildFixture({ workflow });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('still reports a genuinely absent invocation when another workspace is quoted', () => {
    // D5's must-fire control: reading quoted CONTENT must not become "any quoted word matches".
    buildFixture({ workflow: WORKFLOW_QUOTED_OTHER_WORKSPACE });
    const { status, output } = runGuard();
    expect(output).toContain('but not as a command it runs');
    expect(status).toBe(1);
  });

  it('fails when a `return` ends the body before the invocation', () => {
    // D6. `trap`, `exit` and `exec` each had a must-fire fixture; `return` had none, so dropping it
    // from CONTROL_FLOW_WORDS was a mutation the whole suite survived — a deny-set member no test
    // proved live.
    buildFixture({ workflow: WORKFLOW_BARE_RETURN });
    const { status, output } = runGuard();
    expect(output).toContain('the control-flow builtin `return`');
    expect(status).toBe(1);
  });

  it.each([
    ['>> lint.log', WORKFLOW_REDIRECT_APPEND],
    ['< /dev/null', WORKFLOW_REDIRECT_STDIN],
    ['&>> lint.log', WORKFLOW_REDIRECT_AMP_APPEND],
  ])('accepts the redirection `%s`, the spellings no fixture exercised', (_name, workflow) => {
    // D7, red direction. `REDIRECTION` models `>>`, `<` and `&>>`, and the three existing fixtures
    // exercise only `>`, `>&` and `&>` — so dropping the `<` or the second `>` from the pattern
    // survived the suite while turning an ordinary redirected step into a false FAIL.
    buildFixture({ workflow });
    const { status, output } = runGuardShape();
    expect(output).toContain('OK (shape only)');
    expect(status).toBe(0);
  });

  it('reports a signal-killed PLANTED run as a probe that did not finish, not as a reopened P7', () => {
    // Shape 10, pinned by fault injection rather than by hoping for load: the clean run has guarded
    // `signal` since it was written, the planted run guarded `error` only, so a killed planted run
    // arrived with `status: null` and no output, fell into the missed-probe branch and accused the
    // tree of reopening P7. Hit once for real, in 1 of 79 runs.
    buildFixture();
    const { status, output } = runGuardWithEnv({ P7_FORCE_SIGNAL_ON_RUN: '2' });
    expect(output).toContain('was killed by SIGKILL over the planted tree');
    expect(output).toContain('not a P7 finding');
    expect(output).not.toContain('did not report');
    expect(status).toBe(1);
  });

  it('reports a signal-killed CLEAN run with its own clause — the pair the injection hook proves live', () => {
    // The control that makes the case above evidence about the PLANTED run specifically: run 1 and
    // run 2 reach different clauses with different wording, so a fix that only touched one of them
    // is visible here.
    buildFixture();
    const { status, output } = runGuardWithEnv({ P7_FORCE_SIGNAL_ON_RUN: '1' });
    expect(output).toContain('killed by SIGKILL — it did not finish, so this is not a type error');
    expect(status).toBe(1);
  });

  // Bypass 7 — nothing asserted that anything invokes the guard.
  // Mutant: delete `npm run check:studio-typecheck &&` from `gate:studio`, or the `gate:studio` step
  // from ci.yml. Blast radius: every suite in the repo stays green while this entire file guards a
  // command nobody runs. Same shape, and the same assertion pair, as
  // `tests/unit/electron-quarantine.test.ts`.
  it('is gated, not documented: gate:studio chains the guard so its failure fails the gate', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:studio-typecheck']).toContain('scripts/check-studio-typecheck-coverage.mjs');
    // `toContain('check:studio-typecheck')` alone is satisfied by
    // `… && npm run check:studio-typecheck || true && …`, where the guard runs, fails, prints its
    // diagnosis and the gate exits 0. The chain must hold the invocation as its own `&&` link.
    expect(commandChain(pkg.scripts['gate:studio'])).toContain('npm run check:studio-typecheck');
  });

  it('is gated, not documented: the CI gate job runs gate:studio', () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/^\s*run: npm run gate:studio\s*$/m);
  });

  // ---------------------------------------------------------------------------------------------
  // The two helpers above, exercised directly. They decide whether a real wiring assertion passes,
  // so a helper that quietly accepted everything would make those assertions vacuous — the failure
  // class this whole file exists to catch, one level further in.
  // ---------------------------------------------------------------------------------------------

  it('commandChain yields links only for a chain joined by `&&` alone', () => {
    expect(commandChain('a && b && c')).toEqual(['a', 'b', 'c']);
    expect(commandChain('a && b || true && c')).not.toContain('b');
    expect(commandChain('a && b | tee log')).not.toContain('b');
    expect(commandChain('a && b ; c')).not.toContain('b');
    expect(commandChain('a && b &')).not.toContain('b');
  });

  it('commandChain does not let a rescued FIRST link pass as an exact match', () => {
    // The bug this helper used to have, and the reason it is tested at all: splitting on `&&` and
    // trusting the pieces makes `A && anything || true` yield `A` as an exact first link, so both
    // wiring assertions below passed on a chain that exits 0 with the guard having failed. The
    // helper encoded the very bug the workflow half of this issue closes, one layer down.
    //
    // Asserted at BOTH call sites' shapes, because they read different strings: the `gate:studio`
    // package script and the ci.yml step's `run:`. A fix to one reading would otherwise look like a
    // fix to both.
    const gate = 'npm run check:no-electron && npm run check:studio-typecheck || true';
    expect(commandChain(gate)).not.toContain('npm run check:studio-typecheck');

    const ciStep = 'npm run check:studio-typecheck-runs && echo done || true';
    expect(commandChain(ciStep)).not.toContain('npm run check:studio-typecheck-runs');

    // Must-not-fire companion: the real shapes still resolve, or the assertions above would be
    // satisfied by a helper that returns nothing for everything.
    expect(commandChain('npm run check:no-electron && npm run check:studio-typecheck')).toContain(
      'npm run check:studio-typecheck'
    );
    expect(commandChain('npm run check:studio-typecheck-runs')).toContain('npm run check:studio-typecheck-runs');
  });

  // This one pins the reading used by the ci.yml assertions in THIS file, which is a local mirror of
  // the guard's — a mutation battery confirmed that mutating the guard leaves it green, so it is not
  // evidence about the guard. The guard's own reading is pinned by the fixtures above.
  it('enforcing() — the wiring assertions\' local mirror — treats every unevaluable value as disabling', () => {
    expect(enforcing(undefined)).toBe(true);
    expect(enforcing(false)).toBe(true);
    expect(enforcing('false')).toBe(true);
    expect(enforcing(true)).toBe(false);
    expect(enforcing('true')).toBe(false);
    expect(enforcing("${{ matrix.os == 'ubuntu-22.04-arm' }}")).toBe(false);
  });
});
