"""Asynchronous wigolo REST client.

Identical public surface to the synchronous ``Client``, but every method
is awaitable. Implementation runs the synchronous request function on a
client-owned bounded thread pool via ``loop.run_in_executor``.

Cancellation caveat: awaiting a call and then cancelling ABANDONS the
in-flight request — the worker thread continues to completion in the
background (there is no portable way to abort a blocking socket op). The
``await`` returns promptly on cancel, but the thread lingers. Concurrency
is bounded by ``max_workers``.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional, Union

from ._client import Client

__all__ = ["AsyncClient"]


class AsyncClient:
    """Async client for the wigolo REST API.

    Wraps a synchronous ``Client`` and dispatches each blocking request to
    a bounded ``ThreadPoolExecutor`` (``max_workers``, default 16).

    Args match ``Client`` (including the local-mode ``port`` / ``command``
    overrides) plus ``max_workers`` for the executor bound.

    Note: when ``local=True`` (or ``WIGOLO_LOCAL=1``), the daemon
    probe-or-spawn runs SYNCHRONOUSLY inside this constructor (it may block
    the calling thread up to ~20s while the daemon becomes healthy). This
    mirrors the synchronous ``Client`` and keeps construction simple; if you
    need it fully off-loop, construct the ``AsyncClient`` in a worker thread.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        timeout: Optional[float] = None,
        local: Optional[bool] = None,
        max_workers: int = 16,
        *,
        port: Optional[int] = None,
        command: Optional[list[str]] = None,
    ) -> None:
        self._client = Client(
            base_url=base_url,
            token=token,
            timeout=timeout,
            local=local,
            port=port,
            command=command,
        )
        self._executor = ThreadPoolExecutor(max_workers=max_workers)

    # ---- lifecycle -------------------------------------------------------

    def close(self) -> None:
        """Synchronously shut down the executor and stop an owned daemon."""
        self._executor.shutdown(wait=True)
        self._client.close()

    async def aclose(self) -> None:
        """Shut down the executor (off the event loop) and stop an owned daemon."""
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._executor.shutdown, True)
        self._client.close()

    async def __aenter__(self) -> "AsyncClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    # ---- dispatch --------------------------------------------------------

    async def _run(self, fn_name: str, /, **kwargs: Any) -> Any:
        loop = asyncio.get_running_loop()
        fn = getattr(self._client, fn_name)

        def _call() -> Any:
            return fn(**kwargs)

        return await loop.run_in_executor(self._executor, _call)

    # ---- meta endpoints --------------------------------------------------

    async def health(self, *, timeout: Optional[float] = None) -> Any:
        """GET /health. The ``searxng`` field is the search-aggregator sidecar status."""
        return await self._run("health", timeout=timeout)

    async def list_tools(self, *, timeout: Optional[float] = None) -> Any:
        """GET /v1/tools (bearer-gated in token mode)."""
        return await self._run("list_tools", timeout=timeout)

    async def openapi(self, *, timeout: Optional[float] = None) -> Any:
        """GET /openapi.json (bearer-gated in token mode)."""
        return await self._run("openapi", timeout=timeout)

    # ---- tools -----------------------------------------------------------

    async def search(
        self,
        *,
        query: Union[str, list[str]],
        max_results: Optional[int] = None,
        max_fetches: Optional[int] = None,
        include_content: Optional[bool] = None,
        content_max_chars: Optional[int] = None,
        max_content_chars: Optional[int] = None,
        max_total_chars: Optional[int] = None,
        time_range: Optional[str] = None,
        exact_match: Optional[bool] = None,
        search_engines: Optional[list[str]] = None,
        language: Optional[str] = None,
        country: Optional[str] = None,
        include_domains: Optional[list[str]] = None,
        exclude_domains: Optional[list[str]] = None,
        from_date: Optional[str] = None,
        to_date: Optional[str] = None,
        category: Optional[str] = None,
        format: Optional[str] = None,
        max_highlights: Optional[int] = None,
        force_refresh: Optional[bool] = None,
        include_favicon: Optional[bool] = None,
        include_images: Optional[bool] = None,
        max_tokens_out: Optional[int] = None,
        include_full_markdown: Optional[bool] = None,
        citation_format: Optional[str] = None,
        mode: Optional[str] = None,
        search_depth: Optional[str] = None,
        agent_context: Optional[Any] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Search the web. Returns scored evidence + citations."""
        return await self._run(
            "search",
            query=query,
            max_results=max_results,
            max_fetches=max_fetches,
            include_content=include_content,
            content_max_chars=content_max_chars,
            max_content_chars=max_content_chars,
            max_total_chars=max_total_chars,
            time_range=time_range,
            exact_match=exact_match,
            search_engines=search_engines,
            language=language,
            country=country,
            include_domains=include_domains,
            exclude_domains=exclude_domains,
            from_date=from_date,
            to_date=to_date,
            category=category,
            format=format,
            max_highlights=max_highlights,
            force_refresh=force_refresh,
            include_favicon=include_favicon,
            include_images=include_images,
            max_tokens_out=max_tokens_out,
            include_full_markdown=include_full_markdown,
            citation_format=citation_format,
            mode=mode,
            search_depth=search_depth,
            agent_context=agent_context,
            timeout=timeout,
        )

    async def fetch(
        self,
        *,
        url: str,
        render_js: Optional[bool] = None,
        use_auth: Optional[bool] = None,
        max_chars: Optional[int] = None,
        max_content_chars: Optional[int] = None,
        section: Optional[str] = None,
        section_index: Optional[int] = None,
        screenshot: Optional[bool] = None,
        headers: Optional[dict[str, str]] = None,
        force_refresh: Optional[bool] = None,
        max_tokens_out: Optional[int] = None,
        include_full_markdown: Optional[bool] = None,
        citation_format: Optional[str] = None,
        actions: Optional[list[Any]] = None,
        mode: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Fetch a single URL and return clean markdown."""
        return await self._run(
            "fetch",
            url=url,
            render_js=render_js,
            use_auth=use_auth,
            max_chars=max_chars,
            max_content_chars=max_content_chars,
            section=section,
            section_index=section_index,
            screenshot=screenshot,
            headers=headers,
            force_refresh=force_refresh,
            max_tokens_out=max_tokens_out,
            include_full_markdown=include_full_markdown,
            citation_format=citation_format,
            actions=actions,
            mode=mode,
            timeout=timeout,
        )

    async def crawl(
        self,
        *,
        url: str,
        max_depth: Optional[int] = None,
        max_pages: Optional[int] = None,
        strategy: Optional[str] = None,
        include_patterns: Optional[list[str]] = None,
        exclude_patterns: Optional[list[str]] = None,
        use_auth: Optional[bool] = None,
        extract_links: Optional[bool] = None,
        max_total_chars: Optional[int] = None,
        max_tokens_out: Optional[int] = None,
        include_full_markdown: Optional[bool] = None,
        citation_format: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Crawl a site from a seed URL. ``strategy='map'`` returns ``urls``."""
        return await self._run(
            "crawl",
            url=url,
            max_depth=max_depth,
            max_pages=max_pages,
            strategy=strategy,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
            use_auth=use_auth,
            extract_links=extract_links,
            max_total_chars=max_total_chars,
            max_tokens_out=max_tokens_out,
            include_full_markdown=include_full_markdown,
            citation_format=citation_format,
            timeout=timeout,
        )

    async def cache(
        self,
        *,
        query: Optional[str] = None,
        url_pattern: Optional[str] = None,
        since: Optional[str] = None,
        clear: Optional[bool] = None,
        stats: Optional[bool] = None,
        check_changes: Optional[bool] = None,
        mode: Optional[str] = None,
        limit: Optional[int] = None,
        max_tokens_out: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Query or manage the local knowledge cache."""
        return await self._run(
            "cache",
            query=query,
            url_pattern=url_pattern,
            since=since,
            clear=clear,
            stats=stats,
            check_changes=check_changes,
            mode=mode,
            limit=limit,
            max_tokens_out=max_tokens_out,
            timeout=timeout,
        )

    async def extract(
        self,
        *,
        url: Optional[str] = None,
        html: Optional[str] = None,
        mode: Optional[str] = None,
        css_selector: Optional[str] = None,
        multiple: Optional[bool] = None,
        schema: Optional[Any] = None,
        named_schema: Optional[str] = None,
        max_tokens_out: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Extract structured data from a URL or raw HTML."""
        return await self._run(
            "extract",
            url=url,
            html=html,
            mode=mode,
            css_selector=css_selector,
            multiple=multiple,
            schema=schema,
            named_schema=named_schema,
            max_tokens_out=max_tokens_out,
            timeout=timeout,
        )

    async def find_similar(
        self,
        *,
        url: Optional[str] = None,
        concept: Optional[str] = None,
        max_results: Optional[int] = None,
        include_domains: Optional[list[str]] = None,
        exclude_domains: Optional[list[str]] = None,
        include_cache: Optional[bool] = None,
        include_web: Optional[bool] = None,
        mode: Optional[str] = None,
        max_tokens_out: Optional[int] = None,
        include_full_markdown: Optional[bool] = None,
        citation_format: Optional[str] = None,
        threshold: Optional[float] = None,
        include_ranking_debug: Optional[bool] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Find pages similar to a URL or concept via hybrid semantic discovery."""
        return await self._run(
            "find_similar",
            url=url,
            concept=concept,
            max_results=max_results,
            include_domains=include_domains,
            exclude_domains=exclude_domains,
            include_cache=include_cache,
            include_web=include_web,
            mode=mode,
            max_tokens_out=max_tokens_out,
            include_full_markdown=include_full_markdown,
            citation_format=citation_format,
            threshold=threshold,
            include_ranking_debug=include_ranking_debug,
            timeout=timeout,
        )

    async def research(
        self,
        *,
        question: str,
        depth: Optional[str] = None,
        max_sources: Optional[int] = None,
        include_domains: Optional[list[str]] = None,
        exclude_domains: Optional[list[str]] = None,
        schema: Optional[Any] = None,
        stream: Optional[bool] = None,
        max_tokens_out: Optional[int] = None,
        include_full_markdown: Optional[bool] = None,
        citation_format: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Multi-step research. ``stream`` has no effect over this transport."""
        return await self._run(
            "research",
            question=question,
            depth=depth,
            max_sources=max_sources,
            include_domains=include_domains,
            exclude_domains=exclude_domains,
            schema=schema,
            stream=stream,
            max_tokens_out=max_tokens_out,
            include_full_markdown=include_full_markdown,
            citation_format=citation_format,
            timeout=timeout,
        )

    async def agent(
        self,
        *,
        prompt: str,
        urls: Optional[list[str]] = None,
        schema: Optional[Any] = None,
        max_pages: Optional[int] = None,
        max_time_ms: Optional[int] = None,
        stream: Optional[bool] = None,
        max_tokens_out: Optional[int] = None,
        include_full_markdown: Optional[bool] = None,
        citation_format: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Autonomous data-gathering agent. ``stream`` has no effect over this transport."""
        return await self._run(
            "agent",
            prompt=prompt,
            urls=urls,
            schema=schema,
            max_pages=max_pages,
            max_time_ms=max_time_ms,
            stream=stream,
            max_tokens_out=max_tokens_out,
            include_full_markdown=include_full_markdown,
            citation_format=citation_format,
            timeout=timeout,
        )

    async def diff(
        self,
        *,
        old: Optional[dict[str, Any]] = None,
        new: Optional[dict[str, Any]] = None,
        output: Optional[str] = None,
        granularity: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Diff two content sources. See ``Client.diff`` for the ``old``/``new`` shapes."""
        return await self._run(
            "diff",
            old=old,
            new=new,
            output=output,
            granularity=granularity,
            timeout=timeout,
        )

    async def watch(
        self,
        *,
        action: str,
        url: Optional[str] = None,
        urls: Optional[list[str]] = None,
        interval_seconds: Optional[int] = None,
        selector: Optional[str] = None,
        notification: Optional[Any] = None,
        job_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Manage change-watch jobs."""
        return await self._run(
            "watch",
            action=action,
            url=url,
            urls=urls,
            interval_seconds=interval_seconds,
            selector=selector,
            notification=notification,
            job_id=job_id,
            timeout=timeout,
        )
