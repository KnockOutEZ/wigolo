"""Shared pytest fixtures and helpers.

Hygiene: every test starts with all ambient ``WIGOLO_*`` env scrubbed so
that env-precedence tests are deterministic and spawned serves get a clean,
controlled environment.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterator, Optional

import pytest

REPO_SDK_DIR = Path(__file__).resolve().parent.parent  # sdks/python
WORKTREE_ROOT = REPO_SDK_DIR.parent.parent  # repo root
DIST_INDEX = WORKTREE_ROOT / "dist" / "index.js"


def free_port() -> int:
    """Bind to port 0, read the assigned port, release it, return it."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _scrub_wigolo_env() -> None:
    for key in list(os.environ):
        if key.startswith("WIGOLO_"):
            del os.environ[key]


@pytest.fixture(autouse=True)
def scrub_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Scrub all ambient WIGOLO_* env before each test."""
    for key in list(os.environ):
        if key.startswith("WIGOLO_"):
            monkeypatch.delenv(key, raising=False)
    yield


@pytest.fixture(scope="session")
def shared_data_dir() -> Iterator[str]:
    """One fresh tmp WIGOLO_DATA_DIR per suite RUN, shared across spawns.

    Seeds ML model subdirs from ~/.wigolo when present so the first semantic
    call does not re-download models.
    """
    d = tempfile.mkdtemp(prefix="wigolo-sdk-data-")
    home_wigolo = Path.home() / ".wigolo"
    for sub in ("fastembed", "transformers"):
        src = home_wigolo / sub
        if src.is_dir():
            try:
                shutil.copytree(src, Path(d) / sub, dirs_exist_ok=True)
            except Exception:
                pass
    yield d
    shutil.rmtree(d, ignore_errors=True)


def _health_code(base_url: str, timeout: float = 1.0) -> Optional[int]:
    try:
        with urllib.request.urlopen(f"{base_url}/health", timeout=timeout) as resp:
            return resp.getcode()
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception:
        return None


def wait_healthy(base_url: str, budget_s: float = 40.0) -> bool:
    deadline = time.monotonic() + budget_s
    while time.monotonic() < deadline:
        if _health_code(base_url) == 200:
            return True
        time.sleep(0.25)
    return False


class ServeHandle:
    def __init__(self, proc: subprocess.Popen, port: int, token: Optional[str]) -> None:
        self.proc = proc
        self.port = port
        self.token = token
        self.base_url = f"http://127.0.0.1:{port}"

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)


def spawn_serve(
    data_dir: str,
    *,
    token: Optional[str] = None,
    extra_env: Optional[dict[str, str]] = None,
    port: Optional[int] = None,
) -> ServeHandle:
    """Spawn the worktree dist serve with a clean env. Waits for health."""
    if not DIST_INDEX.exists():
        raise RuntimeError(
            f"dist not built at {DIST_INDEX} — run `npm run build` at the repo root."
        )
    p = port if port is not None else free_port()
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        "WIGOLO_DATA_DIR": data_dir,
    }
    if token:
        env["WIGOLO_API_TOKEN"] = token
    if extra_env:
        env.update(extra_env)
    proc = subprocess.Popen(
        ["node", str(DIST_INDEX), "serve", "--port", str(p), "--host", "127.0.0.1"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
    )
    handle = ServeHandle(proc, p, token)
    if not wait_healthy(handle.base_url):
        try:
            err = proc.stderr.read() if proc.stderr else ""
        except Exception:
            err = ""
        handle.stop()
        raise RuntimeError(f"serve did not become healthy on port {p}\nstderr:\n{err}")
    return handle
