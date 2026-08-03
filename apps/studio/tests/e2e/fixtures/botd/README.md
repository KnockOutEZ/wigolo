# Vendored BotD — the parity gate's only deterministic verdict

`botd.esm.js` is the unmodified `dist/botd.esm.js` from **`@fingerprintjs/botd@2.0.0`** (MIT —
full text in `LICENSE` beside it).

    sha256  f438ed251dc7414ece9d4a2b6941441ad9ffae1a1905817f5f0c7366e701dd86

## Why it is committed rather than installed or fetched

The parity harness reads four other fixtures — `tls.peet.ws`, `bot-detector.rebrowser.net`, CreepJS
and Sannysoft — and not one of them can gate a pull request. They are third-party sites: they go
down, they change their probe sets without notice, and their verdicts move for reasons that have
nothing to do with this repo. A gate that reds because someone else shipped a new heuristic teaches
a reviewer to ignore it.

This one is offline and pinned, so a red here means **this repo changed**. That is the entire
reason it, and only it, is the fixture the CI gate asserts on.

It is also the fixture that catches the specific regressions this substrate can have. BotD flags
Electron three independent ways — `navigator.userAgent` matching `/Electron/i`,
`navigator.appVersion` matching `/electron/i`, and a reachable `window.process` whose `type` is
`renderer` or which carries `versions.electron`. The first two red if the UA identity stops being
applied; the third reds if a tab is ever created without `contextIsolation` and `sandbox`. Those
are exactly the two mistakes that are invisible in a unit test and expensive in production.

## What a pass does and does not mean

A `bot: false` verdict means none of BotD's checks fired. It is a **regression floor**, not
evidence of parity with real Chrome — BotD tests a specific, public, enumerable set of automation
markers, and the interesting 2026 detectors do not. Parity against real Chrome is measured by the
local live harness and reported with its conditions stated; it is not asserted here and its scores
are not published.

## Updating

Re-pack the same package, replace the file, update the version and hash above. Do not edit the
bundle: a locally patched detector proves nothing.
