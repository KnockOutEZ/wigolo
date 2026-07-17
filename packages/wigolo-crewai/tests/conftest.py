"""Shared test fixtures for wigolo-crewai.

The wigolo Python SDK is not installed in this workspace, so we make it
importable from the in-repo source tree. This lets ``import wigolo`` (and the
``WigoloError`` type the core maps) resolve without a system-pip install.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# packages/wigolo-crewai/tests/conftest.py -> repo root is three parents up.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_SDK_SRC = _REPO_ROOT / "sdks" / "python" / "src"
if _SDK_SRC.is_dir():
    sys.path.insert(0, str(_SDK_SRC))

# Make the package itself importable without an editable install.
_PKG_ROOT = Path(__file__).resolve().parents[1]
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))


@pytest.fixture
def mock_client() -> MagicMock:
    """A MagicMock standing in for a wigolo.Client with canned tool results."""
    client = MagicMock()
    client.search.return_value = {
        "results": [
            {"title": "Test", "url": "https://example.com", "relevance_score": 0.9}
        ],
        "query": "test",
        "engines_used": ["duckduckgo"],
        "total_time_ms": 12,
    }
    client.fetch.return_value = {
        "url": "https://example.com",
        "title": "Example",
        "markdown": "# Example\ncontent",
        "cached": False,
    }
    client.research.return_value = {
        "brief": {"topics": ["a"], "highlights": ["h"], "key_findings": ["k"]}
    }
    client.crawl.return_value = {
        "pages": [{"url": "https://example.com/a", "title": "A"}],
        "count": 1,
    }
    client.extract.return_value = {
        "url": "https://example.com",
        "tables": [{"rows": [["x", "y"]]}],
    }
    return client
