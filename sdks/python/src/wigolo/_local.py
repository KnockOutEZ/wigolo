"""Embedded local-daemon management.

``ensure_local_daemon`` probes a local port and, if nothing usable is
listening, spawns a local wigolo server and waits for it to become
healthy. It returns a ``LocalDaemon`` handle whose ``close()`` stops the
daemon only if this process owns it.

Zero runtime dependencies: stdlib only.
"""

from __future__ import annotations

import atexit
import collections
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Optional

from ._errors import WigoloError

__all__ = ["LocalDaemon", "ensure_local_daemon", "local_client"]

_DEFAULT_LOCAL_PORT = 3333
_HEALTH_PROBE_TIMEOUT = 1.0
_SPAWN_HEALTH_BUDGET_S = 20.0
_SPAWN_POLL_INTERVAL_S = 0.25
_STDERR_RING_LINES = 20
_CLOSE_TERM_WAIT_S = 5.0


class _HealthResult:
    __slots__ = ("status_code",)

    def __init__(self, status_code: Optional[int]) -> None:
        self.status_code = status_code


def _probe_health(base_url: str, timeout: float = _HEALTH_PROBE_TIMEOUT) -> _HealthResult:
    """GET /health. Returns the HTTP status code, or None if refused/unreachable."""
    req = urllib.request.Request(f"{base_url}/health", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return _HealthResult(resp.getcode())
    except urllib.error.HTTPError as exc:
        return _HealthResult(exc.code)
    except (urllib.error.URLError, ConnectionError, OSError):
        return _HealthResult(None)


def _probe_tools(base_url: str, token: Optional[str], timeout: float = _HEALTH_PROBE_TIMEOUT) -> _HealthResult:
    """GET /v1/tools with the resolved token. Returns the HTTP status code."""
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{base_url}/v1/tools", method="GET", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()
            return _HealthResult(resp.getcode())
    except urllib.error.HTTPError as exc:
        return _HealthResult(exc.code)
    except (urllib.error.URLError, ConnectionError, OSError):
        return _HealthResult(None)


def _resolve_command() -> list[str]:
    """Resolve the argv list to launch a wigolo server.

    Precedence: env ``WIGOLO_CLI`` (JSON list, or a single whole-string
    executable path) > ``shutil.which('wigolo')``. The returned list is the
    executable prefix WITHOUT the ``serve ...`` args appended.
    """
    raw = os.environ.get("WIGOLO_CLI")
    if raw:
        stripped = raw.strip()
        if stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise WigoloError(
                    f"WIGOLO_CLI looks like a JSON list but did not parse: {exc}"
                ) from exc
            if not isinstance(parsed, list) or not all(isinstance(x, str) for x in parsed):
                raise WigoloError("WIGOLO_CLI JSON must be a list of strings")
            return parsed
        # Not JSON: the WHOLE string is one executable path (may contain spaces).
        return [raw]

    which = shutil.which("wigolo")
    if which:
        return [which]

    raise WigoloError(
        "wigolo CLI not found — install a REST-capable wigolo (this SDK needs the "
        "REST API, newer than 0.1.43-beta.2) or set WIGOLO_CLI to the executable "
        "path (or a JSON argv list)."
    )


def _is_windows() -> bool:
    return sys.platform == "win32"


def _needs_cmd_wrapper(exe: str) -> bool:
    if not _is_windows():
        return False
    lower = exe.lower()
    return lower.endswith((".cmd", ".bat", ".ps1"))


class LocalDaemon:
    """Handle to a local wigolo daemon (spawned or reused)."""

    def __init__(
        self,
        base_url: str,
        *,
        owned: bool,
        process: Optional[subprocess.Popen] = None,
        stderr_ring: Optional[collections.deque] = None,
    ) -> None:
        self.base_url = base_url
        self.owned = owned
        self._process = process
        self._stderr_ring = stderr_ring
        self._closed = False
        if owned and process is not None:
            atexit.register(self._atexit_close)

    def _atexit_close(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def stderr_tail(self) -> str:
        if self._stderr_ring is None:
            return ""
        return "".join(self._stderr_ring)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if not self.owned or self._process is None:
            return
        proc = self._process
        if proc.poll() is not None:
            return
        if _is_windows():
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    check=False,
                    capture_output=True,
                )
            except Exception:
                pass
            try:
                proc.wait(timeout=_CLOSE_TERM_WAIT_S)
            except Exception:
                pass
            return
        # POSIX: escalate terminate -> kill. Mandatory: server shutdown awaits
        # open connections, so an in-flight long call would otherwise hang.
        try:
            proc.terminate()
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=_CLOSE_TERM_WAIT_S)
            return
        except subprocess.TimeoutExpired:
            pass
        try:
            proc.kill()
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=_CLOSE_TERM_WAIT_S)
        except Exception:
            pass


def _start_stderr_reader(proc: subprocess.Popen) -> collections.deque:
    ring: collections.deque = collections.deque(maxlen=_STDERR_RING_LINES)

    def _reader() -> None:
        assert proc.stderr is not None
        try:
            for line in proc.stderr:
                if isinstance(line, bytes):
                    line = line.decode("utf-8", errors="replace")
                ring.append(line)
        except Exception:
            pass

    t = threading.Thread(target=_reader, daemon=True)
    t.start()
    return ring


def _spawn(command: list[str], port: int, token: Optional[str]) -> subprocess.Popen:
    argv = list(command) + ["serve", "--port", str(port), "--host", "127.0.0.1"]

    child_env = dict(os.environ)
    child_env.pop("WIGOLO_DAEMON_HOST", None)
    child_env.pop("WIGOLO_DAEMON_PORT", None)
    if token:
        child_env["WIGOLO_API_TOKEN"] = token
    else:
        child_env.pop("WIGOLO_API_TOKEN", None)

    popen_kwargs: dict[str, Any] = {
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.PIPE,
        "env": child_env,
        "text": True,
    }

    if _is_windows():
        exe = command[0]
        if _needs_cmd_wrapper(exe):
            # CreateProcess can't exec .cmd/.bat/.ps1 directly.
            argv = ["cmd", "/c"] + argv
        creationflags = 0
        creationflags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)
        popen_kwargs["creationflags"] = creationflags
    else:
        popen_kwargs["shell"] = False

    try:
        return subprocess.Popen(argv, **popen_kwargs)
    except (FileNotFoundError, PermissionError, OSError) as exc:
        raise WigoloError(
            f"wigolo CLI not launchable ({exc}) — install a REST-capable wigolo "
            "(this SDK needs the REST API, newer than 0.1.43-beta.2) or set "
            "WIGOLO_CLI to the executable path (or a JSON argv list)."
        ) from exc


def _wait_for_health(daemon_proc: subprocess.Popen, base_url: str, ring: collections.deque) -> bool:
    """Poll /health until 200 within the spawn budget. Returns True on healthy.

    Returns False (caller decides) if the child exits early or the budget
    elapses.
    """
    deadline = time.monotonic() + _SPAWN_HEALTH_BUDGET_S
    while time.monotonic() < deadline:
        if daemon_proc.poll() is not None:
            return False
        result = _probe_health(base_url)
        if result.status_code == 200:
            return True
        time.sleep(_SPAWN_POLL_INTERVAL_S)
    return False


def ensure_local_daemon(
    *,
    token: Optional[str],
    base_url_override: Optional[str] = None,
    port: Optional[int] = None,
    command: Optional[list[str]] = None,
) -> LocalDaemon:
    """Probe-or-spawn a local wigolo daemon.

    In local mode ``base_url_override`` (from ``WIGOLO_BASE_URL`` or an
    explicit ``base_url`` arg) is IGNORED — the daemon lives at
    ``http://127.0.0.1:{port}``.
    """
    resolved_port = (
        port
        if port is not None
        else int(os.environ.get("WIGOLO_LOCAL_PORT") or _DEFAULT_LOCAL_PORT)
    )
    base_url = f"http://127.0.0.1:{resolved_port}"

    # Step 2: probe existing daemon.
    health = _probe_health(base_url)
    if health.status_code == 200:
        return _adopt_or_reject(base_url, resolved_port, token)
    # 503-down is NOT reusable; any non-200 that still answered means something
    # is listening but not a healthy reusable daemon — but per contract only a
    # refused connection triggers spawn. A 503 health means a daemon exists but
    # is unhealthy: fall through to reuse-check via tools probe is NOT allowed
    # (503 not reusable). We treat non-200-but-answered as spawn-blocking only
    # when the port is truly refused. Here status_code is not None => something
    # answered health but not 200 -> not reusable, and spawning would collide.
    if health.status_code is not None:
        raise WigoloError(
            f"a server on port {resolved_port} reports unhealthy (/health "
            f"{health.status_code}) and is not reusable — wait for it to recover "
            f"or set WIGOLO_LOCAL_PORT to another port."
        )

    # Step 3: connection refused -> spawn.
    cmd = command if command is not None else _resolve_command()
    proc = _spawn(cmd, resolved_port, token)
    ring = _start_stderr_reader(proc)

    healthy = _wait_for_health(proc, base_url, ring)
    if healthy:
        # Step 5 sanity: our child came up healthy. But a spawn race could mean
        # ANOTHER process won the port and our child bind-errored then exited —
        # _wait_for_health returns False in that case, so healthy here means our
        # child is the healthy one OR someone else is and our child is still up.
        # Verify capability before returning ownership.
        return LocalDaemon(base_url, owned=True, process=proc, stderr_ring=ring)

    # Not healthy: child may have early-exited (possibly bind error because a
    # winner raced us) or the budget elapsed.
    if proc.poll() is not None:
        # Child exited. Re-probe: a racing winner may be healthy.
        reprobe = _probe_health(base_url)
        if reprobe.status_code == 200:
            # Downgrade to reuse. Our child is already reaped (poll() != None).
            return _adopt_or_reject(base_url, resolved_port, token)
        tail = "".join(ring)
        raise WigoloError(
            f"local wigolo daemon exited before becoming healthy on port "
            f"{resolved_port}. Try running `wigolo serve` manually to see the "
            f"error.\n--- server stderr (last {_STDERR_RING_LINES} lines) ---\n{tail}"
        )

    # Budget elapsed with child still running but never healthy: kill + raise.
    tail = "".join(ring)
    daemon = LocalDaemon(base_url, owned=True, process=proc, stderr_ring=ring)
    daemon.close()
    raise WigoloError(
        f"local wigolo daemon did not become healthy within "
        f"{int(_SPAWN_HEALTH_BUDGET_S)}s on port {resolved_port}. Try running "
        f"`wigolo serve` manually to see the error.\n"
        f"--- server stderr (last {_STDERR_RING_LINES} lines) ---\n{tail}"
    )


def _adopt_or_reject(base_url: str, port: int, token: Optional[str]) -> LocalDaemon:
    """Given a health-200 daemon, decide whether it is a reusable wigolo.

    Capability probe GET /v1/tools with the resolved token:
      200 -> reuse (owned=False)
      401 -> never adopt (token mismatch / required)
      404 -> predates the REST API
      other/unparseable -> non-wigolo shape
    """
    tools = _probe_tools(base_url, token)
    code = tools.status_code
    if code == 200:
        return LocalDaemon(base_url, owned=False)
    if code == 401:
        raise WigoloError(
            f"a daemon on port {port} requires a bearer token this client doesn't "
            f"have (or the token mismatches) — set WIGOLO_API_TOKEN to match or pick "
            f"another WIGOLO_LOCAL_PORT."
        )
    if code == 404:
        raise WigoloError(
            f"a daemon on port {port} predates the REST API — upgrade the server or "
            f"set WIGOLO_LOCAL_PORT to another port."
        )
    raise WigoloError(
        f"the server on port {port} does not look like a REST-capable wigolo daemon "
        f"(/v1/tools returned {code}) — set WIGOLO_LOCAL_PORT to another port."
    )


def local_client(**opts: Any):
    """Construct a ``Client`` in embedded local mode.

    Accepts the same options as ``Client`` (base_url is ignored in local
    mode). Convenience wrapper for ``Client(local=True, ...)``.
    """
    from ._client import Client

    opts.pop("local", None)
    return Client(local=True, **opts)
