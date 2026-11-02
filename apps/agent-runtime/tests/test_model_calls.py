"""Model calls end when hub-api stops waiting: its request closed (Stop, its limit) or this runtime's own deadline.

Real HTTP on both sides: this runtime under uvicorn, and a fake Azure deployment that starts a stream
and then thinks for ever. Each test checks that Azure's stream is closed, so it stops generating.
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import StreamingResponse
from starlette.routing import Route

from ensemble_agent import included, main, model_timeout, models

TOKEN = "internal-test-token"


def _port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class _Serving:
    def __init__(self, app: Any) -> None:
        self.port = _port()
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning", lifespan="off"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self) -> "_Serving":
        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started:
            if time.monotonic() > deadline:
                raise RuntimeError("the server did not start")
            time.sleep(0.02)
        return self

    def __exit__(self, *args: Any) -> None:
        self.server.should_exit = True
        self.thread.join(5)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


class _Azure:
    """A Responses deployment that sends ``response.created`` and then nothing: a model thinking for ever."""

    def __init__(self) -> None:
        self.received = threading.Event()
        self.closed = threading.Event()
        self.bodies: list[dict[str, Any]] = []

        async def responses(request: Request) -> StreamingResponse:
            self.bodies.append(await request.json())
            self.received.set()

            async def stream():
                try:
                    yield b'data: {"type":"response.created","response":{"status":"in_progress"}}\n\n'
                    await asyncio.sleep(3600)
                finally:
                    self.closed.set()

            return StreamingResponse(stream(), media_type="text/event-stream")

        self.app = Starlette(routes=[Route("/openai/v1/responses", responses, methods=["POST"])])


@pytest.fixture
def azure(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[_Azure, _Serving, list[Any]]]:
    fake = _Azure()
    settled: list[Any] = []

    async def reserve(*args: Any) -> str:
        del args
        return "res-1"

    async def settle(user_id: str, reservation: str, usage: Any, answered_by: str | None = None) -> float:
        del user_id, answered_by
        settled.append((reservation, usage))
        return 0.0

    async def no_pace(*args: Any) -> float:
        del args
        return 0.0

    monkeypatch.setenv("ENSEMBLE_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("AZURE_FOUNDRY_RESOURCE", "ensemble-ai")
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "azure-test-key")
    monkeypatch.delenv("ENSEMBLE_INCLUDED_MODELS", raising=False)
    monkeypatch.setattr(included, "reserve", reserve)
    monkeypatch.setattr(included, "settle", settle)
    monkeypatch.setattr(included, "pace", no_pace)
    monkeypatch.setattr(models, "require_verified_user", lambda user_id: None)
    monkeypatch.setattr(main, "require_verified_user", lambda user_id: None)
    with _Serving(fake.app) as served:
        monkeypatch.setattr(included, "openai_base", lambda resource, host: f"{served.url}/openai/v1")
        with _Serving(main.app) as runtime:
            yield fake, runtime, settled


BODY = {"provider": "ensemble", "model": "gpt-6.1-sol", "userId": "u1", "messages": [{"role": "user", "content": "Find papers."}], "timeoutMs": 600_000}


def test_hub_api_closing_the_stream_closes_azures(azure: tuple[_Azure, _Serving, list[Any]]) -> None:
    fake, runtime, settled = azure
    with httpx.Client(timeout=10) as client:
        with client.stream("POST", f"{runtime.url}/api/chat/tools/stream", headers={"x-ensemble-internal": TOKEN}, json=BODY) as response:
            assert response.status_code == 200
            assert fake.received.wait(5), "the call reached Azure"
            assert fake.bodies[0]["stream"] is True
            # hub-api stops waiting (the owner's Stop, or its limit): the response is closed unread.
    assert fake.closed.wait(5), "Azure's stream closed with it"
    deadline = time.monotonic() + 5
    while not settled and time.monotonic() < deadline:
        time.sleep(0.05)
    assert settled == [("res-1", None)], "an unfinished call charges its reservation"


def test_hub_api_closing_a_whole_turn_request_closes_azures(azure: tuple[_Azure, _Serving, list[Any]]) -> None:
    fake, runtime, _settled = azure
    with httpx.Client(timeout=httpx.Timeout(10, read=1.0)) as client:
        with pytest.raises(httpx.ReadTimeout):
            client.post(f"{runtime.url}/api/chat/tools", headers={"x-ensemble-internal": TOKEN}, json=BODY)
    assert fake.received.is_set()
    assert fake.closed.wait(5), "Azure's stream closed when hub-api gave up"


def test_the_runtime_stops_at_its_own_deadline_with_a_clear_error(azure: tuple[_Azure, _Serving, list[Any]], monkeypatch: pytest.MonkeyPatch) -> None:
    fake, runtime, _settled = azure
    monkeypatch.setattr(model_timeout, "GRACE_MS", 0)
    started = time.monotonic()
    with httpx.Client(timeout=10) as client:
        response = client.post(f"{runtime.url}/api/chat/tools/stream", headers={"x-ensemble-internal": TOKEN}, json={**BODY, "timeoutMs": 1_000})
    assert time.monotonic() - started < 5
    frames = [frame for frame in response.text.split("\n\n") if frame.strip()]
    assert frames[-1].startswith("event: error")
    error = json.loads(frames[-1].split("data:", 1)[1])
    assert error == {"message": "GPT-6.1 Sol did not answer within 1 second, so I stopped waiting. Ask again, or try a narrower question.", "kind": "timeout", "status": 504}
    assert fake.closed.wait(5)


def test_the_timeout_setting_and_the_margin() -> None:
    assert model_timeout.model_call_timeout_ms({}) == 900_000
    assert model_timeout.model_call_timeout_ms({"ENSEMBLE_MODEL_CALL_TIMEOUT_MS": "1000"}) == 30_000
    assert model_timeout.model_call_timeout_ms({"ENSEMBLE_MODEL_CALL_TIMEOUT_MS": "99999999"}) == 1_800_000
    assert model_timeout.model_call_timeout_ms({"ENSEMBLE_MODEL_CALL_TIMEOUT_MS": "nope"}) == 900_000
    assert model_timeout.runtime_seconds({"timeoutMs": 120_000}, {}) == 130.0, "hub-api's limit and a margin: hub-api cuts first"
    assert model_timeout.runtime_seconds({}, {"ENSEMBLE_MODEL_CALL_TIMEOUT_MS": "600000"}) == 600.0
    assert model_timeout.timeout_message("gpt-6.1-sol", 900_000) == "GPT-6.1 Sol did not answer within 15 minutes, so I stopped waiting. Ask again, or try a narrower question."
