"""MCP subprocess client for communicating with wigolo."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


class WigoloClientError(Exception):
    """Raised when the MCP client encounters an error."""


class WigoloMcpClient:
    """Async MCP client that communicates with wigolo via subprocess stdio.

    Spawns `npx @staticn0va/wigolo` as a child process, sends JSON-RPC 2.0
    requests over stdin, and reads responses from stdout.
    """

    def __init__(
        self,
        command: str = "npx",
        args: Optional[list[str]] = None,
        timeout: float = 30.0,
        env: Optional[dict[str, str]] = None,
    ) -> None:
        self.command = command
        self.args = args or ["@staticn0va/wigolo"]
        self.timeout = timeout
        self.env = env
        self._process: Optional[asyncio.subprocess.Process] = None
        self._request_id = 0
        self._connected = False

    @property
    def is_connected(self) -> bool:
        return self._connected and self._process is not None

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    async def connect(self) -> None:
        """Spawn wigolo subprocess and perform MCP initialize handshake."""
        if self._connected:
            return

        try:
            self._process = await asyncio.create_subprocess_exec(
                self.command,
                *self.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self.env,
            )
        except FileNotFoundError as exc:
            raise WigoloClientError(f"command not found: {self.command}") from exc
        except OSError as exc:
            raise WigoloClientError(f"failed to spawn subprocess: {exc}") from exc

        self._stderr_task = asyncio.create_task(self._read_stderr())

        try:
            init_response = await self._send_request(
                "initialize",
                {
                    "protocolVersion": "2025-03-26",
                    "clientInfo": {"name": "llama-index-readers-wigolo", "version": "0.1.0"},
                    "capabilities": {},
                },
            )
            logger.debug("MCP initialized: %s", init_response)
            await self._send_notification("notifications/initialized", {})
            self._connected = True
        except asyncio.TimeoutError as exc:
            await self._kill_process()
            raise WigoloClientError("timeout waiting for MCP initialize response") from exc
        except Exception as exc:
            await self._kill_process()
            raise WigoloClientError(f"failed to connect: {exc}") from exc

    async def disconnect(self) -> None:
        """Terminate the subprocess."""
        if self._process is None:
            return

        self._connected = False
        try:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                logger.warning("subprocess did not exit gracefully, killing")
                self._process.kill()
                await self._process.wait()
        except ProcessLookupError:
            pass
        except Exception as exc:
            logger.warning("error during disconnect: %s", exc)
        finally:
            self._process = None
            if hasattr(self, "_stderr_task"):
                self._stderr_task.cancel()

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Send a tools/call request and return the parsed result."""
        if not self.is_connected:
            raise WigoloClientError("not connected — call connect() first")

        try:
            response = await self._send_request(
                "tools/call",
                {"name": name, "arguments": arguments},
            )
        except asyncio.TimeoutError as exc:
            raise WigoloClientError(f"timeout calling tool '{name}'") from exc
        except Exception as exc:
            raise WigoloClientError(f"error calling tool '{name}': {exc}") from exc

        return self._parse_tool_response(response)

    async def _send_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Send JSON-RPC request and wait for response."""
        assert self._process is not None
        assert self._process.stdin is not None
        assert self._process.stdout is not None

        req_id = self._next_id()
        request = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}

        msg = json.dumps(request) + "\n"
        self._process.stdin.write(msg.encode())
        await self._process.stdin.drain()

        response = await asyncio.wait_for(self._read_response(), timeout=self.timeout)

        if "error" in response and response["error"] is not None:
            err = response["error"]
            raise WigoloClientError(
                f"MCP error {err.get('code', 'unknown')}: {err.get('message', 'unknown')}"
            )

        return response.get("result", {})

    async def _send_notification(self, method: str, params: dict[str, Any]) -> None:
        """Send JSON-RPC notification (no response expected)."""
        assert self._process is not None
        assert self._process.stdin is not None

        notification = {"jsonrpc": "2.0", "method": method, "params": params}
        msg = json.dumps(notification) + "\n"
        self._process.stdin.write(msg.encode())
        await self._process.stdin.drain()

    async def _read_response(self) -> dict[str, Any]:
        """Read a single JSON-RPC response from stdout."""
        assert self._process is not None
        assert self._process.stdout is not None

        while True:
            line = await self._process.stdout.readline()
            if not line:
                raise WigoloClientError("subprocess stdout closed unexpectedly")

            text = line.decode().strip()
            if not text:
                continue

            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue

            if "id" not in msg:
                continue

            return msg

    async def _read_stderr(self) -> None:
        """Consume stderr and log."""
        assert self._process is not None
        assert self._process.stderr is not None
        try:
            while True:
                line = await self._process.stderr.readline()
                if not line:
                    break
                logger.debug("wigolo stderr: %s", line.decode().strip())
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.debug("stderr reader error: %s", exc)

    async def _kill_process(self) -> None:
        """Force-kill subprocess."""
        if self._process is not None:
            try:
                self._process.kill()
                await self._process.wait()
            except ProcessLookupError:
                pass
            self._process = None

    @staticmethod
    def _parse_tool_response(result: dict[str, Any]) -> dict[str, Any]:
        """Parse MCP tool response content into dict."""
        content = result.get("content", [])
        if not content:
            return {}
        for block in content:
            if block.get("type") == "text":
                text = block.get("text", "")
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return {"raw_text": text}
        return {}

    async def __aenter__(self) -> WigoloMcpClient:
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.disconnect()
