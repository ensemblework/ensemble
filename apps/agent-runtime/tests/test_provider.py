"""Provider errors, retries, and the mock model. No network."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from ensemble_agent import credentials
from ensemble_agent.main import http_error_for
from ensemble_agent.models import (
    ModelAuthError,
    _effort,
    _endpoint,
    _from_openai,
    _raise_fixture_error,
    _with_model_fallback,
    apply_stream_event,
    build_chat_payload,
    chat_payload,
    complete_text,
    complete_with_tools,
    feed_sse,
    new_stream_state,
    post_with_retry,
    retry_plan,
    stream_state_to_completion,
    stream_with_tools,
    text_chunks,
)
from ensemble_agent.rate_limit import reserve_delay, reset_buckets
from ensemble_agent.provider_error import (
    ProviderError,
    annotate_models,
    friendly_key_error,
    parse_provider_error,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _body(name: str) -> str:
    return (FIXTURES / name).read_text()


def test_parse_gemini_error_message_quota_and_retry() -> None:
    error = parse_provider_error(429, _body("gemini_error.json"), None)
    assert "exceeded your current quota" in error.message
    assert error.quota_id == "GenerateRequestsPerDayPerProjectPerModel"
    assert error.retry_after_seconds == 2
    assert error.kind == "quota"
    assert "GenerateRequestsPerDayPerProjectPerModel" in error.message
    assert "2s" in error.message
    assert "status=429" in str(error)
    assert "kind=quota" in str(error)
    assert "retryAfter=" in str(error)


def test_retry_after_header_sets_seconds() -> None:
    error = parse_provider_error(429, _body("rate_limit_429.json"), {"Retry-After": "2"})
    assert error.retry_after_seconds == 2
    # Google puts RESOURCE_EXHAUSTED on quota misses. That kind is never retried.
    assert error.kind == "quota"
    assert retry_plan(error, 0) is None
    error_folded = parse_provider_error(429, "{}", {"retry-after": "2.5"})
    assert error_folded.retry_after_seconds == 2.5


def test_retry_after_http_date_in_the_past_is_zero() -> None:
    error = parse_provider_error(429, "{}", {"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"})
    assert error.retry_after_seconds == 0


def test_quota_style_429() -> None:
    per_day = parse_provider_error(
        429,
        json.dumps({"error": {"message": "GenerateRequestsPerDay limit reached"}}),
        None,
    )
    assert per_day.kind == "quota"
    limit_zero = parse_provider_error(
        429,
        json.dumps(
            {
                "error": {
                    "message": "You exceeded your current quota, please check your plan and billing details.",
                    "details": [
                        {
                            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                            "violations": [{"quotaId": "GenerateRequests", "quotaValue": "0"}],
                        }
                    ],
                }
            }
        ),
        None,
    )
    assert limit_zero.kind == "quota"
    free_tier = parse_provider_error(
        429,
        json.dumps(
            {
                "error": {
                    "message": "free_tier exhausted",
                    "details": [
                        {
                            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                            "violations": [
                                {
                                    "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                                    "quotaValue": "0",
                                }
                            ],
                        }
                    ],
                }
            }
        ),
        None,
    )
    assert free_tier.kind == "quota"
    assert free_tier.quota_id == "generativelanguage.googleapis.com/generate_content_free_tier_requests"
    assert parse_provider_error(429, "quota limit 0 for this model", None).kind == "quota"
    prose = parse_provider_error(
        429,
        json.dumps({"error": {"message": "You exceeded your current quota, please retry."}}),
        None,
    )
    assert prose.kind == "rate_limit"


def test_retry_delay_fractional_seconds() -> None:
    body = json.dumps(
        {
            "error": {
                "message": "slow",
                "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "2.5s"}],
            }
        }
    )
    assert parse_provider_error(503, body, None).retry_after_seconds == 2.5
    assert parse_provider_error(503, _body("unavailable_503.json"), None).kind == "unavailable"
    assert "high demand" in parse_provider_error(503, _body("unavailable_503.json"), None).message


def test_status_kinds() -> None:
    assert parse_provider_error(401, "{}", None).kind == "auth"
    assert parse_provider_error(403, "{}", None).kind == "auth"
    assert parse_provider_error(404, "{}", None).kind == "not_found"
    assert parse_provider_error(400, "{}", None).kind == "invalid"
    assert parse_provider_error(500, "{}", None).kind == "other"
    assert parse_provider_error(502, "{}", None).kind == "unavailable"


def test_long_message_keeps_quota_and_retry() -> None:
    body = json.dumps(
        {
            "error": {
                "message": "x" * 2000,
                "details": [
                    {
                        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                        "violations": [{"quotaId": "GenerateRequestsPerDay"}],
                    },
                    {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "2s"},
                ],
            }
        }
    )
    error = parse_provider_error(429, body, None)
    assert len(error.message) <= 800
    assert "GenerateRequestsPerDay" in error.message
    assert "2s" in error.message


def test_fallback_model_is_one_shot_after_503() -> None:
    async def call(chosen: str, allow_retry: bool) -> dict:
        assert chosen == "gemini-3.5-flash"
        assert allow_retry is True
        raise ProviderError(503, "unavailable", "high demand")

    with pytest.raises(ProviderError) as busy:
        asyncio.run(_with_model_fallback({"fallbackModel": "gemini-3.5-flash-lite"}, "gemini-3.5-flash", call))
    assert busy.value.status == 503

    async def lite(chosen: str, _allow_retry: bool) -> dict:
        assert chosen == "gemini-3.5-flash-lite"
        raise ProviderError(503, "unavailable", "high demand")

    with pytest.raises(ProviderError) as lite_busy:
        asyncio.run(_with_model_fallback({"fallbackModel": "gemini-3.5-flash"}, "gemini-3.5-flash-lite", lite))
    assert lite_busy.value.status == 503

    async def quota(_chosen: str, _allow_retry: bool) -> dict:
        raise ProviderError(429, "quota", "GenerateRequestsPerDay")

    with pytest.raises(ProviderError) as caught:
        asyncio.run(_with_model_fallback({"fallbackModel": "other"}, "gemini-3.5-flash", quota))
    assert caught.value.kind == "quota"


def test_mock_fixture_error_object_raises() -> None:
    with pytest.raises(ProviderError) as caught:
        _raise_fixture_error(
            {
                "error": {
                    "status": 429,
                    "kind": "quota",
                    "message": "out of quota",
                    "quotaId": "GenerateRequestsPerDay",
                    "retryAfterSeconds": 3,
                }
            }
        )
    assert caught.value.status == 429
    assert caught.value.kind == "quota"
    assert caught.value.quota_id == "GenerateRequestsPerDay"
    assert caught.value.retry_after_seconds == 3


def test_effort_minimal_depends_on_gemini_generation() -> None:
    assert _effort("google", "minimal", "gemini-3.5-flash") == "minimal"
    assert _effort("google", "minimal", "gemini-2.5-flash") == "low"
    assert _effort("google", "default", "gemini-3.5-flash") is None
    assert _effort("google", None, "gemini-3.5-flash") is None
    assert _effort("openai", "minimal", "gpt-4.1-mini") == "minimal"


def test_temperature_omitted_for_gemini_3() -> None:
    gemini3 = build_chat_payload("gemini-3.5-flash", "google", [], temperature=0, reasoning_effort="minimal")
    assert "temperature" not in gemini3
    assert gemini3["reasoning_effort"] == "minimal"
    older = chat_payload("gemini-2.5-flash", "google", [{"role": "user", "content": "hi"}], temperature=0, reasoning_effort="minimal")
    assert older["temperature"] == 0
    assert older["reasoning_effort"] == "low"
    assert "temperature" not in build_chat_payload("gemini-3.5-flash", "google", [])


def test_retry_plan_budgets() -> None:
    unavailable = ProviderError(503, "unavailable", "high demand")
    delay = retry_plan(unavailable, 0)
    assert delay is not None
    assert 0.4 <= delay <= 0.65
    assert retry_plan(unavailable, 2) is not None
    assert retry_plan(unavailable, 3) is None
    assert retry_plan(ProviderError(500, "other", "boom"), 2) is None
    assert retry_plan(ProviderError(429, "quota", "out", retry_after_seconds=1), 0) is None
    assert retry_plan(ProviderError(400, "invalid", "nope"), 0) is None
    capped = retry_plan(ProviderError(503, "unavailable", "wait", retry_after_seconds=120), 0)
    assert capped == 60
    header = retry_plan(ProviderError(429, "rate_limit", "slow", retry_after_seconds=2), 0)
    assert header == 2
    assert retry_plan(ProviderError(429, "rate_limit", "slow"), 0) is None
    exhausted = parse_provider_error(
        429,
        json.dumps({"error": {"status": "RESOURCE_EXHAUSTED", "message": "Resource exhausted."}}),
        None,
    )
    assert exhausted.kind == "quota"
    assert retry_plan(exhausted, 0) is None
    assert retry_plan(ProviderError(429, "quota", "RESOURCE_EXHAUSTED", retry_after_seconds=30), 0) is None


def test_post_with_retry_succeeds_after_two_503s() -> None:
    body = _body("unavailable_503.json")
    calls = {"n": 0}
    delays: list[float] = []

    async def send(_payload: dict) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(503, text=body)
        return httpx.Response(200, json={"ok": True})

    async def pause(seconds: float) -> None:
        delays.append(seconds)

    response = asyncio.run(post_with_retry(send, {"model": "gemini-3.5-flash"}, sleep=pause))
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert calls["n"] == 3
    assert len(delays) == 2
    assert delays[0] >= 0.4
    assert delays[1] >= 1.2


def test_post_with_retry_does_not_retry_quota_or_plain_400() -> None:
    async def quota(_payload: dict) -> httpx.Response:
        return httpx.Response(429, text=json.dumps({"error": {"message": "GenerateRequestsPerDay"}}))

    with pytest.raises(ProviderError) as quota_error:
        asyncio.run(post_with_retry(quota, {"model": "gemini-3.5-flash"}, sleep=_no_sleep))
    assert quota_error.value.kind == "quota"

    seen: list[dict] = []

    async def bad_request(payload: dict) -> httpx.Response:
        seen.append(payload)
        return httpx.Response(400, json={"error": {"message": "bad request"}})

    with pytest.raises(ProviderError) as invalid:
        asyncio.run(post_with_retry(bad_request, {"model": "m", "reasoning_effort": "low"}, sleep=_no_sleep))
    assert invalid.value.kind == "invalid"
    assert len(seen) == 1


def test_post_with_retry_strips_reasoning_effort_only_when_the_error_mentions_it() -> None:
    seen: list[dict] = []

    async def send(payload: dict) -> httpx.Response:
        seen.append(dict(payload))
        if "reasoning_effort" in payload:
            return httpx.Response(400, text='{"error":{"message":"unknown parameter reasoning_effort"}}')
        return httpx.Response(200, json={"ok": True})

    response = asyncio.run(post_with_retry(send, {"model": "gemini-2.5-flash", "reasoning_effort": "low"}, sleep=_no_sleep))
    assert response.status_code == 200
    assert "reasoning_effort" in seen[0]
    assert "reasoning_effort" not in seen[1]


def test_tool_call_fixture_parses_and_mock_returns_it_without_network() -> None:
    parsed = _from_openai(json.loads(_body("tool_call.json")), "mock")
    assert parsed["toolCalls"][0]["name"] == "hub_list_tasks"
    assert parsed["toolCalls"][0]["arguments"] == '{"status":"open"}'
    assert parsed["text"] == "Listing open tasks."

    result = asyncio.run(
        complete_with_tools(
            {
                "provider": "mock",
                "model": "ignored",
                "mockFixture": "tool_call",
                "messages": [{"role": "user", "content": "list tasks"}],
            }
        )
    )
    assert result["toolCalls"][0]["name"] == "hub_list_tasks"
    message = result["raw"]["choices"][0]["message"]
    assert message["tool_calls"][0]["function"]["name"] == "hub_list_tasks"
    assert result["model"] == "mock-model"
    assert result["tokensIn"] == 20
    assert result["tokensOut"] == 10

    tagged = asyncio.run(
        complete_with_tools(
            {
                "provider": "mock",
                "messages": [{"role": "user", "content": "please [[fixture:tool_call]] now"}],
            }
        )
    )
    assert tagged["toolCalls"][0]["name"] == "hub_list_tasks"


def test_mock_default_answer_and_complete_text() -> None:
    result = asyncio.run(complete_with_tools({"provider": "mock", "messages": [{"role": "user", "content": "hi"}]}))
    assert result["text"] == "Mock answer."
    assert result["toolCalls"] == []
    assert result["raw"]["choices"][0]["message"]["content"] == "Mock answer."
    text = asyncio.run(complete_text({"provider": "mock", "model": "mock", "prompt": "hi"}))
    assert text["text"] == "Mock answer."
    assert text["model"] == "mock"


def test_mock_stream_splits_text_and_missing_fixture_is_an_error_event() -> None:
    long_text = "a" * 50
    assert text_chunks(long_text) == ["a" * 24, "a" * 24, "aa"]

    async def collect(body: dict) -> list[str]:
        return [frame async for frame in stream_with_tools(body)]

    frames = asyncio.run(collect({"provider": "mock", "messages": [{"role": "user", "content": "hello"}]}))
    assert frames[0].startswith("event: delta\n")
    assert frames[-1].startswith("event: turn\n")
    text = "".join(json.loads(frame.split("data: ", 1)[1])["text"] for frame in frames if frame.startswith("event: delta\n"))
    assert text == "Mock answer."
    turn = json.loads(frames[-1].split("data: ", 1)[1])
    assert turn["text"] == "Mock answer."
    assert "\n\n" in frames[0]

    missing = asyncio.run(collect({"provider": "mock", "mockFixture": "does-not-exist"}))
    assert len(missing) == 1
    assert missing[0].startswith("event: error\n")
    payload = json.loads(missing[0].split("data: ", 1)[1])
    assert payload["kind"] == "not_found"
    assert payload["status"] == 404
    assert "message" in payload


def test_stream_assembles_tool_call_deltas() -> None:
    block = "\n".join(
        [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"hub_list_tasks","arguments":""}}]}}]}',
            'data: {"choices":[{"delta":{"content":"ok","tool_calls":[{"index":0,"function":{"arguments":"{\\"status\\":"}}]}}]}',
            'data: {"model":"mock-model","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"open\\"}"}}]}}]}',
            "data: [DONE]",
            'data: {"choices":[{"delta":{"content":"ignored"}}]}',
        ]
    )
    state = new_stream_state()
    deltas = feed_sse(state, block)
    assert deltas == ["ok"]
    parsed = _from_openai(stream_state_to_completion(state, "mock"), "mock")
    assert parsed["text"] == "ok"
    assert parsed["toolCalls"][0]["name"] == "hub_list_tasks"
    assert parsed["toolCalls"][0]["arguments"] == '{"status":"open"}'
    assert parsed["model"] == "mock-model"
    apply_stream_event(state, {"choices": [{"delta": {"reasoning_content": "think"}}]})
    assert stream_state_to_completion(state, "mock")["choices"][0]["message"]["reasoning_content"] == "think"


def _replay_stream(events: list[dict]) -> tuple[list[dict], str]:
    state = new_stream_state()
    pieces: list[str] = []
    for event in events:
        piece = apply_stream_event(state, event)
        if piece:
            pieces.append(piece)
    message = stream_state_to_completion(state, "mock")["choices"][0]["message"]
    return message["tool_calls"], "".join(pieces)


def _parsed_args(raw: str) -> object:
    try:
        return json.loads(raw or "{}")
    except json.JSONDecodeError:
        return raw


def _call_brief(calls: list[dict]) -> list[tuple[str, str, object]]:
    return [(call["id"], call["function"]["name"], _parsed_args(call["function"]["arguments"])) for call in calls]


def test_parallel_streamed_tool_calls_stay_separate() -> None:
    """Parallel calls must not collapse, including two calls that share a name.

    The OpenAI-style and Gemini-part cases live in
    tests/fixtures/parallel_tool_stream.json. The Anthropic content blocks in
    that file are synthetic: there are no real Anthropic captures.
    """
    recorded = json.loads((Path(__file__).parent / "fixtures" / "parallel_tool_stream.json").read_text())
    expected = [
        ("call_a", "hub_update_task", {"id": "a"}),
        ("call_b", "hub_update_task", {"id": "b"}),
    ]
    for name in ("sameNameWithoutIndex", "sameChunkWithoutIndex", "idFragments", "openaiIndexes"):
        calls, text = _replay_stream(recorded[name])
        assert _call_brief(calls) == expected, name
        if name == "openaiIndexes":
            assert text == "Moving both."

    unnamed, _text = _replay_stream(recorded["nameStartsNewCall"])
    assert [(call["function"]["name"], _parsed_args(call["function"]["arguments"])) for call in unnamed] == [
        ("hub_update_task", {"id": "a"}),
        ("hub_update_task", {"id": "b"}),
    ]

    for name in ("geminiParts", "geminiPartsOneChunk"):
        calls, text = _replay_stream(recorded[name])
        assert len(calls) == 2, name
        assert [call["function"]["name"] for call in calls] == ["hub_update_task", "hub_update_task"]
        assert [call["function"]["arguments"] for call in calls] == ['{"id":"a"}', '{"id":"b"}']
        assert [_parsed_args(call["function"]["arguments"]) for call in calls] == [{"id": "a"}, {"id": "b"}]
        assert [call["extra_content"]["google"]["thought_signature"] for call in calls] == ["sig-a", "sig-b"]
        if name == "geminiParts":
            assert text == "Moving both."

    repeated, _text = _replay_stream(recorded["geminiRepeatedPart"])
    assert [(call["function"]["name"], _parsed_args(call["function"]["arguments"])) for call in repeated] == [
        ("hub_update_task", {"id": "a"}),
        ("hub_update_task", {"id": "b"}),
    ]
    assert [call["extra_content"]["google"]["thought_signature"] for call in repeated] == ["sig-a", "sig-b"]

    # Synthetic Anthropic stream. There is no real Anthropic capture on this project.
    calls, text = _replay_stream(recorded["anthropicBlocks"])
    assert _call_brief(calls) == [
        ("toolu_a", "hub_update_task", {"id": "a"}),
        ("toolu_b", "hub_update_task", {"id": "b"}),
    ], "synthetic Anthropic fixture"
    assert text == "Moving both."


def test_streamed_tool_call_followups() -> None:
    """Id wins over index, and a repeated id replaces only a finished object.

    The three Gemini cases are real gemini-3.5-flash-lite OpenAI-compatible
    captures (PR #70). Each call arrives whole, with its own id and no
    tool-call index. The thought signature is only on the first call.
    """
    recorded = json.loads((FIXTURES / "stream_tool_followups.json").read_text())

    def replay(name: str) -> list[dict]:
        calls, _text = _replay_stream(recorded[name])
        return calls

    def signature(call: dict) -> str:
        extra = call.get("extra_content") or {}
        google = extra.get("google") or {}
        return str(google.get("thought_signature") or "")

    two = replay("twoTools")
    assert _call_brief(two) == [
        ("call_1476450", "hub_list_tasks", {}),
        ("call_1476453", "hub_list_projects", {}),
    ]
    assert signature(two[0]) and not signature(two[1])

    diff = replay("sameToolDiffArgs")
    assert _call_brief(diff) == [
        ("call_2608831", "hub_create_task", {"title": "Buy milk"}),
        ("call_2608832", "hub_create_task", {"title": "Call mom"}),
    ]
    assert signature(diff[0]) and not signature(diff[1])

    same = replay("sameToolSameArgs")
    assert _call_brief(same) == [
        ("call_1313370", "hub_create_task", {"title": "Untitled"}),
        ("call_1313373", "hub_create_task", {"title": "Untitled"}),
    ]
    assert same[0]["id"] != same[1]["id"]
    assert signature(same[0]) and not signature(same[1])

    resent = replay("sameIdResend")
    assert len(resent) == 1
    assert resent[0]["id"] == "call_1"
    assert resent[0]["function"]["name"] == "hub_create_task"
    assert resent[0]["function"]["arguments"] == '{"title":"B"}'

    fragments = replay("sameIdFragments")
    assert len(fragments) == 1
    assert fragments[0]["function"]["name"] == "hub_create_task"
    assert fragments[0]["function"]["arguments"] == '{"title":"Buy milk"}'

    placeholder = replay("emptyObjectThenFragments")
    assert len(placeholder) == 1
    assert placeholder[0]["function"]["name"] == "hub_create_task"
    assert placeholder[0]["function"]["arguments"] == '{"title":"Milk"}'

    indexed = replay("sameIndexDifferentIds")
    assert [(call["id"], call["function"]["name"], call["function"]["arguments"]) for call in indexed] == [
        ("call_a", "hub_list_tasks", '{"x":'),
        ("call_b", "hub_list_projects", '{"y":1}'),
    ]

    mixed = replay("mixedIndexAndId")
    assert _call_brief(mixed) == [
        ("call_a", "hub_list_tasks", {"status": "open"}),
        ("call_b", "hub_create_task", {"title": "B"}),
        ("call_c", "hub_list_projects", {}),
    ]

    blank = replay("blankFunctionCallId")
    assert [(call["id"], call["function"]["name"], call["function"]["arguments"]) for call in blank] == [
        ("part_7", "hub_list_tasks", "{}"),
        ("call_real", "hub_list_projects", '{"q":1}'),
    ]


def test_stream_keeps_gemini_thought_signature() -> None:
    signature = "sig-abc"
    block = "\n".join(
        [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_sig","type":"function","extra_content":{"google":{"thought_signature":"'
            + signature
            + '"}},"function":{"name":"hub_list_tasks","arguments":""}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"extra_content":{"google":{"thought_signature":"'
            + signature
            + '"}},"function":{"arguments":"{}"}}]}}]}',
            "data: [DONE]",
        ]
    )
    state = new_stream_state()
    feed_sse(state, block)
    message = stream_state_to_completion(state, "gemini-3.5-flash")["choices"][0]["message"]
    call = message["tool_calls"][0]
    assert call["function"]["name"] == "hub_list_tasks"
    assert call["extra_content"]["google"]["thought_signature"] == signature
    parsed = _from_openai(stream_state_to_completion(state, "gemini-3.5-flash"), "gemini-3.5-flash")
    echoed = parsed["raw"]["choices"][0]["message"]["tool_calls"][0]["extra_content"]
    assert echoed["google"]["thought_signature"] == signature


def test_annotate_models_keeps_high_demand_available() -> None:
    rows = annotate_models(
        ["gemini-3.5-flash", "gemini-3.1-pro", "gemini-2.5-pro"],
        [
            {"model": "gemini-3.1-pro", "kind": "not_found", "detail": "not available to new users"},
            {"model": "gemini-2.5-pro", "kind": "unavailable", "detail": "high demand"},
            {"model": "missing", "kind": "quota", "detail": "no quota on this key"},
        ],
    )
    by_id = {row["id"]: row for row in rows}
    assert by_id["gemini-3.5-flash"] == {"id": "gemini-3.5-flash", "available": True, "reason": None}
    assert by_id["gemini-3.1-pro"]["available"] is False
    assert by_id["gemini-3.1-pro"]["reason"] == "not available to new users"
    assert by_id["gemini-2.5-pro"]["available"] is True
    assert by_id["gemini-2.5-pro"]["reason"] == "high demand"
    quota_rows = annotate_models(["pro"], [{"model": "pro", "kind": "quota", "detail": "no quota on this key"}])
    assert quota_rows[0]["available"] is False
    assert quota_rows[0]["reason"] == "no quota on this key"


def test_friendly_key_error_hides_the_url() -> None:
    google = friendly_key_error("google", 401, "https://generativelanguage.googleapis.com/v1beta/models")
    assert google == "Google rejected this key (check it was copied fully and the Generative Language API is enabled)."
    assert "http" not in google.lower()
    openai = friendly_key_error("openai", 403, "https://api.openai.com/v1/models")
    assert openai == "OpenAI rejected this key (check it was copied fully)."
    assert "http" not in openai.lower()
    assert "http" not in friendly_key_error("anthropic", 500, "https://api.anthropic.com/v1/models")


def test_http_error_for_provider_and_decrypt() -> None:
    http = http_error_for(ProviderError(429, "rate_limit", "slow down", retry_after_seconds=2, quota_id=None))
    assert http.status_code == 429
    assert http.detail["message"] == "slow down"
    assert http.detail["kind"] == "rate_limit"
    assert http.detail["retryAfterSeconds"] == 2
    assert http.detail["quotaId"] is None
    assert http_error_for(ProviderError(500, "other", "boom")).status_code == 502
    assert http_error_for(ProviderError(404, "not_found", "gone")).status_code == 404
    auth = http_error_for(ModelAuthError("No key for google."))
    assert auth.status_code == 503
    assert auth.detail == "No key for google."
    decrypt = http_error_for(credentials.DecryptError())
    assert decrypt.status_code == 409
    assert decrypt.detail == credentials.DECRYPT_MESSAGE


def test_resolve_mock_does_not_touch_the_database(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom():
        raise AssertionError("database")

    monkeypatch.setattr(credentials, "_connect", boom)
    cred = credentials.resolve("user-1", "mock")
    assert cred.secret == "mock"
    assert cred.source == "you"
    assert cred.provider == "mock"
    assert "mock" not in credentials.PROVIDERS


def test_stored_key_decrypt_failure_is_decrypt_error(monkeypatch: pytest.MonkeyPatch) -> None:
    class Conn:
        def execute(self, *_args, **_kwargs):
            return self

        def fetchone(self):
            return ("v1:not-a-real-cipher", None)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(credentials, "_connect", lambda: Conn())

    def bad(_value: str) -> str:
        from cryptography.exceptions import InvalidTag

        raise InvalidTag()

    monkeypatch.setattr(credentials, "decrypt", bad)
    with pytest.raises(credentials.DecryptError) as caught:
        credentials._stored("user-1", "google")
    assert str(caught.value) == credentials.DECRYPT_MESSAGE


def test_endpoint_translates_decrypt_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def explode(_user, _provider):
        raise credentials.DecryptError()

    monkeypatch.setattr(credentials, "resolve", explode)
    with pytest.raises(ModelAuthError) as caught:
        asyncio.run(_endpoint("google", "user-1", None))
    assert str(caught.value) == credentials.DECRYPT_MESSAGE


async def _no_sleep(_seconds: float) -> None:
    return None


def test_parallel_tool_error_is_a_valid_gemini_turn() -> None:
    signature = "sig-parallel"
    block = "\n".join(
        [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","type":"function","function":{"name":"hub_update_task","arguments":"{\\"projectName\\":\\"Core Platform\\"}"}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_ok","type":"function","extra_content":{"google":{"thought_signature":"'
            + signature
            + '"}},"function":{"name":"hub_update_task","arguments":"{}"}}]}}]}',
            "data: [DONE]",
        ]
    )
    state = new_stream_state()
    feed_sse(state, block)
    message = stream_state_to_completion(state, "gemini-3.5-flash")["choices"][0]["message"]
    history = [
        {"role": "user", "content": "Move these two into the Core Platform project"},
        message,
        {
            "role": "tool",
            "tool_call_id": "call_bad",
            "name": "hub_update_task",
            "content": json.dumps(
                {
                    "error": "No project named Core Platform.",
                    "hint": "Ask the user a question instead of proposing this write.",
                }
            ),
        },
    ]
    payload = build_chat_payload("gemini-3.5-flash", "google", history, tools=[{"type": "function", "function": {"name": "hub_update_task"}}])
    sent = payload["messages"]
    assistant = sent[1]
    assert assistant["content"] is None
    assert assistant["tool_calls"][0]["extra_content"]["google"]["thought_signature"] == signature
    assert assistant["tool_calls"][1]["extra_content"]["google"]["thought_signature"] == signature
    responses = [row for row in sent if row["role"] == "tool"]
    assert [row["tool_call_id"] for row in responses] == ["call_bad", "call_ok"]
    assert "Core Platform" in responses[0]["content"]
    assert responses[1]["content"].strip()
    assert all(isinstance(row["content"], str) and row["content"].strip() for row in responses)


def test_parallel_board_move_and_delete_are_valid_gemini_turns() -> None:
    signature = "sig-on-second-only"
    cases = [
        ("hub_update_task", "call_move_a", "call_move_b", json.dumps({"ok": True, "status": "in_progress"}), json.dumps({"ok": True, "status": "done"})),
        ("hub_delete_task", "call_del_a", "call_del_b", json.dumps({"ok": True}), json.dumps({"ok": True})),
    ]
    for name, first_id, second_id, first_body, second_body in cases:
        history = [
            {"role": "user", "content": "apply both"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": first_id, "type": "function", "function": {"name": name, "arguments": "{}"}},
                    {"id": "call_middle", "type": "function", "function": {"name": name, "arguments": "{}"}},
                    {
                        "id": second_id,
                        "type": "function",
                        "extra_content": {"google": {"thought_signature": signature}},
                        "function": {"name": name, "arguments": "{}"},
                    },
                ],
            },
            {"role": "tool", "tool_call_id": first_id, "name": name, "content": first_body},
            {"role": "tool", "tool_call_id": second_id, "name": name, "content": second_body},
        ]
        payload = build_chat_payload("gemini-3.5-flash", "google", history, tools=[{"type": "function", "function": {"name": name}}])
        sent = payload["messages"]
        assistant = sent[1]
        assert assistant["content"] is None
        assert [call["extra_content"]["google"]["thought_signature"] for call in assistant["tool_calls"]] == [signature, signature, signature]
        responses = [row for row in sent if row["role"] == "tool"]
        assert [row["tool_call_id"] for row in responses] == [first_id, "call_middle", second_id]
        assert responses[0]["content"] == first_body
        assert responses[2]["content"] == second_body
        assert all(isinstance(row["content"], str) and row["content"].strip() for row in responses)


def test_token_bucket_holds_the_sixteenth_gemini_call() -> None:
    reset_buckets()
    start = 1_000.0
    waits = [reserve_delay("user-1", "google", now=start) for _ in range(15)]
    assert waits == [0.0] * 15
    assert reserve_delay("user-1", "google", now=start) == pytest.approx(4.0)
    assert reserve_delay("user-2", "google", now=start) == 0.0
    reset_buckets()
