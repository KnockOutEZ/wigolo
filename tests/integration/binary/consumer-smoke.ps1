# The consumer's battery on Windows — single-binary mini-spec §4 (BIN-8).
#
#   consumer-smoke.ps1 -ReleaseBase <url> -Tag <tag> -Semver <semver>
#
# WHY WINDOWS DOES ITS OWN ACQUISITION. `install.sh` refuses Windows by design (§5, and the
# script says so in the refusal it prints), so there is no installer leg to exercise here.
# What the §4 contract still promises a Windows user is the rest of the sequence: find the
# asset by its published name, verify it against `SHA256SUMS` BEFORE unpacking it (G4), and
# run it. That is what this file does, by hand, the way the release notes tell a user to.
#
# WHY NOT `tar` IN A BASH STEP. BIN-4 measured it: `tar` on a Windows runner's bash is Git's
# GNU tar, which reads `C:\Users\...` as a `host:path` remote spec. The win32 asset is a
# `.zip` for that reason and `Expand-Archive` is what opens it.
#
# The tolerated activation refusal is the same one `consumer-smoke.sh` documents at length:
# PX brief §0a.1 makes the gate Studio-only, the tip does not yet, wigolo-studio-run#336.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ReleaseBase,
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$Semver
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:Failures = 0
$script:Deferred = 0
$GateLine = 'wigolo needs an account'

function Pass([string]$id, [string]$what) { Write-Host "  ok   $id — $what" }
function Fail([string]$id, [string]$name, [string]$what) {
  $script:Failures++
  Write-Host "  FAIL $id ($name) broke: $what"
  Write-Host "::error::guarantee $id ($name) broke: $what"
}
function Defer([string]$what) {
  $script:Deferred++
  Write-Host "  gate $what — refused by the activation gate, not run (#336)"
}

# Runs the artifact and hands back exit code plus merged output, without letting a non-zero
# child abort the script the way a native PowerShell error would.
function Invoke-Artifact([string]$exe, [string[]]$cliArgs, [hashtable]$extraEnv = @{}) {
  $saved = @{}
  foreach ($k in $extraEnv.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k)
    [Environment]::SetEnvironmentVariable($k, $extraEnv[$k])
  }
  try {
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    $p = Start-Process -FilePath $exe -ArgumentList $cliArgs -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $text = (Get-Content -Raw -ErrorAction SilentlyContinue $outFile) + (Get-Content -Raw -ErrorAction SilentlyContinue $errFile)
    Remove-Item -Force $outFile, $errFile -ErrorAction SilentlyContinue
    return @{ Code = $p.ExitCode; Text = ($text ?? '') }
  } finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  }
}

$work = Join-Path $env:RUNNER_TEMP "wigolo-smoke-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $work | Out-Null

$asset = "wigolo-$Semver-win32-x64.zip"
Write-Host "`n== consumer smoke: $asset from $ReleaseBase/$Tag =="

# ---------------------------------------------------------------------------
# G4 — verifiable. Download, then check the published digest BEFORE unpacking. The order is
# the guarantee: a smoke that unpacked first and compared afterwards would have run the
# unverified bytes already.
# ---------------------------------------------------------------------------
$zip = Join-Path $work $asset
$sums = Join-Path $work 'SHA256SUMS'
Invoke-WebRequest -Uri "$ReleaseBase/$Tag/SHA256SUMS" -OutFile $sums
Invoke-WebRequest -Uri "$ReleaseBase/$Tag/$asset" -OutFile $zip

$line = Get-Content $sums | Where-Object { ($_ -split '\s+')[1] -eq $asset } | Select-Object -First 1
if (-not $line) {
  Fail 'G4' 'verifiable' "SHA256SUMS for $Tag has no entry for $asset"
} else {
  $expected = ($line -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
  if ($actual -ne $expected.ToLowerInvariant()) {
    Fail 'G4' 'verifiable' "checksum mismatch: published $expected, downloaded $actual"
    Write-Host "refusing to unpack unverified bytes"
    exit 1
  }
  Pass 'G4' "SHA256SUMS matches the downloaded asset ($expected)"
}

Expand-Archive -Path $zip -DestinationPath (Join-Path $work 'unpack') -Force
$root = Join-Path $work 'unpack\wigolo'
$exe = Join-Path $root 'bin\wigolo.exe'
if (-not (Test-Path $exe)) {
  Fail 'G4' 'verifiable' "$asset does not contain bin\wigolo.exe"
  exit 1
}

# §4 G5's other half: the VERSION file inside the archive names the version it was
# published as. install.sh asserts this on the unix legs; nothing else would here.
$versionFile = Join-Path $root 'VERSION'
$declared = (Get-Content $versionFile | Where-Object { $_ -like 'semver=*' } | Select-Object -First 1) -replace '^semver=', ''
if ($declared -ne $Semver) {
  Fail 'G5' 'versioned' "the archive's VERSION says '$declared', it was published as $Semver"
} else {
  Pass 'G5' "the archive's VERSION agrees with the release ($declared)"
}

# ---------------------------------------------------------------------------
# G5 — the executable's own answer.
# ---------------------------------------------------------------------------
$r = Invoke-Artifact $exe @('--version')
if ($r.Code -ne 0) {
  Fail 'G5' 'versioned' "``wigolo --version`` exited $($r.Code): $($r.Text)"
} elseif ($r.Text.Trim() -ne $Semver) {
  Fail 'G5' 'versioned' "``wigolo --version`` says '$($r.Text.Trim())', the release published $Semver"
} else {
  Pass 'G5' "--version says $Semver"
}

# ---------------------------------------------------------------------------
# G1 — relocatable, including a path with a space in it.
# ---------------------------------------------------------------------------
$reloc = Join-Path $work 'a moved\place'
New-Item -ItemType Directory -Force -Path $reloc | Out-Null
Copy-Item -Recurse -Force $root (Join-Path $reloc 'wigolo')
$relocExe = Join-Path $reloc 'wigolo\bin\wigolo.exe'
$r = Invoke-Artifact $relocExe @('--version')
if ($r.Code -ne 0) {
  Fail 'G1' 'relocatable' "the relocated copy would not start: $($r.Text)"
} elseif ($r.Text.Trim() -ne $Semver) {
  Fail 'G1' 'relocatable' "the relocated copy says '$($r.Text.Trim())', not $Semver"
} else {
  Pass 'G1' 'runs from a relocated copy under a path with a space'
}

# ---------------------------------------------------------------------------
# The run surface — MCP stdio. `initialize` then `tools/list`, reading each reply before
# sending the next so the server is never racing an EOF.
# ---------------------------------------------------------------------------
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $exe
$psi.Arguments = 'mcp'
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.EnvironmentVariables['WIGOLO_DATA_DIR'] = (Join-Path $work 'data-mcp')
$proc = [System.Diagnostics.Process]::Start($psi)
$lines = New-Object System.Collections.Generic.List[string]
try {
  $proc.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"consumer-smoke","version":"0"}}}')
  $proc.StandardInput.Flush()
  $readTask = $proc.StandardOutput.ReadLineAsync()
  if ($readTask.Wait(60000)) { $lines.Add($readTask.Result) }
  $proc.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
  $proc.StandardInput.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
  $proc.StandardInput.Flush()
  $readTask = $proc.StandardOutput.ReadLineAsync()
  if ($readTask.Wait(60000)) { $lines.Add($readTask.Result) }
} finally {
  $proc.StandardInput.Close()
  if (-not $proc.WaitForExit(15000)) { $proc.Kill() }
}

$joined = ($lines | Where-Object { $_ }) -join "`n"
if ($joined -notmatch '"serverInfo"' -or $joined -notmatch '"tools"') {
  Fail 'RUN' 'MCP stdio' "no handshake; stdout was '$joined'; stderr: $($proc.StandardError.ReadToEnd())"
} elseif (($lines | Where-Object { $_ -and -not $_.StartsWith('{"') }).Count -gt 0) {
  Fail 'RUN' 'MCP stdio' 'stdout carried a line that is not JSON-RPC'
} elseif ($joined -notmatch [regex]::Escape("`"version`":`"$Semver`"")) {
  Fail 'RUN' 'MCP stdio' "serverInfo did not report version $Semver"
} else {
  Pass 'RUN' "MCP handshake answered, stdout byte-clean, serverInfo says $Semver"
}

# ---------------------------------------------------------------------------
# One fetch and one cache op.
# ---------------------------------------------------------------------------
$dataDir = Join-Path $work 'data-ops'
$fetchUrl = if ($env:WIGOLO_SMOKE_FETCH_URL) { $env:WIGOLO_SMOKE_FETCH_URL } else { 'https://example.com' }

$r = Invoke-Artifact $exe @('fetch', $fetchUrl) @{ WIGOLO_DATA_DIR = $dataDir }
if ($r.Code -eq 0 -and $r.Text.Trim().Length -gt 0) {
  Pass 'OPS' "fetch $fetchUrl returned $($r.Text.Length) chars"
} elseif ($r.Text -like "*$GateLine*") {
  Defer 'fetch'
} else {
  Fail 'OPS' 'run surface' "``wigolo fetch $fetchUrl`` failed ($($r.Code)): $($r.Text)"
}

$r = Invoke-Artifact $exe @('cache', 'stats') @{ WIGOLO_DATA_DIR = $dataDir }
if ($r.Code -eq 0) {
  Pass 'OPS' "cache stats answered from the artifact's own database"
} elseif ($r.Text -like "*$GateLine*") {
  Defer 'cache stats'
} else {
  Fail 'OPS' 'run surface' "``wigolo cache stats`` failed ($($r.Code)): $($r.Text)"
}

Write-Host ''
if ($script:Deferred -gt 0) {
  Write-Host "::warning::$($script:Deferred) tool arm(s) were refused by the activation gate rather than run. PX brief §0a.1 makes the gate Studio-only and the core CLI unregistered; the tip does not yet, which is wigolo-studio-run#336."
}
if ($script:Failures -gt 0) {
  Write-Host "$($script:Failures) guarantee(s) broke."
  exit 1
}
Write-Host "consumer smoke green ($($script:Deferred) deferred)."
