"""LlamaIndex reader for wigolo — local-first web search MCP server."""

from llama_index_readers_wigolo.client import WigoloMcpClient
from llama_index_readers_wigolo.reader import WigoloSearchReader, WigoloWebReader

__all__ = [
    "WigoloMcpClient",
    "WigoloWebReader",
    "WigoloSearchReader",
]
