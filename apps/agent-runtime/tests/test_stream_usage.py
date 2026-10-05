"""Streamed Gemini replies carry usageMetadata on the last chunk."""

from ensemble_agent.models import _from_openai, apply_stream_event, new_stream_state, stream_state_to_completion


def test_gemini_usage_metadata_is_recorded_like_a_non_streamed_turn() -> None:
    state = new_stream_state()
    apply_stream_event(state, {"candidates": [{"content": {"parts": [{"text": "Hi"}]}}]})
    apply_stream_event(
        state,
        {"usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 4, "totalTokenCount": 15}},
    )
    done = stream_state_to_completion(state, "gemini-2.5-flash")
    assert done["usage"]["prompt_tokens"] == 11
    assert done["usage"]["completion_tokens"] == 4
    turn = _from_openai(done, "gemini-2.5-flash")
    assert turn["tokensIn"] == 11
    assert turn["tokensOut"] == 4
    assert turn["tokensIn"] is not None
    assert turn["tokensOut"] is not None
    assert turn["text"] == "Hi"
    assert turn["model"] == "gemini-2.5-flash"


def test_empty_usage_does_not_wipe_flash_usage_metadata() -> None:
    state = new_stream_state()
    apply_stream_event(state, {"model": "gemini-2.5-flash", "choices": [{"delta": {"content": "Hello"}}], "usage": {}})
    apply_stream_event(
        state,
        {
            "model": "gemini-2.5-flash",
            "usage": {"prompt_tokens": None, "completion_tokens": None},
            "usageMetadata": {"promptTokenCount": 18, "candidatesTokenCount": 6, "totalTokenCount": 24},
        },
    )
    apply_stream_event(state, {"usage": {}})
    turn = _from_openai(stream_state_to_completion(state, "gemini-2.5-flash"), "gemini-2.5-flash")
    assert turn["tokensIn"] == 18
    assert turn["tokensOut"] == 6
    assert turn["tokensIn"] is not None
