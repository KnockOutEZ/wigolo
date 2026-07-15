# Docker channel verification (S-P1-DOCKER)

Local, no-push verification of the reworked multi-arch Docker channel. Run via
`scripts/verify-channel-docker.sh` on macOS arm64 (Apple Silicon) with Docker
Desktop 29.6.1 + buildx v0.35.0 (qemu emulation for amd64).

- Base SHA: `2dd47764`
- Host: macOS arm64, Docker Desktop 29.6.1, buildx v0.35.0-desktop.2
- Run date: 2026-07-15 (UTC)
- Script result: **PASS** (exit 0)

## Contract

- **default (slim):** browser-engine OS libraries baked at build as root; the
  browser binary + on-device models download on first use into the `/data`
  volume (`PLAYWRIGHT_BROWSERS_PATH=/data/browsers`). Runs as `USER node`.
- **full:** browser binary preinstalled at build into an image-baked path
  (`/opt/browsers`), for `--rm` / no-volume use.
- No image-level `HEALTHCHECK` (stdio MCP default has no HTTP endpoint).
- `sudo` + `python3` present: `sudo` so the first-use deps-strategy probe
  (`sudo -n true`) returns a graceful non-zero instead of a spawn ENOENT;
  `python3` so `doctor` reports a healthy runtime (the pre-existing doctor
  runtime check degrades when neither Python nor Docker is present).

## Image sizes (arm64 native, amd64 emulated)

| Image | Target | Size |
|-------|--------|------|
| `wigolo-verify:default`       | default (slim) arm64 | **1.38 GB** |
| `wigolo-verify:full`          | full arm64           | **2.38 GB** |
| `wigolo-verify:default-amd64` | default (slim) amd64 | **1.72 GB** |

`node_modules` (~759 MB, playwright + onnxruntime + transformers) appears in the
image exactly once; the browser-engine OS libraries add ~370 MB. Earlier drafts
that used `FROM deps` + a second `COPY` + `chown -R /app` triplicated the
node_modules layer (default ballooned to 3.15 GB) — fixed by building `base`
from a clean slim image and copying with `--chown` (no `chown -R` layer).

## Per-check outcomes

| Check | Result | Notes |
|-------|--------|-------|
| `build:arm64:default`     | PASS | multi-stage build, `--load` (no push) |
| `build:arm64:full`        | PASS | browser binary preinstalled |
| `doctor:arm64:default`    | PASS | `Overall: OK`, exit 0 (post-D5 lazy contract) |
| `warmup:arm64:default`    | PASS | lazy browser download + baked-libs launch as `node` |
| `sudo-probe:arm64:default`| PASS | `sudo -n true` non-zero, no spawn ENOENT, no crash |
| `fetch:arm64:default`     | PASS | react.dev rendered via browser tier, real markdown |
| `doctor:arm64:full`       | PASS | `Overall: OK`, exit 0 |
| `fetch:arm64:full`        | PASS | rendered with preinstalled browser (no download) |
| `doctor:amd64:default`    | PASS | boot-level doctor under qemu emulation, `Overall: OK`, exit 0 |

### First-run UX — lazy browser download as USER node (trimmed)

Running `warmup --browser --json` as the non-root `node` user on the slim image
with a fresh `/data` volume. This is what a user sees on the first JS-render:

```
whoami=node uid=1000
[wigolo warmup] Starting wigolo warmup
[wigolo warmup] Installing browser engine (chromium)...
[wigolo warmup] playwright installed
[wigolo warmup] Search engine sidecar: skipped — using multi-engine core backend
[wigolo warmup] Summary:
[wigolo warmup]   Browser:       ok
[wigolo warmup]   Local language model: off (default — set WIGOLO_LOCAL_LLM=auto ...)
{"playwright":"ok","searxng":"skipped"}
--- (exit 0) ---
```

Proves: browser binary downloads lazily into the volume, the baked OS libraries
let the launch smoke-test pass as non-root, and warmup exits 0.

### sudo-probe graceful handling (ENOENT proof)

`node:22-bookworm-slim` ships no `sudo` by default (`which sudo` → exit 1),
which would make the deps-strategy probe (`spawnSync('sudo', ['-n','true'])`)
emit a spawn ENOENT. With `sudo` installed, the probe instead returns a clean
non-zero (no passwordless config) — the intended `skip` strategy:

```
sudo_status=1 spawn_error=none
```

`sudo_status=1` (non-zero, non-passwordless) + `spawn_error=none` (no ENOENT) +
process exit 0 (no crash) = graceful. Even without `sudo`, the lazy install path
is caught by `BrowserAcquirer.startOrJoinInstall` (try/catch → `false`), so an
ENOENT could never crash the process; installing `sudo` additionally lets the
launch smoke-test proceed to success rather than reporting the browser tier
unavailable.

### JS-render fetch (organic, reuses warmed binary)

```
multi-browser pool initialized {"types":["chromium"],"strategy":"round-robin"}
extract provider ready
rerank provider ready
{
  "url": "https://react.dev",
  "title": "React",
  "markdown": "The library for web and native user interfaces ..."
}
```

The browser tier launches, react.dev renders, and content extracts — using the
binary downloaded lazily into the volume in the warmup step.

### amd64 emulated

The amd64 default image built and booted `doctor` under qemu, reporting
`Overall: OK` (exit 0). Only boot-level doctor is exercised under emulation (no
first-use model/browser download under qemu); the browser lazy-download path is
verified natively on arm64.

## Reproduce

```bash
scripts/verify-channel-docker.sh
# Env overrides: IMAGE_BASE (default wigolo-verify), RENDER_URL (default react.dev)
```

The script builds both targets with `buildx --load` (never `--push`), starts
from a clean volume so the browser download is a genuine first-use, and exits 0
only if every required check passes. amd64 emulation is best-effort: reported
UNVERIFIED (not FAIL) if unavailable on the host.
