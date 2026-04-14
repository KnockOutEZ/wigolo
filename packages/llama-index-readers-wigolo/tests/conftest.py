"""Shared test fixtures for llama-index-readers-wigolo."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest


MOCK_INITIALIZE_RESPONSE = {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
        "protocolVersion": "2025-03-26",
        "serverInfo": {"name": "wigolo", "version": "0.4.0"},
        "capabilities": {"tools": {}},
    },
}

MOCK_FETCH_RESPONSE = {
    "jsonrpc": "2.0",
    "id": 3,
    "result": {
        "content": [
            {
                "type": "text",
                "text": json.dumps(
                    {
                        "url": "https://example.com",
                        "title": "Example Page",
                        "markdown": "# Example\nThis is example content with useful information.",
                        "metadata": {"description": "An example page", "author": "Test Author"},
                        "links": ["https://example.com/page2"],
                        "images": ["https://example.com/img.png"],
                        "cached": False,
                    }
                ),
            }
        ],
        "isError": False,
    },
}

MOCK_SEARCH_RESPONSE = {
    "jsonrpc": "2.0",
    "id": 3,
    "result": {
        "content": [
            {
                "type": "text",
                "text": json.dumps(
                    {
                        "results": [
                            {
                                "title": "Search Result 1",
                                "url": "https://example.com/result1",
                                "snippet": "First result snippet",
                                "markdown_content": "# Result 1\nDetailed content from first result.",
                                "relevance_score": 0.95,
                            },
                            {
                                "title": "Search Result 2",
                                "url": "https://example.com/result2",
                                "snippet": "Second result snippet",
                                "markdown_content": "# Result 2\nDetailed content from second result.",
                                "relevance_score": 0.85,
                            },
                        ],
                        "query": "test query",
                        "engines_used": ["duckduckgo"],
                        "total_time_ms": 750,
                    }
                ),
            }
        ],
        "isError": False,
    },
}

MOCK_FETCH_ERROR_RESPONSE = {
    "jsonrpc": "2.0",
    "id": 3,
    "result": {
        "content": [
            {
                "type": "text",
                "text": json.dumps(
                    {
                        "url": "https://bad.example.com",
                        "title": "",
                        "markdown": "",
                        "metadata": {},
                        "links": [],
                        "images": [],
                        "cached": False,
                        "error": "Connection refused",
                    }
                ),
            }
        ],
        "isError": True,
    },
}


def make_mock_process(responses: list[dict[str, Any]]) -> MagicMock:
    """Create a mock subprocess with canned JSON-RPC responses."""
    proc = MagicMock()
    proc.returncode = None
    proc.pid = 99999

    response_lines = [json.dumps(r) + "\n" for r in responses]
    read_index = {"i": 0}

    async def mock_readline() -> bytes:
        idx = read_index["i"]
        if idx < len(response_lines):
            read_index["i"] += 1
            return response_lines[idx].encode()
        return b""

    proc.stdout = MagicMock()
    proc.stdout.readline = mock_readline

    proc.stdin = MagicMock()
    proc.stdin.write = MagicMock()
    proc.stdin.drain = AsyncMock()

    proc.stderr = MagicMock()
    proc.stderr.readline = AsyncMock(return_value=b"")

    proc.wait = AsyncMock(return_value=0)
    proc.terminate = MagicMock()
    proc.kill = MagicMock()

    return proc


@pytest.fixture
def mock_fetch_process():
    return make_mock_process([MOCK_INITIALIZE_RESPONSE, MOCK_FETCH_RESPONSE])


@pytest.fixture
def mock_search_process():
    return make_mock_process([MOCK_INITIALIZE_RESPONSE, MOCK_SEARCH_RESPONSE])


@pytest.fixture
def mock_error_process():
    return make_mock_process([MOCK_INITIALIZE_RESPONSE, MOCK_FETCH_ERROR_RESPONSE])
