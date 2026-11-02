"""Model calls that end when hub-api stops waiting.

hub-api closes its request when the owner presses Stop, when its time limit passes, or when it stops
for any other reason. Each call here runs in a task of its own that a closed request cancels: the
provider's stream is closed with it, so the provider stops generating. A stream also ends at its own
deadline (hub-api's limit and a margin, model_timeout.py) with an error frame.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, TypeVar

Receive = Callable[[], Awaitable[dict[str, Any]]]
T = TypeVar("T")

_END = object()


async def _closed(receive: Receive) -> None:
    """Returns when the client has gone (`http.disconnect`)."""
    while True:
        message = await receive()
        if message.get("type") == "http.disconnect":
            return


async def frames_until_closed(receive: Receive, frames: AsyncIterator[str], *, seconds: float, on_timeout: Callable[[], str]) -> AsyncIterator[str]:
    """The frames as they come, until they end, the client goes, or ``seconds`` pass (then ``on_timeout()``)."""
    queue: asyncio.Queue[object] = asyncio.Queue()

    async def produce() -> None:
        try:
            async with asyncio.timeout(seconds):
                async for frame in frames:
                    queue.put_nowait(frame)
        except TimeoutError:
            queue.put_nowait(on_timeout())
        finally:
            queue.put_nowait(_END)

    producer = asyncio.create_task(produce())
    watcher = asyncio.create_task(_closed(receive))
    try:
        while True:
            getter = asyncio.ensure_future(queue.get())
            done, _ = await asyncio.wait({getter, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if getter not in done:
                getter.cancel()
                return
            item = getter.result()
            if item is _END:
                return
            yield str(item)
    finally:
        # Not awaited: the response may be cancelled itself, and the call must stop either way.
        producer.cancel()
        watcher.cancel()


async def until_closed(receive: Receive, work: Awaitable[T]) -> tuple[bool, T | None]:
    """``(True, result)`` when the work finished, ``(False, None)`` when the client went first (the work is cancelled)."""
    task = asyncio.ensure_future(work)
    watcher = asyncio.create_task(_closed(receive))
    try:
        await asyncio.wait({task, watcher}, return_when=asyncio.FIRST_COMPLETED)
        if task.done():
            return True, task.result()
        return False, None
    finally:
        task.cancel()
        watcher.cancel()
