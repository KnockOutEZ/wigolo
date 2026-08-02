"""Synchronous wigolo REST client.

Thin transport: one method per tool with typed, keyword-only params that
mirror the REST manifest exactly. No retries, no re-ranking, no
interpretation, no caching — the server does all of that.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import TYPE_CHECKING, Any, Optional, Union

from ._errors import WigoloAPIError, WigoloConnectionError
from ._manifest import MANIFEST

if TYPE_CHECKING:
    from ._local import LocalDaemon

__all__ = ["Client"]

_DEFAULT_BASE_URL = "http://127.0.0.1:3333"

# SDK-local keyword args that must never appear in the manifest param list.
_SDK_LOCAL_KWARGS = frozenset({"timeout"})

# Loopback traffic must never traverse a proxy: it breaks local mode and would
# leak the bearer token through the proxy. This opener ignores http(s)_proxy.
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def _is_loopback(base_url: str) -> bool:
    try:
        host = urllib.parse.urlsplit(base_url).hostname or ""
    except ValueError:
        return False
    return host.lower() in _LOOPBACK_HOSTS


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "") == "1"


class Client:
    """Synchronous client for the wigolo REST API.

    Args:
        base_url: Server base URL. Falls back to ``WIGOLO_BASE_URL`` then
            ``http://127.0.0.1:3333``. Ignored in local mode.
        token: Bearer token. Falls back to ``WIGOLO_API_TOKEN``. Only sent
            when set (the server requires it only when it runs with a token).
        timeout: Default per-request timeout in seconds. This is a
            per-socket-operation (connect / read-inactivity) timeout, NOT a
            total wall-clock deadline. When unset, each method uses its
            manifest default. Override per call with the ``timeout`` kwarg.
        local: When True (or env ``WIGOLO_LOCAL=1`` while ``local`` is left
            at its default), route through an embedded local daemon that is
            probed-or-spawned for you. In local mode ``WIGOLO_BASE_URL`` is
            ignored and the base URL points at the local daemon.

    Note on ``local`` precedence: the ``WIGOLO_LOCAL`` env var only triggers
    embedded mode when the ``local`` argument is left at its default. Passing
    ``local=False`` explicitly disables embedded mode regardless of env.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        timeout: Optional[float] = None,
        local: Optional[bool] = None,
        *,
        port: Optional[int] = None,
        command: Optional[list[str]] = None,
    ) -> None:
        # Resolve local mode. Explicit local arg wins; env only when default.
        if local is None:
            use_local = _env_flag("WIGOLO_LOCAL")
        else:
            use_local = bool(local)

        # Token: explicit arg > env. Env not read when arg is explicit.
        if token is not None:
            resolved_token: Optional[str] = token
        else:
            resolved_token = os.environ.get("WIGOLO_API_TOKEN") or None

        self._timeout = timeout
        self._token = resolved_token
        self._local = use_local
        self._daemon: Optional["LocalDaemon"] = None  # set in local mode

        if use_local:
            # Lazy import to avoid a subprocess module at top level.
            from ._local import ensure_local_daemon

            self._daemon = ensure_local_daemon(
                token=resolved_token,
                base_url_override=base_url,
                port=port,
                command=command,
            )
            self._base_url = self._daemon.base_url
        else:
            # Base URL: explicit arg > env > default. Env not read when explicit.
            if base_url is not None:
                self._base_url = base_url
            else:
                self._base_url = os.environ.get("WIGOLO_BASE_URL") or _DEFAULT_BASE_URL

        self._base_url = self._base_url.rstrip("/")
        # Loopback targets bypass any ambient proxy (see _NO_PROXY_OPENER); the
        # default opener (which honors http(s)_proxy) is used otherwise.
        self._urlopen = (
            _NO_PROXY_OPENER.open if _is_loopback(self._base_url) else urllib.request.urlopen
        )

    # ---- lifecycle -------------------------------------------------------

    def close(self) -> None:
        """Release resources. In local mode, stops an owned daemon."""
        if self._daemon is not None:
            self._daemon.close()
            self._daemon = None

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---- transport -------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    def _resolve_timeout(self, tool: str, per_call: Optional[float]) -> float:
        if per_call is not None:
            return per_call
        if self._timeout is not None:
            return self._timeout
        return float(MANIFEST[tool]["default_timeout_s"])

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        url = f"{self._base_url}{path}"
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, method=method, headers=self._headers()
        )
        effective_timeout = timeout if timeout is not None else (
            self._timeout if self._timeout is not None else 60.0
        )
        try:
            with self._urlopen(req, timeout=effective_timeout) as resp:
                raw = resp.read()
                return self._parse_ok(raw, url)
        except urllib.error.HTTPError as exc:
            raise self._api_error_from_http(exc) from None
        except urllib.error.URLError as exc:
            raise WigoloConnectionError(
                f"could not connect to wigolo at {self._base_url} ({exc.reason}). "
                "For zero-setup local use, call wigolo.local_client() which starts "
                "a local daemon for you."
            ) from exc
        except (ConnectionError, OSError) as exc:
            raise WigoloConnectionError(
                f"could not connect to wigolo at {self._base_url} ({exc}). "
                "For zero-setup local use, call wigolo.local_client() which starts "
                "a local daemon for you."
            ) from exc

    @staticmethod
    def _parse_ok(raw: bytes, url: str) -> Any:
        # 2xx bodies are returned verbatim. Degraded successes carry in-body
        # warning/error fields and MUST NOT raise. The REST contract is
        # JSON-only, so a non-JSON 2xx body means we are not talking to a
        # wigolo daemon (a proxy/captive-portal/wrong-service) — raise.
        text = raw.decode("utf-8", errors="replace")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise WigoloConnectionError(
                f"received a non-JSON success body from {url} "
                f"({text[:200]!r}) — the endpoint does not look like a wigolo "
                f"REST daemon."
            ) from exc

    @staticmethod
    def _api_error_from_http(exc: urllib.error.HTTPError) -> WigoloAPIError:
        status = exc.code
        retry_after = None
        try:
            ra = exc.headers.get("Retry-After") if exc.headers else None
            if ra is not None:
                retry_after = int(ra.strip())
        except (ValueError, AttributeError):
            retry_after = None

        try:
            raw = exc.read()
        except Exception:  # pragma: no cover - defensive
            raw = b""
        text = raw.decode("utf-8", errors="replace") if raw else ""

        error = error_reason = stage = None
        message = f"wigolo API error {status}"
        try:
            envelope = json.loads(text) if text else None
        except json.JSONDecodeError:
            envelope = None

        if isinstance(envelope, dict):
            error = envelope.get("error")
            error_reason = envelope.get("error_reason")
            stage = envelope.get("stage")
            if error:
                message = f"wigolo API error {status}: {error}"
        elif text:
            snippet = text.strip()[:200]
            message = f"wigolo API error {status}: {snippet}"

        return WigoloAPIError(
            message,
            status=status,
            error=error,
            error_reason=error_reason,
            stage=stage,
            retry_after=retry_after,
            raw_body=text or None,
        )

    def _call_tool(
        self, tool: str, params: dict[str, Any], per_call_timeout: Optional[float]
    ) -> Any:
        spec = MANIFEST[tool]
        body = {k: v for k, v in params.items() if v is not None}
        timeout = self._resolve_timeout(tool, per_call_timeout)
        return self._request("POST", spec["path"], body=body, timeout=timeout)

    # ---- meta endpoints --------------------------------------------------

    def health(self, *, timeout: Optional[float] = None) -> Any:
        """GET /health. Returns status even when the server is degraded.

        A degraded daemon answers ``/health`` with HTTP 503 carrying the SAME
        report body as a healthy 200. This method returns that report in both
        cases (it does NOT raise on the contract-defined 503-with-body) so
        callers can inspect ``status``/``searxng``. Only a transport failure or
        a non-JSON body raises. The ``searxng`` field is the search-aggregator
        sidecar status.
        """
        try:
            return self._request("GET", "/health", timeout=timeout or 10.0)
        except WigoloAPIError as exc:
            # The 503-down report is a value, not an error. Any other status,
            # or an unparseable body, is re-raised.
            if exc.status == 503:
                parsed = self._health_report_from_error(exc)
                if parsed is not None:
                    return parsed
            raise

    @staticmethod
    def _health_report_from_error(exc: WigoloAPIError) -> Optional[dict[str, Any]]:
        """Recover the JSON /health report from a 503 error, or None if absent."""
        raw = getattr(exc, "raw_body", None)
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        return parsed if isinstance(parsed, dict) else None

    def list_tools(self, *, timeout: Optional[float] = None) -> Any:
        """GET /v1/tools. Lists the available tools (bearer-gated in token mode)."""
        return self._request("GET", "/v1/tools", timeout=timeout or 30.0)

    def openapi(self, *, timeout: Optional[float] = None) -> Any:
        """GET /openapi.json (bearer-gated in token mode)."""
        return self._request("GET", "/openapi.json", timeout=timeout or 30.0)

    # ---- tools -----------------------------------------------------------

    def search(
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
        return self._call_tool(
            "search",
            {
                "query": query,
                "max_results": max_results,
                "max_fetches": max_fetches,
                "include_content": include_content,
                "content_max_chars": content_max_chars,
                "max_content_chars": max_content_chars,
                "max_total_chars": max_total_chars,
                "time_range": time_range,
                "exact_match": exact_match,
                "search_engines": search_engines,
                "language": language,
                "country": country,
                "include_domains": include_domains,
                "exclude_domains": exclude_domains,
                "from_date": from_date,
                "to_date": to_date,
                "category": category,
                "format": format,
                "max_highlights": max_highlights,
                "force_refresh": force_refresh,
                "include_favicon": include_favicon,
                "include_images": include_images,
                "max_tokens_out": max_tokens_out,
                "include_full_markdown": include_full_markdown,
                "citation_format": citation_format,
                "mode": mode,
                "search_depth": search_depth,
                "agent_context": agent_context,
            },
            timeout,
        )

    def fetch(
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
        return self._call_tool(
            "fetch",
            {
                "url": url,
                "render_js": render_js,
                "use_auth": use_auth,
                "max_chars": max_chars,
                "max_content_chars": max_content_chars,
                "section": section,
                "section_index": section_index,
                "screenshot": screenshot,
                "headers": headers,
                "force_refresh": force_refresh,
                "max_tokens_out": max_tokens_out,
                "include_full_markdown": include_full_markdown,
                "citation_format": citation_format,
                "actions": actions,
                "mode": mode,
            },
            timeout,
        )

    def crawl(
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
        """Crawl a site from a seed URL. ``strategy='map'`` returns ``urls``
        (no ``pages``); bfs/dfs/sitemap return ``pages``."""
        return self._call_tool(
            "crawl",
            {
                "url": url,
                "max_depth": max_depth,
                "max_pages": max_pages,
                "strategy": strategy,
                "include_patterns": include_patterns,
                "exclude_patterns": exclude_patterns,
                "use_auth": use_auth,
                "extract_links": extract_links,
                "max_total_chars": max_total_chars,
                "max_tokens_out": max_tokens_out,
                "include_full_markdown": include_full_markdown,
                "citation_format": citation_format,
            },
            timeout,
        )

    def cache(
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
        return self._call_tool(
            "cache",
            {
                "query": query,
                "url_pattern": url_pattern,
                "since": since,
                "clear": clear,
                "stats": stats,
                "check_changes": check_changes,
                "mode": mode,
                "limit": limit,
                "max_tokens_out": max_tokens_out,
            },
            timeout,
        )

    def extract(
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
        return self._call_tool(
            "extract",
            {
                "url": url,
                "html": html,
                "mode": mode,
                "css_selector": css_selector,
                "multiple": multiple,
                "schema": schema,
                "named_schema": named_schema,
                "max_tokens_out": max_tokens_out,
            },
            timeout,
        )

    def find_similar(
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
        return self._call_tool(
            "find_similar",
            {
                "url": url,
                "concept": concept,
                "max_results": max_results,
                "include_domains": include_domains,
                "exclude_domains": exclude_domains,
                "include_cache": include_cache,
                "include_web": include_web,
                "mode": mode,
                "max_tokens_out": max_tokens_out,
                "include_full_markdown": include_full_markdown,
                "citation_format": citation_format,
                "threshold": threshold,
                "include_ranking_debug": include_ranking_debug,
            },
            timeout,
        )

    def research(
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
        """Multi-step research over the web.

        ``stream`` is schema-accepted but has no effect over this transport.
        """
        return self._call_tool(
            "research",
            {
                "question": question,
                "depth": depth,
                "max_sources": max_sources,
                "include_domains": include_domains,
                "exclude_domains": exclude_domains,
                "schema": schema,
                "stream": stream,
                "max_tokens_out": max_tokens_out,
                "include_full_markdown": include_full_markdown,
                "citation_format": citation_format,
            },
            timeout,
        )

    def agent(
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
        """Autonomous data-gathering agent.

        ``stream`` is schema-accepted but has no effect over this transport.
        """
        return self._call_tool(
            "agent",
            {
                "prompt": prompt,
                "urls": urls,
                "schema": schema,
                "max_pages": max_pages,
                "max_time_ms": max_time_ms,
                "stream": stream,
                "max_tokens_out": max_tokens_out,
                "include_full_markdown": include_full_markdown,
                "citation_format": citation_format,
            },
            timeout,
        )

    def diff(
        self,
        *,
        old: Optional[dict[str, Any]] = None,
        new: Optional[dict[str, Any]] = None,
        output: Optional[str] = None,
        granularity: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Diff two content sources.

        ``old`` is one of ``{url}`` | ``{markdown}`` | ``{content_hash}``;
        ``new`` is ``{url}`` | ``{markdown}``. ``output``:
        unified|hunks|summary. ``granularity``: line|word|section.
        """
        return self._call_tool(
            "diff",
            {
                "old": old,
                "new": new,
                "output": output,
                "granularity": granularity,
            },
            timeout,
        )

    def watch(
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
        return self._call_tool(
            "watch",
            {
                "action": action,
                "url": url,
                "urls": urls,
                "interval_seconds": interval_seconds,
                "selector": selector,
                "notification": notification,
                "job_id": job_id,
            },
            timeout,
        )
