"""Root conftest: put the src-layout package on sys.path for tests.

This lets ``pytest sdks/python/tests`` import ``wigolo`` without an editable
install and without an ambient PYTHONPATH.
"""

import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))
