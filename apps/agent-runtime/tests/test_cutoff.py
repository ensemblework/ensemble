"""Cut-off replies. The RECITATION streams are real Gemini captures. No network."""

from __future__ import annotations

import json
from pathlib import Path

import asyncio

import httpx

from ensemble_agent.models import (
    CONNECTION_DROPPED_NOTICE,
    ConnectionDropped,
    _anthropic_result,
    _from_openai,
    apply_stream_event,
    consume_sse_lines,
    cut_off_notice,
    cut_off_reply,
    feed_sse,
    finish_is_cut_off,
    new_stream_state,
    recover_provider_stream,
    stream_state_to_completion,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
CAPTURES = json.loads((FIXTURES / "recitation_cutoffs.json").read_text())


def _turn_from_sse(block: str, model: str = "gemini-3.5-flash-lite") -> dict:
    state = new_stream_state()
    feed_sse(state, block)
    return _from_openai(stream_state_to_completion(state, model), model)


def _turn_from_events(events: list[dict], model: str = "mock") -> dict:
    state = new_stream_state()
    for event in events:
        apply_stream_event(state, event)
    return _from_openai(stream_state_to_completion(state, model), model)


def test_recitation_captures_are_cut_off_and_keep_the_partial_text() -> None:
    assert set(CAPTURES) == {"py-count-2", "py-count-3", "ts-count-1", "ts-count-2", "ts-count-3"}
    for name, capture in CAPTURES.items():
        turn = _turn_from_sse(capture["sse"])
        assert turn["cutOff"] is True, name
        assert turn["finishReason"] == "content_filter: RECITATION", name
        assert turn["text"] == capture["text"], name
        assert turn["text"] != cut_off_reply(turn["text"], turn["finishReason"])


def test_length_and_a_stream_with_no_finish_reason_are_cut_off() -> None:
    length = _turn_from_events(
        [
            {"choices": [{"delta": {"content": "one two three"}}]},
            {"choices": [{"delta": {}, "finish_reason": "length"}]},
        ]
    )
    assert length["cutOff"] is True
    assert length["finishReason"] == "length"
    assert length["text"] == "one two three"
    assert cut_off_notice("length") == "The reply hit the length limit."

    dropped = _turn_from_sse('data: {"choices":[{"delta":{"content":"Hello"}}]}\n')
    assert dropped["cutOff"] is True
    assert dropped["finishReason"] is None
    assert dropped["text"] == "Hello"
    assert cut_off_notice(None) == "The reply was cut off before the model finished."

    other = _from_openai(
        {"choices": [{"message": {"role": "assistant", "content": "nope"}, "finish_reason": "content_filter: OTHER"}]},
        "mock",
    )
    assert other["cutOff"] is True
    assert other["finishReason"] == "content_filter: OTHER"


def test_normal_finish_reasons_are_not_cut_off() -> None:
    stop = _turn_from_events(
        [
            {"choices": [{"delta": {"content": "done"}}]},
            {"choices": [{"finish_reason": "stop"}]},
        ]
    )
    assert stop["cutOff"] is False
    assert stop["finishReason"] == "stop"
    assert stop["text"] == "done"

    tools = _turn_from_events(
        [
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "hub_list_tasks", "arguments": "{}"}}]}}]},
            {"choices": [{"finish_reason": "tool_calls"}]},
        ]
    )
    assert tools["cutOff"] is False
    assert tools["finishReason"] == "tool_calls"
    assert tools["toolCalls"][0]["name"] == "hub_list_tasks"

    legacy = _from_openai(
        {"choices": [{"message": {"role": "assistant", "content": "", "function_call": {}}, "finish_reason": "function_call"}]},
        "mock",
    )
    assert legacy["cutOff"] is False
    assert legacy["finishReason"] == "function_call"

    for reason in ("end_turn", "tool_use", "stop_sequence"):
        turn = _turn_from_events(
            [
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ok"}},
                {"type": "message_delta", "delta": {"stop_reason": reason}},
            ]
        )
        assert turn["cutOff"] is False, reason
        assert turn["finishReason"] == reason
        assert turn["text"] == "ok"

    native_stop = _turn_from_events([{"candidates": [{"content": {"parts": [{"text": "hi"}]}, "finishReason": "STOP"}]}])
    assert native_stop["cutOff"] is False
    assert native_stop["finishReason"] == "STOP"

    for reason in ("RECITATION", "MAX_TOKENS", "SAFETY"):
        native = _turn_from_events([{"candidates": [{"content": {"parts": [{"text": "x"}]}, "finishReason": reason}]}])
        assert native["cutOff"] is True, reason
        assert native["finishReason"] == reason

    ollama_stop = _turn_from_events([{"done": True, "done_reason": "stop", "message": {"content": "ready"}}])
    assert ollama_stop["cutOff"] is False
    assert ollama_stop["finishReason"] == "stop"
    ollama_length = _turn_from_events([{"done_reason": "length"}])
    assert ollama_length["cutOff"] is True
    assert ollama_length["finishReason"] == "length"

    anthropic = _anthropic_result(
        {"model": "claude", "stop_reason": "end_turn", "content": [{"type": "text", "text": "ready"}], "usage": {}},
        "claude",
    )
    assert anthropic["cutOff"] is False
    assert anthropic["finishReason"] == "end_turn"
    tool_use = _anthropic_result(
        {
            "stop_reason": "tool_use",
            "content": [{"type": "tool_use", "id": "toolu_1", "name": "hub_list_tasks", "input": {}}],
        },
        "claude",
    )
    assert tool_use["cutOff"] is False
    assert tool_use["finishReason"] == "tool_use"
    limited = _anthropic_result({"stop_reason": "max_tokens", "content": [{"type": "text", "text": "partial"}]}, "claude")
    assert limited["cutOff"] is True
    assert limited["finishReason"] == "max_tokens"
    assert cut_off_notice("max_tokens") == "The reply hit the length limit."
    assert finish_is_cut_off("stop", "anthropic") is True
    assert finish_is_cut_off("end_turn", "openai") is True


def test_history_marker_on_the_next_turn() -> None:
    partial = CAPTURES["py-count-2"]["text"]
    saved = cut_off_reply(partial, "content_filter: RECITATION")
    history = [
        {"role": "user", "content": "count from one to thirty in words"},
        {"role": "assistant", "content": saved},
        {"role": "user", "content": "keep going"},
    ]
    assistant = history[1]["content"]
    assert assistant.startswith("[Cut off:")
    assert "content filter: RECITATION" in assistant
    assert "Reason: content_filter: RECITATION." in assistant
    assert "This reply is incomplete." in assistant
    assert partial in assistant
    assert partial != assistant
    assert "The model stopped early (content filter: RECITATION)." in assistant


def _delta(text: str) -> str:
    return 'data: {"choices":[{"delta":{"content":' + json.dumps(text) + "}}]}\n"


async def _lines_then(lines: list[str], error: BaseException | None = None):
    for line in lines:
        yield line
    if error is not None:
        raise error


def _peer_closed() -> httpx.RemoteProtocolError:
    return httpx.RemoteProtocolError(
        "peer closed connection without sending complete message body (incomplete chunked read)"
    )


def _saved_from_turn(turn: dict) -> str:
    if turn.get("cutOff"):
        return cut_off_reply(str(turn.get("text") or ""), turn.get("finishReason"))
    return str(turn.get("text") or "")


async def _read_turn(lines) -> dict:
    done = None
    async for kind, data in consume_sse_lines(lines, "gemini-3.5-flash-lite"):
        if kind == "done":
            done = data
    assert done is not None
    return _from_openai(done, "gemini-3.5-flash-lite")


def test_transport_drop_after_text_keeps_the_partial_and_the_next_turn_marker() -> None:
    turn = asyncio.run(
        _read_turn(_lines_then([_delta("The sea "), _delta("is wide")], _peer_closed()))
    )
    assert turn["cutOff"] is True
    assert turn["finishReason"] is None
    assert turn["text"] == "The sea is wide"
    saved = _saved_from_turn(turn)
    assert saved.startswith("[Cut off: The reply was cut off before the model finished.")
    assert "peer closed" not in saved
    assert "incomplete chunked read" not in saved
    assert "The sea is wide" in saved
    assert "Reason: none." in saved

    terminated = type("TypeError", (Exception,), {})("terminated")
    state = new_stream_state()
    apply_stream_event(state, {"choices": [{"delta": {"content": "The sea is wide"}}]})
    recovered = recover_provider_stream(state, terminated, "mock")
    parsed = _from_openai(recovered, "mock")
    assert parsed["text"] == "The sea is wide"
    assert "terminated" not in cut_off_reply(parsed["text"], None)


def test_transport_drop_before_text_is_a_notice_left_out_of_history() -> None:
    async def empty():
        return await _read_turn(_lines_then([], httpx.ReadError("peer closed connection")))

    try:
        asyncio.run(empty())
    except ConnectionDropped as exc:
        assert str(exc) == CONNECTION_DROPPED_NOTICE
        assert "peer closed" not in str(exc)
    else:
        raise AssertionError("expected ConnectionDropped")

    state = new_stream_state()
    try:
        recover_provider_stream(state, RuntimeError("This key is out of quota for that model."), "mock")
    except RuntimeError as exc:
        assert "quota" in str(exc)
    else:
        raise AssertionError("a non-transport error should still propagate")


def test_user_stop_mid_stream_is_not_a_cut_off() -> None:
    async def stopped():
        async for _kind, _data in consume_sse_lines(
            _lines_then([_delta("Hello from the sea")], asyncio.CancelledError()),
            "mock",
        ):
            pass

    try:
        asyncio.run(stopped())
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("Stop must stay a cancellation")

    state = new_stream_state()
    apply_stream_event(state, {"choices": [{"delta": {"content": "Hello from the sea"}}]})
    try:
        recover_provider_stream(state, asyncio.CancelledError(), "mock")
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("Stop must stay a cancellation")
    assert "".join(state["content"]) == "Hello from the sea"
    assert "[Cut off:" not in "".join(state["content"])


def test_a_clean_stream_end_has_no_cut_off_notice() -> None:
    async def clean():
        yield _delta("Thirty.")
        yield 'data: {"choices":[{"finish_reason":"stop"}]}\n'
        yield "data: [DONE]\n"

    turn = asyncio.run(_read_turn(clean()))
    assert turn["cutOff"] is False
    assert turn["finishReason"] == "stop"
    assert turn["text"] == "Thirty."
    assert "[Cut off:" not in turn["text"]


def test_cut_off_marker_reason_cannot_break_the_line() -> None:
    messy = cut_off_reply("partial", "content_filter: bad]\nreason\twith   spaces")
    assert messy.startswith("[Cut off:")
    assert "Reason: content_filter: bad reason with spaces." in messy
    first = messy.split("\n", 1)[0]
    assert "]" not in first[1:-1]
    assert "partial" in messy
    assert "\n" not in first

    blank = cut_off_reply("partial", "]\n\n")
    assert "Reason: none." in blank


def test_python_agent_has_no_forced_tool_refusal_prompt() -> None:
    """The assistant refusal rule lives in hub-api state.ts, not in this runtime."""
    root = Path(__file__).resolve().parents[1] / "ensemble_agent"
    blob = "\n".join(path.read_text() for path in root.rglob("*.py"))
    assert "If no tool can do the job, say so in one sentence." not in blob
    assert "You act by calling tools." not in blob
