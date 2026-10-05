"""A socket that dies before response headers must not reach the model as raw text.

Removing the ConnectionDropped wrap in _openai_stream_events makes this fail:
the error event would carry 'Server disconnected' and the next turn would send it.
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading

from ensemble_agent import credentials
from ensemble_agent.models import CONNECTION_DROPPED_NOTICE, is_non_model_notice, stream_with_tools

RAW = ("Server disconnected", "fetch failed", "peer closed", "ECONNRESET", "socket hang up", "incomplete chunked read")


def _drop_before_headers() -> tuple[socket.socket, int]:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(8)
    port = server.getsockname()[1]

    def accept() -> None:
        while True:
            try:
                conn, _addr = server.accept()
            except OSError:
                return
            try:
                conn.recv(65536)
            except OSError:
                pass
            conn.close()

    threading.Thread(target=accept, daemon=True).start()
    return server, port


def _error_message(frames: list[str]) -> str:
    for frame in frames:
        if not frame.startswith("event: error"):
            continue
        data = "\n".join(line[5:].strip() for line in frame.splitlines() if line.startswith("data:"))
        body = json.loads(data)
        return str(body.get("message") or "")
    raise AssertionError(f"no error event in {frames!r}")


def test_socket_closed_before_headers_is_not_saved_or_sent(monkeypatch) -> None:
    server, port = _drop_before_headers()

    def resolve(user_id: str | None, provider: str) -> credentials.Credential:
        return credentials.Credential(provider, "test-key", "you", f"http://127.0.0.1:{port}/v1")

    async def no_wait(*_args, **_kwargs) -> float:
        return 0.0

    monkeypatch.setattr(credentials, "resolve", resolve)
    monkeypatch.setattr("ensemble_agent.models.take_token", no_wait)
    try:
        async def once() -> list[str]:
            frames: list[str] = []
            async for frame in stream_with_tools(
                {
                    "userId": "drop-user",
                    "provider": "openai",
                    "model": "gpt-4.1-mini",
                    "messages": [{"role": "user", "content": "hello"}],
                }
            ):
                frames.append(frame)
            return frames

        frames = asyncio.run(once())
    finally:
        server.close()

    blob = "".join(frames)
    message = _error_message(frames)
    assert message == CONNECTION_DROPPED_NOTICE
    for needle in RAW:
        assert needle not in blob, blob
        assert needle not in message

    rows = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": message},
        {"role": "user", "content": "try again"},
    ]
    sent = [row for row in rows if not (row["role"] == "assistant" and is_non_model_notice(row["content"]))]
    payload = json.dumps(sent)
    assert CONNECTION_DROPPED_NOTICE not in payload
    for needle in RAW:
        assert needle not in payload
