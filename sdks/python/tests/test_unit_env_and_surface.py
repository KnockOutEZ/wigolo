"""Env precedence, surface parity, and signature-drift unit tests."""

from __future__ import annotations

import inspect

import pytest

from wigolo import AsyncClient, Client
from wigolo._manifest import MANIFEST

# Lifecycle helpers are not tool surface.
_LIFECYCLE = {"close", "aclose"}
# SDK-local kwargs that must never leak into the manifest.
_SDK_LOCAL = {"timeout"}


def _public_methods(cls) -> set[str]:
    return {
        n
        for n in dir(cls)
        if not n.startswith("_") and callable(getattr(cls, n)) and n not in _LIFECYCLE
    }


def test_surface_parity_identical():
    assert _public_methods(Client) == _public_methods(AsyncClient)


def test_all_tools_present():
    methods = _public_methods(Client)
    for tool in MANIFEST:
        assert tool in methods


@pytest.mark.parametrize("cls", [Client, AsyncClient])
def test_signature_drift(cls):
    for tool, spec in MANIFEST.items():
        sig = inspect.signature(getattr(cls, tool))
        kw = [p for p in sig.parameters if p != "self"]
        kw = [p for p in kw if p not in _SDK_LOCAL]
        assert kw == spec["params"], f"{cls.__name__}.{tool}: {kw} != {spec['params']}"


def test_sdk_local_kwargs_never_in_manifest():
    for tool, spec in MANIFEST.items():
        for local_kw in _SDK_LOCAL:
            assert local_kw not in spec["params"], tool


def test_base_url_explicit_beats_env(monkeypatch):
    monkeypatch.setenv("WIGOLO_BASE_URL", "http://from-env:9999")
    c = Client(base_url="http://explicit:1234")
    assert c._base_url == "http://explicit:1234"


def test_base_url_env_used_when_no_arg(monkeypatch):
    monkeypatch.setenv("WIGOLO_BASE_URL", "http://from-env:9999")
    c = Client()
    assert c._base_url == "http://from-env:9999"


def test_base_url_default_when_nothing():
    c = Client()
    assert c._base_url == "http://127.0.0.1:3333"


def test_token_explicit_beats_env(monkeypatch):
    monkeypatch.setenv("WIGOLO_API_TOKEN", "env-tok")
    c = Client(token="explicit-tok")
    assert c._token == "explicit-tok"


def test_token_env_not_read_when_arg_given(monkeypatch):
    # Explicit empty-string token is still explicit; but None means read env.
    monkeypatch.setenv("WIGOLO_API_TOKEN", "env-tok")
    c = Client(token="")
    # Empty string is falsy -> no auth header, and env not consulted.
    assert c._token in (None, "")
    assert not c._token


def test_token_env_used_when_no_arg(monkeypatch):
    monkeypatch.setenv("WIGOLO_API_TOKEN", "env-tok")
    c = Client()
    assert c._token == "env-tok"


def test_wigolo_local_env_triggers_embedded(monkeypatch):
    calls = {}

    def fake_ensure(**kwargs):
        calls.update(kwargs)

        class D:
            base_url = "http://127.0.0.1:3333"

            def close(self):
                pass

        return D()

    monkeypatch.setenv("WIGOLO_LOCAL", "1")
    monkeypatch.setattr("wigolo._local.ensure_local_daemon", fake_ensure)
    c = Client()
    assert c._local is True
    assert calls  # ensure_local_daemon was called


def test_local_false_explicit_disables_even_with_env(monkeypatch):
    monkeypatch.setenv("WIGOLO_LOCAL", "1")
    # Should NOT go embedded because local=False is explicit.
    c = Client(local=False, base_url="http://x:1")
    assert c._local is False


def test_local_mode_ignores_base_url(monkeypatch):
    def fake_ensure(**kwargs):
        class D:
            base_url = "http://127.0.0.1:5555"

            def close(self):
                pass

        return D()

    monkeypatch.setattr("wigolo._local.ensure_local_daemon", fake_ensure)
    c = Client(local=True, base_url="http://ignored:1")
    assert c._base_url == "http://127.0.0.1:5555"
