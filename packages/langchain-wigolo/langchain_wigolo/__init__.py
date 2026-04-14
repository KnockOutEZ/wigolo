"""LangChain integration for wigolo — local-first web search MCP server."""

from langchain_wigolo.client import WigoloMcpClient
from langchain_wigolo.retrievers import WigoloSearchRetriever
from langchain_wigolo.tools import WigoloFetchTool, WigoloSearchTool
from langchain_wigolo.types import FetchInput, FetchOutput, SearchInput, SearchOutput

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
