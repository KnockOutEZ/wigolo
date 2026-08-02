"""LangChain integration for wigolo — local-first web search MCP server."""

from wigolo_langchain.client import WigoloMcpClient
from wigolo_langchain.retrievers import WigoloSearchRetriever
from wigolo_langchain.tools import WigoloFetchTool, WigoloSearchTool
from wigolo_langchain.types import FetchInput, FetchOutput, SearchInput, SearchOutput

__all__ = [
    "WigoloMcpClient",
    "WigoloSearchRetriever",
    "WigoloSearchTool",
    "WigoloFetchTool",
    "SearchInput",
    "SearchOutput",
    "FetchInput",
    "FetchOutput",
]
