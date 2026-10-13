"""Copilot models served only on /responses: routed there, read back as one turn, and learned from a refusal."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from ensemble_agent import credentials, models, responses_api
from ensemble_agent.models import complete_text, complete_with_tools, copilot_meta, stream_with_tools
from ensemble_agent.provider_error import ProviderError

REFUSAL = {"error": {"message": 'model "gpt-5.4-mini" is not accessible via the /chat/completions endpoint', "code": "model_not_supported", "type": "invalid_request_error"}}

RESPONSE = {
    "id": "resp_1",
    "object": "response",
    "status": "completed",
    "model": "gpt-5.4-mini",
    "output": [
        {"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "Thinking about it."}]},
        {"type": "message", "id": "msg_1", "role": "assistant", "content": [{"type": "output_text", "text": "Hello from Copilot."}]},
        {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "hub_list_tasks", "arguments": '{"limit": 5}'},
    ],
    "usage": {"input_tokens": 12, "output_tokens": 7},
}

STREAM = [
    {"type": "response.created", "response": {"id": "resp_2"}},
    {"type": "response.output_text.delta", "delta": "Hel"},
    {"type": "response.output_text.delta", "delta": "lo."},
    {"type": "response.completed", "response": {**RESPONSE, "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Hello."}]}]}},
]


class _Fake:
    """A Copilot that refuses gpt-5.4-mini on /chat/completions and answers on /responses."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def respond(self, url: str, payload: dict[str, Any]) -> httpx.Response:
        self.calls.append((url, payload))
        request = httpx.Request("POST", url)
        if url.endswith("/chat/completions"):
            if payload.get("model") == "gpt-5.4-mini":
                return httpx.Response(400, json=REFUSAL, request=request)
            body = {"model": payload["model"], "choices": [{"message": {"role": "assistant", "content": "chat answer"}, "finish_reason": "stop"}], "usage": {}}
            return httpx.Response(200, json=body, request=request)
        if url.endswith("/responses"):
            if payload.get("stream"):
                text = "".join(f"data: {json.dumps(event)}\n\n" for event in STREAM)
                return httpx.Response(200, text=text, request=request, headers={"content-type": "text/event-stream"})
            return httpx.Response(200, json=RESPONSE, request=request)
        return httpx.Response(404, json={"error": {"message": "nope"}}, request=request)


def _install(monkeypatch: pytest.MonkeyPatch) -> _Fake:
    fake = _Fake()
    responses_api.forget_learned()

    class _Streamed:
        def __init__(self, response: httpx.Response) -> None:
            self.response = response

        async def __aenter__(self) -> httpx.Response:
            return self.response

        async def __aexit__(self, *args: Any) -> bool:
            return False

    class _Client:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            del args, kwargs

        async def __aenter__(self) -> "_Client":
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def post(self, url: str, headers: dict[str, str] | None = None, json: dict[str, Any] | None = None, **kwargs: Any) -> httpx.Response:
            del headers, kwargs
            return fake.respond(url, json or {})

        def stream(self, method: str, url: str, headers: dict[str, str] | None = None, json: dict[str, Any] | None = None, **kwargs: Any) -> _Streamed:
            del method, headers, kwargs
            return _Streamed(fake.respond(url, json or {}))

    def resolve(user_id: str | None, provider: str) -> credentials.Credential:
        del user_id
        return credentials.Credential(provider=provider, secret="github_pat_fine", source="you", base_url=None)

    async def no_pace(*args: Any) -> float:
        del args
        return 0.0

    monkeypatch.setattr(models, "_resolve", resolve)
    monkeypatch.setattr(models, "pace", no_pace)
    monkeypatch.setattr(models, "take_token", no_pace)
    monkeypatch.setattr(models, "require_verified_user", lambda user_id: None)
    monkeypatch.setattr(models, "can_use_host_credentials", lambda user_id: False)
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    return fake


def test_gpt5_on_copilot_goes_to_responses_and_reads_back_as_one_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _install(monkeypatch)
    turn = asyncio.run(
        complete_with_tools(
            {
                "provider": "copilot",
                "model": "gpt-5.4-mini",
                "userId": "u1",
                "reasoningEffort": "low",
                "messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "Hi"}],
                "responsesMessages": [
                    {"role": "system", "content": "Be brief."},
                    {"role": "user", "content": "Hi"},
                    {"type": "reasoning", "id": "rs_0", "summary": []},
                    {"type": "function_call", "id": "fc_0", "call_id": "call_0", "name": "hub_get_task", "arguments": "{}"},
                    {"type": "function_call_output", "call_id": "call_0", "output": "{}"},
                ],
                "chatTools": [{"type": "function", "function": {"name": "hub_list_tasks", "description": "List", "parameters": {"type": "object", "properties": {}}}}],
                "responsesTools": [{"type": "function", "name": "hub_list_tasks", "description": "List", "parameters": {"type": "object", "properties": {}}}],
            }
        )
    )
    assert [url.rsplit("/", 1)[1] for url, _ in fake.calls] == ["responses"], "a gpt-5 model on Copilot goes straight to /responses"
    sent = fake.calls[0][1]
    assert sent["store"] is False
    assert sent["reasoning"] == {"effort": "low"}
    assert sent["tools"][0]["name"] == "hub_list_tasks"
    assert all(item.get("type") != "reasoning" for item in sent["input"]), "reasoning items are not sent back with store off"
    assert {"type": "function_call", "call_id": "call_0", "name": "hub_get_task", "arguments": "{}"} in sent["input"]
    assert turn["text"] == "Hello from Copilot."
    assert turn["toolCalls"] == [{"id": "call_1", "name": "hub_list_tasks", "arguments": '{"limit": 5}'}]
    assert (turn["tokensIn"], turn["tokensOut"], turn["finishReason"], turn["cutOff"]) == (12, 7, "tool_calls", False)
    assert turn["reasoning"] == "Thinking about it."


def test_a_chat_refusal_naming_the_endpoint_switches_once_and_is_remembered(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _install(monkeypatch)
    # A name the first guess sends to chat: the refusal teaches the runtime where it answers.
    monkeypatch.setattr(responses_api, "_RESPONSES_FIRST", responses_api.re.compile(r"^never$"))
    result = asyncio.run(complete_text({"provider": "copilot", "model": "gpt-5.4-mini", "userId": "u1", "prompt": "Say hi"}))
    assert result["text"] == "Hello from Copilot."
    assert [url.rsplit("/", 1)[1] for url, _ in fake.calls] == ["completions", "responses"]
    asyncio.run(complete_text({"provider": "copilot", "model": "gpt-5.4-mini", "userId": "u1", "prompt": "Again"}))
    assert [url.rsplit("/", 1)[1] for url, _ in fake.calls][2:] == ["responses"], "the second call goes straight to /responses"
    other = asyncio.run(complete_text({"provider": "copilot", "model": "claude-sonnet-4.6", "userId": "u1", "prompt": "Hi"}))
    assert other["text"] == "chat answer", "other Copilot models stay on chat"


def test_a_streamed_responses_turn_sends_deltas_then_the_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch)

    async def collect() -> list[str]:
        return [frame async for frame in stream_with_tools({"provider": "copilot", "model": "gpt-5.4-mini", "userId": "u1", "messages": [{"role": "user", "content": "Hi"}]})]

    frames = asyncio.run(collect())
    deltas = [json.loads(frame.split("data:", 1)[1]) for frame in frames if frame.startswith("event: delta")]
    turns = [json.loads(frame.split("data:", 1)[1]) for frame in frames if frame.startswith("event: turn")]
    assert [delta["text"] for delta in deltas] == ["Hel", "lo."]
    assert turns[0]["text"] == "Hello."
    assert not any(frame.startswith("event: error") for frame in frames)


def test_other_endpoint_reads_only_refusals_that_name_an_endpoint() -> None:
    assert responses_api.other_endpoint(ProviderError(400, "other", REFUSAL["error"]["message"])) == "responses"
    assert responses_api.other_endpoint(ProviderError(400, "other", 'model "claude-x" is not supported via the /responses endpoint')) == "chat"
    assert responses_api.other_endpoint(ProviderError(400, "other", "The requested model is not supported.")) is None
    assert responses_api.other_endpoint(ProviderError(503, "unavailable", "busy /chat/completions not accessible")) is None


def test_copilot_meta_keeps_the_endpoints_a_model_takes() -> None:
    rows = [{"id": "gpt-5.4-mini", "supported_endpoints": ["/responses"], "capabilities": {"type": "chat", "supports": {"reasoning_effort": ["low"]}}}]
    assert copilot_meta(rows) == {"gpt-5.4-mini": {"efforts": ["low"], "endpoints": ["/responses"]}}
    responses_api.forget_learned()
    responses_api.learn_from_listing("copilot", rows + [{"id": "gpt-5-mini", "supported_endpoints": ["/chat/completions", "/responses"]}])
    assert responses_api.api_for("copilot", "gpt-5.4-mini") == "responses"
    assert responses_api.api_for("copilot", "gpt-5-mini") == "chat"
    assert responses_api.api_for("openai", "gpt-5.4-mini") == "chat", "only Copilot is routed"
