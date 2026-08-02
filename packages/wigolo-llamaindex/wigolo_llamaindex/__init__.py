"""LlamaIndex reader for wigolo — local-first web search MCP server."""

from wigolo_llamaindex.client import WigoloMcpClient
from wigolo_llamaindex.reader import WigoloSearchReader, WigoloWebReader

__all__ = [
    "WigoloMcpClient",
    "WigoloWebReader",
    "WigoloSearchReader",
]
