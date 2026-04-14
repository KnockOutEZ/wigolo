"""Unit tests for the MCP subprocess client."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest

from llama_index_readers_wigolo.client import WigoloMcpClient, WigoloClientError
from tests.conftest import (
    MOCK_INITIALIZE_RESPONSE,
    MOCK_FETCH_RESPONSE,
    MOCK_SEARCH_RESPONSE,
    make_mock_process,
)


class TestClientInit:
    """Test client initialization."""

    def test_default_command(self):
        client = WigoloMcpClient()
        assert client.command == "npx"
        assert client.args == ["@staticn0va/wigolo"]

    def test_custom_command(self):
        client = WigoloMcpClient(command="node", args=["./dist/index.js"])
        assert client.command == "node"
        assert client.args == ["./dist/index.js"]

    def test_default_timeout(self):
        client = WigoloMcpClient()
        assert client.timeout == 30.0

    def test_custom_timeout(self):
        client = WigoloMcpClient(timeout=120.0)
        assert client.timeout == 120.0

    def test_not_connected_initially(self):
        client = WigoloMcpClient()
        assert client.is_connected is False


class TestClientConnect:
    """Test client connection lifecycle."""

    @pytest.mark.asyncio
    async def test_connect_sets_connected(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            assert client.is_connected is True
            await client.disconnect()

    @pytest.mark.asyncio
    async def test_connect_sends_initialize(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            write_calls = mock_proc.stdin.write.call_args_list
            assert len(write_calls) >= 1
            first_msg = json.loads(write_calls[0][0][0])
            assert first_msg["method"] == "initialize"
            await client.disconnect()

    @pytest.mark.asyncio
    async def test_disconnect_terminates_process(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            await client.disconnect()
            mock_proc.terminate.assert_called_once()

    @pytest.mark.asyncio
    async def test_disconnect_noop_when_not_connected(self):
        client = WigoloMcpClient()
        await client.disconnect()

    @pytest.mark.asyncio
    async def test_connect_timeout_raises(self):
        mock_proc = make_mock_process([])
        mock_proc.stdout.readline = AsyncMock(side_effect=asyncio.TimeoutError)
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient(timeout=0.1)
            with pytest.raises(WigoloClientError):
                await client.connect()


class TestClientCallTool:
    """Test tool invocation."""

    @pytest.mark.asyncio
    async def test_call_fetch_tool(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE, MOCK_FETCH_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            result = await client.call_tool("fetch", {"url": "https://example.com"})
            assert result["title"] == "Example Page"
            assert "# Example" in result["markdown"]
            await client.disconnect()

    @pytest.mark.asyncio
    async def test_call_search_tool(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE, MOCK_SEARCH_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            result = await client.call_tool("search", {"query": "test"})
            assert len(result["results"]) == 2
            await client.disconnect()

    @pytest.mark.asyncio
    async def test_call_tool_not_connected_raises(self):
        client = WigoloMcpClient()
        with pytest.raises(WigoloClientError, match="not connected"):
            await client.call_tool("fetch", {"url": "https://example.com"})

    @pytest.mark.asyncio
    async def test_call_tool_increments_ids(self):
        mock_proc = make_mock_process([
            MOCK_INITIALIZE_RESPONSE,
            MOCK_FETCH_RESPONSE,
            {**MOCK_FETCH_RESPONSE, "id": 4},
        ])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            await client.call_tool("fetch", {"url": "https://a.com"})
            await client.call_tool("fetch", {"url": "https://b.com"})
            write_calls = mock_proc.stdin.write.call_args_list
            ids = set()
            for c in write_calls:
                raw = c[0][0] if isinstance(c[0][0], str) else c[0][0].decode()
                msg = json.loads(raw)
                if "id" in msg:
                    ids.add(msg["id"])
            assert len(ids) >= 3
            await client.disconnect()


class TestClientContextManager:
    """Test async context manager."""

    @pytest.mark.asyncio
    async def test_async_with_connects_and_disconnects(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            async with client:
                assert client.is_connected is True
            mock_proc.terminate.assert_called_once()

    @pytest.mark.asyncio
    async def test_async_with_disconnects_on_exception(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            with pytest.raises(RuntimeError):
                async with client:
                    raise RuntimeError("test")
            mock_proc.terminate.assert_called_once()
