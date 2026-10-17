"""Included models on Azure AI Foundry: config, request shapes, usage, and the credits ledger. No network."""

from __future__ import annotations

import asyncio
import inspect
import json
from typing import Any, Callable

import httpx
import pytest

from ensemble_agent import credentials, included, models
from ensemble_agent.main import http_error_for
from ensemble_agent.models import _public_failure, complete_text, complete_with_tools, stream_with_tools
from ensemble_agent.provider_error import ProviderError, no_key_message
from ensemble_agent.reach import PROVIDER_NAMES

HUB = "http://hub.test"
KEY = "azure-test-key"
RESETS = "2026-11-01T00:00:00.000Z"
TOOLS = [{"type": "function", "function": {"name": "hub_list_tasks", "description": "List tasks", "parameters": {"type": "object", "properties": {"limit": {"type": "integer"}}}}}]

GPT_REPLY = {
    "id": "resp_1",
    "status": "completed",
    "model": "gpt-6.1-sol-2026-09-29",
    "output": [
        {"type": "reasoning", "id": "rs_1", "summary": []},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": '{"ok": true}'}]},
    ],
    "usage": {"input_tokens": 5000, "input_tokens_details": {"cached_tokens": 4000, "cache_write_tokens": 600}, "output_tokens": 20},
}
GROK_REPLY = {
    "status": "completed",
    "model": "grok-4.7",
    "output": [{"type": "function_call", "call_id": "call_1", "name": "hub_list_tasks", "arguments": '{"limit":5}'}],
    "usage": {"input_tokens": 900, "input_tokens_details": {"cached_tokens": 512}, "output_tokens": 70},
}
DEEPSEEK_REPLY = {
    "model": "DeepSeek-V4-Flash",
    "choices": [
        {
            "message": {
                "role": "assistant",
                "content": "Looking.",
                "reasoning_content": "They want tasks.",
                "tool_calls": [{"id": "call_9", "type": "function", "function": {"name": "hub_list_tasks", "arguments": '{"limit":5}'}}],
            },
            "finish_reason": "tool_calls",
        }
    ],
    "usage": {"prompt_tokens": 1200, "completion_tokens": 30, "prompt_tokens_details": {"cached_tokens": 1024}},
}

CLAUDE_CONTENT = [
    {"type": "thinking", "thinking": "The person wants their tasks.", "signature": "sig-abc"},
    {"type": "text", "text": "Looking."},
    {"type": "tool_use", "id": "toolu_1", "name": "hub_list_tasks", "input": {"limit": 5}},
]
CLAUDE_REPLY = {
    "model": "claude-haiku-5-5-20261001",
    "content": CLAUDE_CONTENT,
    "stop_reason": "tool_use",
    "usage": {"input_tokens": 100, "cache_read_input_tokens": 2000, "cache_creation_input_tokens": 300, "output_tokens": 50},
}
CLAUDE_DONE = {
    "model": "claude-haiku-5-5-20261001",
    "content": [{"type": "text", "text": "You have two tasks."}],
    "stop_reason": "end_turn",
    "usage": {"input_tokens": 40, "output_tokens": 8},
}


class _Server:
    """hub-api's ledger routes and the Azure deployments, as one fake HTTP client."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.reserve: Callable[[dict[str, Any]], Any] = lambda body: httpx.Response(200, json={"id": "res-1"})
        self.settle: Callable[[dict[str, Any]], Any] = lambda body: httpx.Response(200, json={"credits": 1.25})
        self.azure: list[Callable[[dict[str, Any]], Any]] = [lambda body: httpx.Response(200, json=GPT_REPLY)]

    async def post(self, url: str, headers: dict[str, str] | None, payload: dict[str, Any]) -> httpx.Response:
        self.calls.append({"url": url, "headers": dict(headers or {}), "json": payload})
        if url == f"{HUB}/api/internal/included/reserve":
            result = self.reserve(payload)
        elif url == f"{HUB}/api/internal/included/settle":
            result = self.settle(payload)
        else:
            handler = self.azure.pop(0) if len(self.azure) > 1 else self.azure[0]
            result = handler(payload)
        if inspect.isawaitable(result):
            result = await result
        if isinstance(result, BaseException):
            raise result
        return result

    def kinds(self) -> list[str]:
        return ["reserve" if call["url"].endswith("/reserve") else "settle" if call["url"].endswith("/settle") else "azure" for call in self.calls]

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [call for call, name in zip(self.calls, self.kinds()) if name == kind]


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> _Server:
    fake = _Server()

    class _Client:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            del args, kwargs

        async def __aenter__(self) -> "_Client":
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def post(self, url: str, headers: dict[str, str] | None = None, json: dict[str, Any] | None = None, **kwargs: Any) -> httpx.Response:
            del kwargs
            return await fake.post(url, headers, json or {})

    async def no_pace(*args: Any) -> float:
        del args
        return 0.0

    real_plan = models.retry_plan
    monkeypatch.setenv("HUB_API_URL", HUB)
    monkeypatch.setenv("ENSEMBLE_INTERNAL_TOKEN", "internal-test-token")
    monkeypatch.setenv("AZURE_FOUNDRY_RESOURCE", "ensemble-ai")
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", KEY)
    monkeypatch.delenv("ENSEMBLE_INCLUDED_MODELS", raising=False)
    monkeypatch.delenv("ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS", raising=False)
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    monkeypatch.setattr(included, "pace", no_pace)
    monkeypatch.setattr(models, "require_verified_user", lambda user_id: None)
    monkeypatch.setattr(models, "retry_plan", lambda error, attempt: None if real_plan(error, attempt) is None else 0.0)
    included._thinking.clear()
    return fake


@pytest.fixture
def claude(server: _Server, monkeypatch: pytest.MonkeyPatch) -> _Server:
    """A Claude deployment on Foundry's Anthropic endpoint. No model in the catalog uses it today."""
    stub = {
        "claude-haiku-5-5": included.IncludedModel("anthropic", "services", "Claude Haiku 5.5", None, ("low", "medium", "high")),
        "claude-sonnet-5-5": included.IncludedModel("anthropic", "services", "Claude Sonnet 5.5", None, ("low", "medium", "high")),
    }
    monkeypatch.setattr(included, "MODELS", {**included.MODELS, **stub})
    server.azure = [lambda body: httpx.Response(200, json=CLAUDE_REPLY)]
    return server


def _frames(body: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    async def collect() -> list[str]:
        return [frame async for frame in stream_with_tools(body)]

    out = []
    for frame in asyncio.run(collect()):
        event = frame.split("\n", 1)[0].removeprefix("event: ")
        out.append((event, json.loads(frame.split("data:", 1)[1])))
    return out


def test_config_follows_hub_api_rules() -> None:
    base = {"AZURE_FOUNDRY_RESOURCE": "ensemble-ai", "AZURE_FOUNDRY_API_KEY": KEY}
    assert included.included_config({}) is None
    assert included.included_config({"AZURE_FOUNDRY_RESOURCE": "ensemble-ai"}) is None
    assert included.included_config({**base, "ENSEMBLE_INCLUDED_MODELS": "OFF"}) is None
    everything = included.included_config(base)
    assert everything is not None
    assert everything.models == ("gpt-6-luna", "deepseek-v4-flash", "gpt-6.1-sol", "grok-4.7")
    assert everything.max_output_tokens == 16000
    raised = included.included_config({**base, "ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS": "32000"})
    assert raised is not None and raised.max_output_tokens == 32000
    for wrong, reason in (("1.5", "whole number"), ("200000", "whole number"), ("0", "positive"), ("lots", "positive")):
        with pytest.raises(included.IncludedConfigError, match=reason):
            included.included_config({**base, "ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS": wrong})
    picked = included.included_config({**base, "ENSEMBLE_INCLUDED_MODELS": " grok-4.7 , gpt-6-luna "})
    assert picked is not None and picked.models == ("gpt-6-luna", "grok-4.7")
    free = included.included_config({**base, "ENSEMBLE_INCLUDED_MODELS": "gpt-4.1-mini,gpt-5-mini"})
    assert free is not None and free.models == ("gpt-5-mini", "gpt-4.1-mini"), "free-account models only when named"
    assert included.included_config({**base, "ENSEMBLE_INCLUDED_MODELS": ","}) is None, "a list with no names offers none, as in hub-api"
    with pytest.raises(included.IncludedConfigError, match="claude-haiku-5-5"):
        included.included_config({**base, "ENSEMBLE_INCLUDED_MODELS": "gpt-6-luna,claude-haiku-5-5"})
    with pytest.raises(included.IncludedConfigError, match="not a URL"):
        included.included_config({**base, "AZURE_FOUNDRY_RESOURCE": "https://ensemble-ai.openai.azure.com"})


def test_gpt_6_luna_goes_to_responses_on_the_openai_host(server: _Server) -> None:
    turn = asyncio.run(
        complete_with_tools(
            {
                "provider": "ensemble",
                "model": "gpt-6-luna",
                "userId": "u1",
                "reasoningEffort": "low",
                "purpose": "Hub chat",
                "fallbackModel": "gpt-6.1-sol",
                "messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "Grüße, 東京 — wie geht's?"}],
                "chatTools": TOOLS,
            }
        )
    )
    assert server.kinds() == ["reserve", "azure", "settle"]
    azure = server.of("azure")[0]
    assert azure["url"] == "https://ensemble-ai.openai.azure.com/openai/v1/responses"
    assert azure["headers"] == {"api-key": KEY}
    sent = azure["json"]
    assert sent["model"] == "gpt-6-luna"
    assert sent["max_output_tokens"] == 16000
    assert sent["reasoning"] == {"effort": "low"}
    assert sent["store"] is False
    assert sent["tools"][0]["name"] == "hub_list_tasks"
    assert not {"temperature", "top_p", "messages"} & set(sent), "always Responses, never chat completions"
    reserve = server.of("reserve")[0]
    assert reserve["headers"] == {"x-ensemble-internal": "internal-test-token", "x-ensemble-user": "u1"}
    assert reserve["json"] == {
        "model": "gpt-6-luna",
        "inputTokens": len(json.dumps(sent, ensure_ascii=False, separators=(",", ":")).encode("utf-8")),
        "maxOutputTokens": 16000,
        "purpose": "Hub chat",
    }
    text = json.dumps(sent, ensure_ascii=False, separators=(",", ":"))
    assert reserve["json"]["inputTokens"] > len(text), "non-ASCII text counts every UTF-8 byte"
    settle = server.of("settle")[0]
    assert settle["headers"]["x-ensemble-user"] == "u1"
    assert settle["json"] == {
        "id": "res-1",
        "usage": {"inputTokens": 5000, "cacheReadTokens": 4000, "cacheWriteTokens": 600, "outputTokens": 20},
        "answeredBy": "gpt-6.1-sol-2026-09-29",
    }
    assert (turn["tokensIn"], turn["tokensOut"], turn["credits"]) == (5000, 20, 1.25)


def test_free_account_models_go_to_responses_and_only_gpt_5_mini_takes_a_level(server: _Server, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENSEMBLE_INCLUDED_MODELS", "gpt-5-mini,gpt-4.1-mini")
    for model, sent_level in (("gpt-5-mini", {"effort": "high"}), ("gpt-4.1-mini", None)):
        asyncio.run(
            complete_with_tools(
                {
                    "provider": "ensemble",
                    "model": model,
                    "userId": "u1",
                    "reasoningEffort": "high",
                    "messages": [{"role": "user", "content": "Hi"}],
                }
            )
        )
        azure = server.of("azure")[-1]
        assert azure["url"] == "https://ensemble-ai.openai.azure.com/openai/v1/responses"
        assert azure["json"]["model"] == model
        assert azure["json"].get("reasoning") == sent_level, model


def test_grok_goes_to_responses_on_the_services_host_with_the_operators_cap(server: _Server, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS", "32000")
    server.azure = [lambda body: httpx.Response(200, json=GROK_REPLY)]
    turn = asyncio.run(
        complete_with_tools({"provider": "ensemble", "model": "grok-4.7", "userId": "u1", "reasoningEffort": "medium", "messages": [{"role": "user", "content": "My tasks?"}], "chatTools": TOOLS})
    )
    azure = server.of("azure")[0]
    assert azure["url"] == "https://ensemble-ai.services.ai.azure.com/openai/v1/responses"
    assert azure["headers"] == {"api-key": KEY}
    assert azure["json"]["max_output_tokens"] == 32000, "the operator's cap is what Azure gets"
    assert azure["json"]["reasoning"] == {"effort": "medium"}
    assert server.of("reserve")[0]["json"]["maxOutputTokens"] == 32000, "and what the reservation holds"
    assert server.of("settle")[0]["json"]["usage"] == {"inputTokens": 900, "cacheReadTokens": 512, "cacheWriteTokens": 0, "outputTokens": 70}
    assert turn["toolCalls"] == [{"id": "call_1", "name": "hub_list_tasks", "arguments": '{"limit":5}'}]
    assert (turn["model"], turn["finishReason"]) == ("grok-4.7", "tool_calls")


def test_a_level_the_model_does_not_take_is_not_sent(server: _Server) -> None:
    asyncio.run(complete_text({"provider": "ensemble", "model": "gpt-6-luna", "userId": "u1", "reasoningEffort": "xhigh", "prompt": "Hi"}))
    assert "reasoning" not in server.of("azure")[0]["json"]


def test_deepseek_goes_to_chat_completions_on_the_services_host(server: _Server) -> None:
    server.azure = [lambda body: httpx.Response(200, json=DEEPSEEK_REPLY)]
    turn = asyncio.run(
        complete_with_tools(
            {
                "provider": "ensemble",
                "model": "deepseek-v4-flash",
                "userId": "u1",
                "reasoningEffort": "high",
                "messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "My tasks?"}],
                "chatTools": TOOLS,
                "responsesMessages": [{"role": "user", "content": "ignored"}],
            }
        )
    )
    azure = server.of("azure")[0]
    assert azure["url"] == "https://ensemble-ai.services.ai.azure.com/openai/v1/chat/completions"
    assert azure["headers"] == {"api-key": KEY}
    sent = azure["json"]
    assert sent["model"] == "deepseek-v4-flash"
    assert sent["messages"] == [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "My tasks?"}]
    assert sent["tools"] == TOOLS
    assert sent["tool_choice"] == "auto"
    assert sent["max_completion_tokens"] == 16000
    assert not {"reasoning_effort", "reasoning", "temperature", "top_p", "response_format", "max_tokens"} & set(sent), "DeepSeek takes no thinking level"
    assert server.of("reserve")[0]["json"]["maxOutputTokens"] == 16000
    assert server.of("settle")[0]["json"]["usage"] == {"inputTokens": 1200, "cacheReadTokens": 1024, "cacheWriteTokens": 0, "outputTokens": 30}
    assert turn["text"] == "Looking."
    assert turn["reasoning"] == "They want tasks."
    assert turn["toolCalls"] == [{"id": "call_9", "name": "hub_list_tasks", "arguments": '{"limit":5}'}]
    assert (turn["model"], turn["tokensIn"], turn["tokensOut"], turn["credits"], turn["cutOff"]) == ("DeepSeek-V4-Flash", 1200, 30, 1.25, False)


def test_deepseek_json_mode_and_its_own_cache_field(server: _Server) -> None:
    reply = {
        "model": "DeepSeek-V4-Flash",
        "choices": [{"message": {"role": "assistant", "content": '{"ok": true}'}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 800, "completion_tokens": 6, "prompt_cache_hit_tokens": 640, "prompt_cache_miss_tokens": 160},
    }
    server.azure = [lambda body: httpx.Response(200, json=reply)]
    result = asyncio.run(complete_text({"provider": "ensemble", "model": "deepseek-v4-flash", "userId": "u1", "system": "Return JSON.", "prompt": "Ok?", "json": True, "temperature": 0}))
    sent = server.of("azure")[0]["json"]
    assert sent["response_format"] == {"type": "json_object"}
    assert "temperature" not in sent
    assert server.of("settle")[0]["json"]["usage"] == {"inputTokens": 800, "cacheReadTokens": 640, "cacheWriteTokens": 0, "outputTokens": 6}
    assert (result["json"], result["credits"]) == ({"ok": True}, 1.25)


def test_gpt_json_mode_reads_back_with_its_credits(server: _Server) -> None:
    result = asyncio.run(
        complete_text({"provider": "ensemble", "model": "gpt-6.1-sol", "userId": "u1", "reasoningEffort": "high", "system": "Return JSON.", "prompt": "Is it ok?", "json": True, "temperature": 0})
    )
    sent = server.of("azure")[0]["json"]
    assert server.of("azure")[0]["url"] == "https://ensemble-ai.openai.azure.com/openai/v1/responses"
    assert sent["text"] == {"format": {"type": "json_object"}}
    assert sent["input"] == [{"role": "system", "content": "Return JSON."}, {"role": "user", "content": "Is it ok?"}]
    assert "temperature" not in sent
    assert result["json"] == {"ok": True}
    assert (result["tokensIn"], result["tokensOut"], result["credits"], result["model"]) == (5000, 20, 1.25, "gpt-6.1-sol-2026-09-29")


def test_a_streamed_included_turn_sends_deltas_then_the_turn(server: _Server) -> None:
    server.azure = [lambda body: httpx.Response(200, json={**GPT_REPLY, "output": [{"type": "message", "content": [{"type": "output_text", "text": "Hello there."}]}]})]
    frames = _frames({"provider": "ensemble", "model": "gpt-6-luna", "userId": "u1", "messages": [{"role": "user", "content": "Hi"}], "chatTools": TOOLS})
    assert "".join(data["text"] for event, data in frames if event == "delta") == "Hello there."
    turns = [data for event, data in frames if event == "turn"]
    assert turns and turns[0]["credits"] == 1.25


def test_a_refused_reservation_never_reaches_azure(server: _Server) -> None:
    refusal = {"code": "included_credits_used", "message": "You've used this month's Ensemble credits.", "error": "You've used this month's Ensemble credits.", "resetsAt": RESETS, "status": 429}
    server.reserve = lambda body: httpx.Response(429, json=refusal)
    frames = _frames({"provider": "ensemble", "model": "grok-4.7", "userId": "u1", "messages": [{"role": "user", "content": "Hi"}]})
    assert frames == [("error", {"message": refusal["message"], "kind": "credits", "status": 429, "code": "included_credits_used", "resetsAt": RESETS})]
    assert server.kinds() == ["reserve"]
    with pytest.raises(included.IncludedLimitError) as refused:
        asyncio.run(complete_with_tools({"provider": "ensemble", "model": "grok-4.7", "userId": "u1", "messages": [{"role": "user", "content": "Hi"}]}))
    error = http_error_for(refused.value)
    assert error.status_code == 429
    assert error.detail == {"message": refusal["message"], "kind": "credits", "status": 429, "code": "included_credits_used", "resetsAt": RESETS}
    paused = {**refusal, "code": "included_paused", "status": 503}
    server.reserve = lambda body: httpx.Response(503, json=paused)
    with pytest.raises(included.IncludedLimitError) as stopped:
        asyncio.run(complete_text({"provider": "ensemble", "model": "deepseek-v4-flash", "userId": "u1", "prompt": "Hi"}))
    assert (stopped.value.code, stopped.value.status, stopped.value.resets_at) == ("included_paused", 503, RESETS)
    assert "azure" not in server.kinds()


@pytest.mark.parametrize(
    "answer",
    [lambda body: httpx.ConnectError("refused"), lambda body: httpx.Response(500, text="boom"), lambda body: httpx.Response(200, json={"nope": True})],
)
def test_the_ledger_failing_closed_means_no_azure_call(server: _Server, answer: Callable[[dict[str, Any]], Any]) -> None:
    server.reserve = answer
    with pytest.raises(included.IncludedLimitError) as failed:
        asyncio.run(complete_text({"provider": "ensemble", "model": "gpt-6-luna", "userId": "u1", "prompt": "Hi"}))
    assert failed.value.to_dict() == {"message": included.CHECK_FAILED, "kind": "credits", "status": 503, "code": "included_unavailable", "resetsAt": None}
    assert server.kinds() == ["reserve"]


def test_a_provider_error_after_retries_settles_at_zero(server: _Server) -> None:
    server.azure = [lambda body: httpx.Response(500, json={"error": {"message": "Internal server error"}})]
    with pytest.raises(ProviderError) as failed:
        asyncio.run(complete_with_tools({"provider": "ensemble", "model": "deepseek-v4-flash", "userId": "u1", "messages": [{"role": "user", "content": "Hi"}]}))
    assert failed.value.status == 500
    assert server.kinds() == ["reserve", "azure", "azure", "azure", "settle"], "one reservation covers the retries"
    assert server.of("settle")[0]["json"] == {"id": "res-1", "usage": {"inputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 0}}


def test_claude_goes_to_foundrys_messages_endpoint_and_reports_every_input_token(claude: _Server) -> None:
    turn = asyncio.run(
        complete_with_tools(
            {
                "provider": "ensemble",
                "model": "claude-haiku-5-5",
                "userId": "u1",
                "reasoningEffort": "low",
                "messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "My tasks?"}],
                "chatTools": TOOLS,
            }
        )
    )
    azure = claude.of("azure")[0]
    assert azure["url"] == "https://ensemble-ai.services.ai.azure.com/anthropic/v1/messages"
    assert azure["headers"]["api-key"] == KEY
    assert azure["headers"]["anthropic-version"] == "2023-06-01"
    assert not {"x-api-key", "authorization"} & {name.lower() for name in azure["headers"]}
    sent = azure["json"]
    assert sent["max_tokens"] == 16000
    assert sent["output_config"] == {"effort": "low"}
    assert sent["system"] == "Be brief."
    assert sent["tools"][0]["input_schema"]["properties"]["limit"] == {"type": "integer"}
    assert not {"temperature", "top_p", "thinking"} & set(sent)
    assert claude.of("settle")[0]["json"] == {
        "id": "res-1",
        "usage": {"inputTokens": 2400, "cacheReadTokens": 2000, "cacheWriteTokens": 300, "outputTokens": 50},
        "answeredBy": "claude-haiku-5-5-20261001",
    }
    assert (turn["tokensIn"], turn["tokensOut"], turn["credits"], turn["finishReason"]) == (2400, 50, 1.25, "tool_use")


def test_thinking_blocks_go_back_to_claude_on_the_next_tool_round(claude: _Server) -> None:
    first = asyncio.run(complete_with_tools({"provider": "ensemble", "model": "claude-haiku-5-5", "userId": "u1", "messages": [{"role": "user", "content": "My tasks?"}], "chatTools": TOOLS}))
    echoed = first["raw"]["choices"][0]["message"]
    history = [
        {"role": "user", "content": "My tasks?"},
        {"role": "assistant", "content": echoed["content"], "tool_calls": echoed["tool_calls"]},
        {"role": "tool", "tool_call_id": "toolu_1", "name": "hub_list_tasks", "content": "[]"},
    ]
    claude.azure = [lambda body: httpx.Response(200, json=CLAUDE_DONE)]
    asyncio.run(complete_with_tools({"provider": "ensemble", "model": "claude-haiku-5-5", "userId": "u1", "messages": history, "chatTools": TOOLS}))
    sent = claude.of("azure")[1]["json"]["messages"]
    assert sent[1] == {"role": "assistant", "content": CLAUDE_CONTENT}, "the turn goes back exactly as Claude wrote it, signature included"
    assert sent[2]["content"][0] == {"type": "tool_result", "tool_use_id": "toolu_1", "content": "[]"}
    asyncio.run(complete_with_tools({"provider": "ensemble", "model": "claude-haiku-5-5", "userId": "u2", "messages": history, "chatTools": TOOLS}))
    other = claude.of("azure")[2]["json"]["messages"][1]["content"]
    assert [block["type"] for block in other] == ["text", "tool_use"], "another account never gets this account's turn"


def test_a_thinking_refusal_retries_once_without_thinking_on_the_same_reservation(claude: _Server) -> None:
    included.remember_turn("u1", CLAUDE_CONTENT)
    refusal = {"type": "error", "error": {"type": "invalid_request_error", "message": "messages.1.content.0: Invalid `signature` in `thinking` block"}}
    claude.azure = [lambda body: httpx.Response(400, json=refusal), lambda body: httpx.Response(200, json=CLAUDE_DONE)]
    history = [
        {"role": "user", "content": "My tasks?"},
        {"role": "assistant", "content": "Looking.", "tool_calls": [{"id": "toolu_1", "type": "function", "function": {"name": "hub_list_tasks", "arguments": '{"limit": 5}'}}]},
        {"role": "tool", "tool_call_id": "toolu_1", "content": "[]"},
    ]
    turn = asyncio.run(complete_with_tools({"provider": "ensemble", "model": "claude-haiku-5-5", "userId": "u1", "messages": history}))
    assert claude.kinds() == ["reserve", "azure", "azure", "settle"]
    tried, retried = (call["json"] for call in claude.of("azure"))
    assert tried["messages"][1]["content"][0]["type"] == "thinking"
    assert "thinking" not in tried
    assert [block["type"] for block in retried["messages"][1]["content"]] == ["text", "tool_use"]
    assert retried["thinking"] == {"type": "disabled"}
    assert turn["text"] == "You have two tasks."
    assert claude.of("settle")[0]["json"]["usage"]["inputTokens"] == 40
    sonnet = included.without_thinking({"model": "claude-sonnet-5-5", "messages": [{"role": "assistant", "content": [CLAUDE_CONTENT[0]]}]})
    assert sonnet["thinking"] == {"type": "between_tools"}
    assert sonnet["messages"][0]["content"] == [{"type": "text", "text": ""}]


def test_a_400_about_something_else_is_not_retried(claude: _Server) -> None:
    claude.azure = [lambda body: httpx.Response(400, json={"type": "error", "error": {"type": "invalid_request_error", "message": "prompt is too long"}})]
    with pytest.raises(ProviderError):
        asyncio.run(complete_with_tools({"provider": "ensemble", "model": "claude-haiku-5-5", "userId": "u1", "messages": [{"role": "user", "content": "Hi"}]}))
    assert claude.kinds() == ["reserve", "azure", "settle"]


def test_a_thinking_400_from_a_non_claude_model_is_not_retried(server: _Server) -> None:
    server.azure = [lambda body: httpx.Response(400, json={"error": {"message": "Invalid thinking signature"}})]
    with pytest.raises(ProviderError):
        asyncio.run(complete_with_tools({"provider": "ensemble", "model": "grok-4.7", "userId": "u1", "messages": [{"role": "user", "content": "Hi"}]}))
    assert server.kinds() == ["reserve", "azure", "settle"]


@pytest.mark.parametrize("answer", [lambda body: httpx.Response(500, text="down"), lambda body: httpx.ConnectError("refused")])
def test_a_failed_settlement_still_returns_the_turn(server: _Server, answer: Callable[[dict[str, Any]], Any]) -> None:
    server.settle = answer
    turn = asyncio.run(complete_with_tools({"provider": "ensemble", "model": "gpt-6-luna", "userId": "u1", "messages": [{"role": "user", "content": "Hi"}]}))
    assert turn["credits"] is None
    assert turn["text"] == '{"ok": true}'


def test_a_cancelled_call_settles_without_usage(server: _Server) -> None:
    started = asyncio.Event()

    async def hang(body: dict[str, Any]) -> httpx.Response:
        del body
        started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    server.azure = [hang]

    async def run() -> None:
        call = asyncio.create_task(complete_text({"provider": "ensemble", "model": "gpt-6-luna", "userId": "u1", "prompt": "Hi"}))
        await started.wait()
        call.cancel()
        with pytest.raises(asyncio.CancelledError):
            await call
        await asyncio.gather(*included._settling)

    asyncio.run(run())
    assert server.kinds() == ["reserve", "azure", "settle"]
    assert server.of("settle")[0]["json"] == {"id": "res-1", "usage": None}


def test_included_needs_the_server_set_up(server: _Server, monkeypatch: pytest.MonkeyPatch) -> None:
    body = {"provider": "ensemble", "model": "gpt-6-luna", "userId": "u1", "prompt": "Hi"}
    monkeypatch.setenv("ENSEMBLE_INCLUDED_MODELS", "grok-4.7")
    with pytest.raises(included.IncludedLimitError, match=r"GPT-6 Luna \(2026-09-22\) is not offered"):
        asyncio.run(complete_text(body))
    monkeypatch.setenv("ENSEMBLE_INCLUDED_MODELS", "gpt-7")
    with pytest.raises(included.IncludedLimitError) as misconfigured:
        asyncio.run(complete_text(body))
    assert misconfigured.value.message == no_key_message("ensemble")
    monkeypatch.delenv("ENSEMBLE_INCLUDED_MODELS")
    monkeypatch.delenv("AZURE_FOUNDRY_API_KEY")
    with pytest.raises(included.IncludedLimitError) as missing:
        asyncio.run(complete_text(body))
    assert (missing.value.code, missing.value.status) == ("included_unavailable", 503)
    assert server.calls == []


def test_ensemble_is_named_but_never_a_stored_credential() -> None:
    assert no_key_message("ensemble") == "Included AI is not set up on this server. Add your own API key or AI plan in Settings → Models."
    assert PROVIDER_NAMES["ensemble"] == "Ensemble"
    assert "ensemble" not in credentials.PROVIDERS
    assert _public_failure(included.IncludedLimitError("included_paused", "Paused.", RESETS)) == {
        "message": "Paused.",
        "kind": "credits",
        "status": 429,
        "code": "included_paused",
        "resetsAt": RESETS,
    }
    assert included.anthropic_usage({"input_tokens": 3}) == {"inputTokens": 3, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 0}
    assert included.responses_usage(None) == {"inputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 0}
    assert included.chat_usage({"prompt_tokens": 5}) == {"inputTokens": 5, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 0}
