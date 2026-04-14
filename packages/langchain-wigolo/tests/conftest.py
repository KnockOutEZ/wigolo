"""Shared test fixtures for langchain-wigolo."""

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

MOCK_INITIALIZED_NOTIFICATION = {
    "jsonrpc": "2.0",
    "method": "notifications/initialized",
}

MOCK_TOOLS_LIST_RESPONSE = {
    "jsonrpc": "2.0",
    "id": 2,
    "result": {
        "tools": [
            {"name": "search", "description": "Search the web", "inputSchema": {"type": "object"}},
            {"name": "fetch", "description": "Fetch a URL", "inputSchema": {"type": "object"}},
            {"name": "crawl", "description": "Crawl a site", "inputSchema": {"type": "object"}},
            {"name": "cache", "description": "Query cache", "inputSchema": {"type": "object"}},
            {"name": "extract", "description": "Extract data", "inputSchema": {"type": "object"}},
        ]
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
                                "title": "Test Result",
                                "url": "https://example.com",
                                "snippet": "A test snippet",
                                "markdown_content": "# Test\nThis is test content.",
                                "relevance_score": 0.95,
                            }
                        ],
                        "query": "test query",
                        "engines_used": ["duckduckgo"],
                        "total_time_ms": 1234,
                    }
                ),
            }
        ],
        "isError": False,
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
                        "markdown": "# Example\nPage content here.",
                        "metadata": {"description": "An example page"},
                        "links": ["https://example.com/page2"],
                        "images": [],
                        "cached": False,
                    }
                ),
            }
        ],
        "isError": False,
    },
}

MOCK_ERROR_RESPONSE = {
    "jsonrpc": "2.0",
    "id": 3,
    "result": {
        "content": [
            {
                "type": "text",
                "text": json.dumps({"error": "No results found", "results": [], "query": "empty", "engines_used": [], "total_time_ms": 0}),
            }
        ],
        "isError": True,
    },
}


def make_mock_process(responses: list[dict[str, Any]]) -> MagicMock:
    """Create a mock subprocess with canned JSON-RPC responses."""
    proc = MagicMock()
    proc.returncode = None
    proc.pid = 12345

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
def mock_search_process():
    """Mock process that returns initialize + search response."""
    return make_mock_process([MOCK_INITIALIZE_RESPONSE, MOCK_SEARCH_RESPONSE])


@pytest.fixture
def mock_fetch_process():
    """Mock process that returns initialize + fetch response."""
    return make_mock_process([MOCK_INITIALIZE_RESPONSE, MOCK_FETCH_RESPONSE])


@pytest.fixture
def mock_error_process():
    """Mock process that returns initialize + error response."""
    return make_mock_process([MOCK_INITIALIZE_RESPONSE, MOCK_ERROR_RESPONSE])
