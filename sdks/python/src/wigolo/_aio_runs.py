"""The async twin of the ``runs`` namespace.

Same shape as :class:`wigolo._runs.Runs`, every method awaitable. Like the rest of
:class:`~wigolo._aio.AsyncClient`, the blocking work runs on the client's bounded thread pool
rather than being reimplemented on a second HTTP stack — one transport, one set of semantics,
and a divergence between sync and async becomes impossible rather than merely unlikely.

The stream is the one place that needs care: a blocking iterator cannot be awaited, so each
step of it is pumped through the executor. ``stop()`` sets the same ``threading.Event`` the sync
watch uses, so cancelling from the loop and cancelling from a thread are the same mechanism.
"""

from __future__ import annotations

import asyncio
import inspect
import threading
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable, Optional, Sequence, Union

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ._aio import AsyncClient

__all__ = ["AsyncRunWatch", "AsyncRuns"]

_SENTINEL = object()


class AsyncRunWatch:
    """Handle on a running async watch."""

    def __init__(self, stop_event: threading.Event, task: "asyncio.Task[None]") -> None:
        self._stop_event = stop_event
        self._task = task
        self._last_seq = 0

    @property
    def last_seq(self) -> int:
        """Highest seq delivered so far — the resume point if you restart the watch yourself."""
        return self._last_seq

    def stop(self) -> None:
        """Stop watching. Idempotent."""
        self._stop_event.set()

    async def join(self) -> None:
        """Wait for the watch to finish. Never re-raises a cancellation of its own task."""
        try:
            await self._task
        except asyncio.CancelledError:
            if not self._task.cancelled():
                raise

    async def __aenter__(self) -> "AsyncRunWatch":
        return self

    async def __aexit__(self, *exc: object) -> None:
        self.stop()
        await self.join()


class AsyncRuns:
    """The runs surface on an :class:`~wigolo._aio.AsyncClient`. Reached as ``client.runs``."""

    def __init__(self, client: "AsyncClient") -> None:
        self._client = client

    async def _call(self, name: str, *args: Any, **kwargs: Any) -> Any:
        loop = asyncio.get_running_loop()
        fn = getattr(self._client._client.runs, name)

        def _invoke() -> Any:
            return fn(*args, **kwargs)

        return await loop.run_in_executor(self._client._executor, _invoke)

    async def create(
        self,
        *,
        task: str,
        space_id: Optional[str] = None,
        driver: Optional[dict] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        """``POST /v1/runs``. See :meth:`wigolo._runs.Runs.create`."""
        return await self._call(
            "create", task=task, space_id=space_id, driver=driver, timeout=timeout
        )

    async def get(self, run_id: str, *, timeout: Optional[float] = None) -> dict:
        """``GET /v1/runs/<id>``."""
        return await self._call("get", run_id, timeout=timeout)

    async def list(
        self,
        *,
        status: Optional[Union[str, Sequence[str]]] = None,
        space_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        """``GET /v1/runs``."""
        return await self._call(
            "list",
            status=status,
            space_id=space_id,
            limit=limit,
            cursor=cursor,
            timeout=timeout,
        )

    async def send_message(
        self,
        run_id: str,
        *,
        text: str,
        urgent: Optional[bool] = None,
        message_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        """``POST /v1/runs/<id>/messages``. The result's ``state_line`` is the honest one."""
        return await self._call(
            "send_message",
            run_id,
            text=text,
            urgent=urgent,
            message_id=message_id,
            timeout=timeout,
        )

    async def messages(
        self, run_id: str, *, limit: Optional[int] = None, timeout: Optional[float] = None
    ) -> list:
        """``GET /v1/runs/<id>/messages``."""
        return await self._call("messages", run_id, limit=limit, timeout=timeout)

    async def driver_gesture(
        self,
        run_id: str,
        *,
        gesture: str,
        by: dict,
        to: Optional[dict] = None,
        request_id: Optional[str] = None,
        reason: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        """``POST /v1/runs/<id>/driver`` — the baton gestures."""
        return await self._call(
            "driver_gesture",
            run_id,
            gesture=gesture,
            by=by,
            to=to,
            request_id=request_id,
            reason=reason,
            timeout=timeout,
        )

    async def events(self, run_id: str, **kwargs: Any) -> AsyncIterator[dict]:
        """The event stream as an async iterator. See :meth:`wigolo._runs.Runs.events`.

        Each step of the blocking iterator is pumped through the executor, so the loop is never
        held by a socket read. Breaking out of the ``async for`` sets the stop event, which is
        what ends the underlying connection.
        """
        stop = kwargs.get("stop_event")
        if stop is None:
            stop = threading.Event()
            kwargs["stop_event"] = stop
        loop = asyncio.get_running_loop()
        iterator = self._client._client.runs.events(run_id, **kwargs)

        def _next() -> Any:
            try:
                return next(iterator)
            except StopIteration:
                return _SENTINEL

        try:
            while True:
                item = await loop.run_in_executor(self._client._executor, _next)
                if item is _SENTINEL:
                    return
                yield item
        finally:
            # A caller that stopped iterating (break, or a cancelled task) must not leave a
            # worker thread parked on a socket read that nothing will ever consume.
            stop.set()
            iterator.close()

    def watch_run(
        self,
        run_id: str,
        *,
        on_human_message: Optional[Callable[[dict], Any]] = None,
        on_approval: Optional[Callable[[dict], Any]] = None,
        on_takeover: Optional[Callable[[dict], Any]] = None,
        on_event: Optional[Callable[[dict], Any]] = None,
        on_error: Optional[Callable[[BaseException, Optional[dict]], Any]] = None,
        **events_kwargs: Any,
    ) -> AsyncRunWatch:
        """Watch a run as an asyncio task, fanning envelopes out to callbacks.

        Same mapping as the synchronous twin — ``message.queued`` -> ``on_human_message``,
        ``decision.requested`` -> ``on_approval``, ``driver.changed {cause: 'takeover'}`` ->
        ``on_takeover``, everything to ``on_event``. Callbacks may be coroutine functions and
        are awaited. One that raises is reported and the watch continues.
        """
        stop = threading.Event()
        events_kwargs.setdefault("stop_event", stop)
        watch_holder: dict[str, AsyncRunWatch] = {}

        async def dispatch(handler: Optional[Callable[[dict], Any]], event: dict) -> None:
            if handler is None:
                return
            try:
                result = handler(event)
                if inspect.isawaitable(result):
                    await result
            except asyncio.CancelledError:
                raise
            except BaseException as exc:  # noqa: BLE001 - never rethrown
                if on_error is not None:
                    try:
                        maybe = on_error(exc, event)
                        if inspect.isawaitable(maybe):
                            await maybe
                    except BaseException:  # noqa: BLE001 - out of options
                        pass

        async def pump() -> None:
            try:
                async for event in self.events(run_id, **events_kwargs):
                    watch = watch_holder.get("watch")
                    if watch is not None:
                        watch._last_seq = event["seq"]
                    event_type = event["type"]
                    if event_type == "message.queued":
                        await dispatch(on_human_message, event)
                    elif event_type == "decision.requested":
                        await dispatch(on_approval, event)
                    elif event_type == "driver.changed":
                        if event["payload"].get("cause") == "takeover":
                            await dispatch(on_takeover, event)
                    # An unknown type has nothing to do here; ``on_event`` is its destination.
                    await dispatch(on_event, event)
            except asyncio.CancelledError:
                raise
            except BaseException as exc:  # noqa: BLE001
                if not stop.is_set() and on_error is not None:
                    try:
                        maybe = on_error(exc, None)
                        if inspect.isawaitable(maybe):
                            await maybe
                    except BaseException:  # noqa: BLE001
                        pass

        # A running loop is required: the watch IS a task on it. Calling this outside one is a
        # programming error worth surfacing here rather than at the first missed event.
        task = asyncio.get_running_loop().create_task(pump())
        watch = AsyncRunWatch(stop, task)
        watch_holder["watch"] = watch
        return watch
