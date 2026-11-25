"""Build the wheel and assert PEP 561 marker + expected members ship.

Fails loud if the ``build`` module is unavailable (it is a dev-only
dependency that MUST be installed in the SDK venv — this gate never skips).
"""

from __future__ import annotations

import re
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


def _project_version() -> str:
    text = (SDK_DIR / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^\[project\][^\[]*?^version\s*=\s*"([^"]+)"', text, re.M | re.S)
    assert match, "no [project] version in pyproject.toml"
    return match.group(1)


def test_installed_wheel_reports_its_project_version():
    if not _have_build():
        pytest.fail(
            "the 'build' module is missing from the SDK venv — bootstrap it with "
            "'sdks/python/.venv/bin/pip install pytest build' (this gate must never be skipped)"
        )
    with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as site:
        subprocess.run(
            [sys.executable, "-m", "build", "--wheel", "--outdir", out],
            cwd=str(SDK_DIR),
            check=True,
            capture_output=True,
        )
        wheel = next(Path(out).glob("wigolo-*.whl"))
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--no-deps", "--target", site, str(wheel)],
            check=True,
            capture_output=True,
        )
        # -I keeps the source tree and PYTHONPATH off sys.path: only the
        # installed copy can be imported.
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                "-c",
                "import sys; sys.path.insert(0, sys.argv[1]); import wigolo; print(wigolo.__version__)",
                site,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        assert result.stdout.strip() == _project_version()
