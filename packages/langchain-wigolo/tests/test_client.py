"""Unit tests for the MCP subprocess client."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from langchain_wigolo.client import WigoloMcpClient, WigoloClientError
from tests.conftest import (
    MOCK_INITIALIZE_RESPONSE,
    MOCK_SEARCH_RESPONSE,
    MOCK_FETCH_RESPONSE,
    MOCK_ERROR_RESPONSE,
    make_mock_process,
)


class TestWigoloMcpClientInit:
    """Test client initialization and configuration."""

    def test_default_command(self):
        client = WigoloMcpClient()
        assert client.command == "npx"
        assert client.args == ["@staticn0va/wigolo"]

    def test_custom_command(self):
        client = WigoloMcpClient(command="node", args=["./dist/index.js"])
        assert client.command == "node"
        assert client.args == ["./dist/index.js"]

    def test_custom_timeout(self):
        client = WigoloMcpClient(timeout=60.0)
        assert client.timeout == 60.0

    def test_default_timeout_is_30(self):
        client = WigoloMcpClient()
        assert client.timeout == 30.0

    def test_not_connected_initially(self):
        client = WigoloMcpClient()
        assert client.is_connected is False


class TestWigoloMcpClientConnect:
    """Test client connection lifecycle."""

    @pytest.mark.asyncio
    async def test_connect_spawns_subprocess(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            assert client.is_connected is True
            await client.disconnect()

    @pytest.mark.asyncio
    async def test_connect_sends_initialize_request(self):
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
    async def test_disconnect_terminates_subprocess(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            await client.disconnect()
            mock_proc.terminate.assert_called_once()

    @pytest.mark.asyncio
    async def test_disconnect_when_not_connected_is_noop(self):
        client = WigoloMcpClient()
        await client.disconnect()  # Should not raise

    @pytest.mark.asyncio
    async def test_connect_timeout_raises_error(self):
        mock_proc = make_mock_process([])
        mock_proc.stdout.readline = AsyncMock(side_effect=asyncio.TimeoutError)
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient(timeout=0.1)
            with pytest.raises(WigoloClientError, match="timeout|connect"):
                await client.connect()


class TestWigoloMcpClientCallTool:
    """Test tool invocation via JSON-RPC."""

    @pytest.mark.asyncio
    async def test_call_search_tool(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE, MOCK_SEARCH_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            result = await client.call_tool("search", {"query": "test"})
            assert "results" in result
            assert len(result["results"]) == 1
            assert result["results"][0]["title"] == "Test Result"
            await client.disconnect()

    @pytest.mark.asyncio
    async def test_call_fetch_tool(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE, MOCK_FETCH_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            result = await client.call_tool("fetch", {"url": "https://example.com"})
            assert result["title"] == "Example Page"
            assert result["markdown"].startswith("# Example")
            await client.disconnect()

    @pytest.mark.asyncio
    async def test_call_tool_when_not_connected_raises(self):
        client = WigoloMcpClient()
        with pytest.raises(WigoloClientError, match="not connected"):
            await client.call_tool("search", {"query": "test"})

    @pytest.mark.asyncio
    async def test_call_tool_with_error_response(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE, MOCK_ERROR_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            result = await client.call_tool("search", {"query": "empty"})
            assert result.get("error") is not None
            await client.disconnect()

    @pytest.mark.asyncio
    async def test_call_tool_sends_correct_jsonrpc(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE, MOCK_SEARCH_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            await client.call_tool("search", {"query": "test", "max_results": 3})
            write_calls = mock_proc.stdin.write.call_args_list
            tool_calls = []
            for c in write_calls:
                raw = c[0][0] if isinstance(c[0][0], str) else c[0][0].decode()
                if "tools/call" in raw:
                    tool_calls.append(json.loads(raw))
            assert len(tool_calls) >= 1
            call_msg = tool_calls[0]
            assert call_msg["method"] == "tools/call"
            assert call_msg["params"]["name"] == "search"
            assert call_msg["params"]["arguments"]["query"] == "test"
            await client.disconnect()

    @pytest.mark.asyncio
    async def test_call_tool_increments_request_id(self):
        mock_proc = make_mock_process([
            MOCK_INITIALIZE_RESPONSE,
            MOCK_SEARCH_RESPONSE,
            {**MOCK_SEARCH_RESPONSE, "id": 4},
        ])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            await client.connect()
            await client.call_tool("search", {"query": "first"})
            await client.call_tool("search", {"query": "second"})
            write_calls = mock_proc.stdin.write.call_args_list
            ids = set()
            for c in write_calls:
                raw = c[0][0] if isinstance(c[0][0], str) else c[0][0].decode()
                msg = json.loads(raw)
                if "id" in msg:
                    ids.add(msg["id"])
            assert len(ids) >= 3
            await client.disconnect()


class TestWigoloMcpClientContextManager:
    """Test async context manager usage."""

    @pytest.mark.asyncio
    async def test_context_manager_connects_and_disconnects(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            async with client:
                assert client.is_connected is True
            mock_proc.terminate.assert_called_once()

    @pytest.mark.asyncio
    async def test_context_manager_disconnects_on_exception(self):
        mock_proc = make_mock_process([MOCK_INITIALIZE_RESPONSE])
        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            client = WigoloMcpClient()
            with pytest.raises(ValueError):
                async with client:
                    raise ValueError("test error")
            mock_proc.terminate.assert_called_once()
