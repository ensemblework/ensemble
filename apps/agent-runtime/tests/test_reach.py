"""A host that never answers names the cause. A socket that dies before headers stays a drop."""

from __future__ import annotations

import asyncio
import json
import socket

import httpx
import pytest

from ensemble_agent import credentials, models
from ensemble_agent.models import (
    CONNECTION_DROPPED_NOTICE,
    history_entries,
    is_transport_drop,
    stream_with_tools,
)
from ensemble_agent.provider_error import ProviderError
from ensemble_agent.rate_limit import reset_buckets
from ensemble_agent.reach import ModelUnreachable

LEAK = "/workspace/apps/agent-runtime/ensemble_agent/models.py:420\nTraceback (most recent call last)"


class _Boom(Exception):
    def __init__(self, message: str, code: str) -> None:
        super().__init__(f"{message}\n{LEAK}")
        self.code = code


def _install(monkeypatch: pytest.MonkeyPatch, boom: BaseException, base_url: str | None = None) -> None:
    reset_buckets()

    def resolve(user_id: str | None, provider: str) -> credentials.Credential:
        del user_id
        secret = "" if provider == "ollama" else "test-key"
        return credentials.Credential(provider, secret, "you", base_url)

    class _Stream:
        async def __aenter__(self):
            raise boom

        async def __aexit__(self, *args):
            return False

    class _Client:
        def __init__(self, *args, **kwargs):
            del args, kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def stream(self, *args, **kwargs):
            del args, kwargs
            return _Stream()

        async def post(self, *args, **kwargs):
            del args, kwargs
            raise boom

    monkeypatch.setattr(models, "_resolve", resolve)
    monkeypatch.setattr(httpx, "AsyncClient", _Client)


def _error_payload(body: dict) -> dict:
    async def collect() -> str:
        found = ""
        async for frame in stream_with_tools(body):
            if frame.startswith("event: error"):
                found = frame
        return found

    frame = asyncio.run(collect())
    assert frame.startswith("event: error"), frame
    return json.loads(frame.split("data:", 1)[1].strip())


def test_connection_refused_names_the_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, _Boom("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED"))
    payload = _error_payload(
        {"provider": "openai", "model": "gpt-4.1", "userId": "reach-user", "messages": [{"role": "user", "content": "hi"}]}
    )
    assert payload["code"] == "model_unreachable"
    assert payload["provider"] == "openai"
    assert payload["model"] == "gpt-4.1"
    assert payload["host"] == "api.openai.com"
    assert payload["reason"] == "refused"
    assert payload["status"] == 503
    assert payload["message"] == "Couldn't reach OpenAI at api.openai.com: connection refused"
    assert "models.py" not in payload["message"]
    assert "ECONNREFUSED" not in json.dumps(payload)
    assert "Traceback" not in json.dumps(payload)


def test_unknown_host_uses_the_model_url(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, _Boom("getaddrinfo ENOTFOUND evil.internal", "ENOTFOUND"), "https://no-such.example/v1")
    payload = _error_payload(
        {"provider": "openai", "model": "gpt-4.1", "userId": "reach-user", "messages": [{"role": "user", "content": "hi"}]}
    )
    assert payload["code"] == "model_unreachable"
    assert payload["reason"] == "dns"
    assert payload["host"] == "no-such.example"
    assert payload["message"] == "no-such.example couldn't be found. Check the model URL."
    assert "evil.internal" not in payload["message"]
    assert "ENOTFOUND" not in json.dumps(payload)
    assert "models.py" not in json.dumps(payload)


def test_ollama_down_names_the_address(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, _Boom("[Errno 111] Connection refused", "ECONNREFUSED"))
    payload = _error_payload(
        {
            "provider": "ollama",
            "model": "llama3.2",
            "userId": "reach-user",
            "ollamaUrl": "http://localhost:11434",
            "messages": [{"role": "user", "content": "hi"}],
        }
    )
    assert payload["code"] == "model_unreachable"
    assert payload["provider"] == "ollama"
    assert payload["model"] == "llama3.2"
    assert payload["reason"] == "down"
    assert payload["host"] == "http://localhost:11434"
    assert payload["message"] == "Couldn't reach Ollama at http://localhost:11434. Is it running?"
    assert "Errno" not in json.dumps(payload)
    assert "models.py" not in json.dumps(payload)


def test_socket_killed_before_headers_is_still_a_drop(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, _Boom("closed before headers", "UND_ERR_SOCKET"))
    payload = _error_payload(
        {"provider": "openai", "model": "gpt-4.1", "userId": "reach-user", "messages": [{"role": "user", "content": "hi"}]}
    )
    assert payload["message"] == CONNECTION_DROPPED_NOTICE
    assert "code" not in payload
    blob = json.dumps(payload)
    assert "closed before headers" not in blob
    assert "UND_ERR" not in blob
    assert "models.py" not in blob
    assert "Traceback" not in blob

    socket = _Boom("closed before headers", "UND_ERR_SOCKET")
    assert is_transport_drop(socket) is True
    assert is_transport_drop(ProviderError(429, "quota", "This key is out of quota.")) is False
    assert is_transport_drop(ModelUnreachable("Couldn't reach OpenAI at api.openai.com: connection refused", provider="openai", model="gpt-4.1", host="api.openai.com", reason="refused")) is False

    history = history_entries(
        [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "Couldn't reach OpenAI at api.openai.com: connection refused"},
            {"role": "assistant", "content": "no-such.example couldn't be found. Check the model URL."},
            {"role": "assistant", "content": "Couldn't reach Ollama at http://localhost:11434. Is it running?"},
            {"role": "assistant", "content": CONNECTION_DROPPED_NOTICE},
            {"role": "user", "content": "again"},
        ]
    )
    assert [row["content"] for row in history] == ["hi", "again"]


def _closed_port() -> int:
    """Bind a socket, read the port, and close it so the next connect is refused."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _resolve_to(base_url: str | None, provider: str = "openai"):
    def resolve(user_id: str | None, resolved: str) -> credentials.Credential:
        del user_id
        secret = "" if resolved == "ollama" else "test-key"
        return credentials.Credential(resolved, secret, "you", base_url if resolved == provider else None)

    return resolve


def _frames(body: dict) -> list[str]:
    async def collect() -> list[str]:
        return [frame async for frame in stream_with_tools(body)]

    return asyncio.run(collect())


def _assert_unreachable(frames: list[str], message: str) -> dict:
    blob = "".join(frames)
    assert "All connection attempts failed" not in blob
    assert "Connect call failed" not in blob
    assert "Traceback" not in blob
    assert "models.py" not in blob
    errors = [frame for frame in frames if frame.startswith("event: error")]
    assert len(errors) == 1, frames
    assert not any(frame.startswith("event: delta") for frame in frames)
    payload = json.loads(errors[0].split("data:", 1)[1].strip())
    assert payload["code"] == "model_unreachable"
    assert payload["status"] == 503
    assert payload["message"] == message
    history = history_entries(
        [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": payload["message"]},
            {"role": "user", "content": "again"},
        ]
    )
    assert [row["content"] for row in history] == ["hi", "again"]
    return payload


def test_real_closed_port_is_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    port = _closed_port()
    reset_buckets()
    monkeypatch.setattr(models, "_resolve", _resolve_to(f"http://127.0.0.1:{port}/v1"))
    frames = _frames(
        {"provider": "openai", "model": "gpt-4.1", "userId": "reach-user", "messages": [{"role": "user", "content": "hi"}]}
    )
    payload = _assert_unreachable(frames, f"Couldn't reach OpenAI at 127.0.0.1:{port}: connection refused")
    assert payload["reason"] == "refused"
    assert payload["host"] == f"127.0.0.1:{port}"
    assert payload["provider"] == "openai"


def test_real_closed_port_ollama_is_down(monkeypatch: pytest.MonkeyPatch) -> None:
    port = _closed_port()
    reset_buckets()
    monkeypatch.setattr(models, "_resolve", _resolve_to(None, "ollama"))
    origin = f"http://127.0.0.1:{port}"
    frames = _frames(
        {
            "provider": "ollama",
            "model": "llama3.2",
            "userId": "reach-user",
            "ollamaUrl": origin,
            "messages": [{"role": "user", "content": "hi"}],
        }
    )
    payload = _assert_unreachable(frames, f"Couldn't reach Ollama at {origin}. Is it running?")
    assert payload["reason"] == "down"
    assert payload["host"] == origin
    assert payload["provider"] == "ollama"


def test_real_unresolvable_host_is_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    reset_buckets()
    host = "no-such-ensemble-host.invalid"
    monkeypatch.setattr(models, "_resolve", _resolve_to(f"https://{host}/v1"))
    frames = _frames(
        {"provider": "openai", "model": "gpt-4.1", "userId": "reach-user", "messages": [{"role": "user", "content": "hi"}]}
    )
    payload = _assert_unreachable(frames, f"{host} couldn't be found. Check the model URL.")
    assert payload["reason"] == "dns"
    assert payload["host"] == host
    assert host in payload["message"]
