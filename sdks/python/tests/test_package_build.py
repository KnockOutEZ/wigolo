"""Build the wheel and assert PEP 561 marker + expected members ship.

Fails loud if the ``build`` module is unavailable (it is a dev-only
dependency that MUST be installed in the SDK venv — this gate never skips).
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import pytest

SDK_DIR = Path(__file__).resolve().parent.parent


def _have_build() -> bool:
    try:
        import build  # noqa: F401

        return True
    except Exception:
        return False


def test_wheel_contains_py_typed_and_modules():
    if not _have_build():
        pytest.fail(
            "the 'build' module is missing from the SDK venv — bootstrap it with "
            "'sdks/python/.venv/bin/pip install pytest build' (this gate must never be skipped)"
        )
    with tempfile.TemporaryDirectory() as out:
        subprocess.run(
            [sys.executable, "-m", "build", "--wheel", "--outdir", out],
            cwd=str(SDK_DIR),
            check=True,
            capture_output=True,
        )
        wheels = list(Path(out).glob("wigolo-*.whl"))
        assert wheels, "no wheel produced"
        with zipfile.ZipFile(wheels[0]) as zf:
            names = set(zf.namelist())
        assert "wigolo/py.typed" in names, f"py.typed missing from wheel: {sorted(names)}"
        for member in (
            "wigolo/__init__.py",
            "wigolo/_client.py",
            "wigolo/_aio.py",
            "wigolo/_local.py",
            "wigolo/_manifest.py",
            "wigolo/_errors.py",
        ):
            assert member in names, f"{member} missing from wheel"
