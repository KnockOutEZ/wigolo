"""Local embedded-mode unit tests using a fake serve command."""

from __future__ import annotations

import json
import socket
import sys
import time
import urllib.request
from pathlib import Path

import pytest

from wigolo import Client, WigoloError
from wigolo._local import _resolve_command, ensure_local_daemon

FAKE = Path(__file__).resolve().parent / "_fake_serve.py"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _fake_cmd() -> list[str]:
    return [sys.executable, str(FAKE)]


def test_wigolo_cli_json_list_parsed(monkeypatch):
    monkeypatch.setenv("WIGOLO_CLI", json.dumps(["/usr/bin/thing", "--flag"]))
    assert _resolve_command() == ["/usr/bin/thing", "--flag"]


def test_wigolo_cli_single_path_with_spaces(monkeypatch):
    monkeypatch.setenv("WIGOLO_CLI", "/opt/my apps/wigolo bin")
    assert _resolve_command() == ["/opt/my apps/wigolo bin"]


def test_wigolo_cli_invalid_json_list_raises(monkeypatch):
    monkeypatch.setenv("WIGOLO_CLI", "[not valid json")
    with pytest.raises(WigoloError):
        _resolve_command()


def test_cli_not_found_actionable(monkeypatch):
    monkeypatch.delenv("WIGOLO_CLI", raising=False)
    monkeypatch.setattr("wigolo._local.shutil.which", lambda name: None)
    with pytest.raises(WigoloError) as ei:
        _resolve_command()
    assert "WIGOLO_CLI" in str(ei.value)


def test_spawn_and_reuse_owned(monkeypatch):
    port = _free_port()
    d = ensure_local_daemon(token=None, port=port, command=_fake_cmd())
    try:
        assert d.owned is True
        assert d.base_url == f"http://127.0.0.1:{port}"
        # It should be healthy.
        with urllib.request.urlopen(f"{d.base_url}/health", timeout=2) as r:
            assert r.getcode() == 200
    finally:
        d.close()
    # After close, port should be free again (child killed) — give it a moment.
    time.sleep(0.5)
    with pytest.raises(Exception):
        urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)


def test_reuse_not_owned(monkeypatch):
    port = _free_port()
    # Pre-start a fake daemon we "own" via the low-level path.
    pre = ensure_local_daemon(token=None, port=port, command=_fake_cmd())
    try:
        # A second ensure on the same port must reuse (owned=False).
        second = ensure_local_daemon(token=None, port=port, command=_fake_cmd())
        assert second.owned is False
        # Closing the not-owned handle must NOT stop the daemon.
        second.close()
        time.sleep(0.3)
        with urllib.request.urlopen(f"{pre.base_url}/health", timeout=2) as r:
            assert r.getcode() == 200
    finally:
        pre.close()


def test_stale_daemon_predates_rest(monkeypatch):
    port = _free_port()
    monkeypatch.setenv("FAKE_TOOLS_STATUS", "404")
    pre = ensure_local_daemon(token=None, port=port, command=_fake_cmd())
    try:
        # ensure sees health 200 but /v1/tools 404 -> predates REST.
        with pytest.raises(WigoloError) as ei:
            ensure_local_daemon(token=None, port=port, command=_fake_cmd())
        assert "predates the REST API" in str(ei.value)
    finally:
        pre.close()


def test_token_mismatch_401_actionable(monkeypatch):
    port = _free_port()
    # Daemon started WITH a token.
    pre = ensure_local_daemon(token="server-tok", port=port, command=_fake_cmd())
    try:
        # Client without the token probes /v1/tools -> 401 -> refuse to adopt.
        with pytest.raises(WigoloError) as ei:
            ensure_local_daemon(token=None, port=port, command=_fake_cmd())
        msg = str(ei.value)
        assert "bearer token" in msg
        assert "WIGOLO_API_TOKEN" in msg or "WIGOLO_LOCAL_PORT" in msg
    finally:
        pre.close()


def test_child_exit_immediately_actionable(monkeypatch):
    port = _free_port()
    monkeypatch.setenv("FAKE_EXIT_IMMEDIATELY", "1")
    with pytest.raises(WigoloError) as ei:
        ensure_local_daemon(token=None, port=port, command=_fake_cmd())
    msg = str(ei.value)
    assert "wigolo serve" in msg
    # stderr ring buffer content surfaced.
    assert "refusing to start" in msg


def test_file_not_found_mapping(monkeypatch):
    port = _free_port()
    with pytest.raises(WigoloError) as ei:
        ensure_local_daemon(
            token=None, port=port, command=["/nonexistent/path/to/wigolo-xyz"]
        )
    assert "WIGOLO_CLI" in str(ei.value)


def test_client_local_true_uses_daemon(monkeypatch):
    port = _free_port()
    c = Client(local=True, port=port, command=_fake_cmd())
    try:
        assert c._base_url == f"http://127.0.0.1:{port}"
        assert c._daemon is not None and c._daemon.owned is True
    finally:
        c.close()
