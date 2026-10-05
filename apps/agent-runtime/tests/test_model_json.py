"""JSON replies from triage. No network."""

from __future__ import annotations

import asyncio
import time

import pytest

from ensemble_agent.models import complete_json, complete_text, parse_model_json


def test_object_inside_prose() -> None:
    assert parse_model_json('Here you go {"todos":[{"id":"a"}]}') == {"todos": [{"id": "a"}]}


def test_fenced_array_and_prose_around_an_array() -> None:
    fenced = '```json\n[{"id":"art_priya","title":"Reply to Priya with p95 latency numbers"}]\n```'
    assert parse_model_json(fenced) == [{"id": "art_priya", "title": "Reply to Priya with p95 latency numbers"}]
    prose = 'Sorted.\n[{"id":"a","title":"Reply"}]\nDone }'
    assert parse_model_json(prose) == [{"id": "a", "title": "Reply"}]
    braced = 'Note {"excerpt":"use {braces}","todos":[{"id":"a"}]} trailing }'
    assert parse_model_json(braced) == {"excerpt": "use {braces}", "todos": [{"id": "a"}]}


def test_unparseable_prose_raises_the_same_error() -> None:
    with pytest.raises(RuntimeError, match="The model did not return JSON:"):
        parse_model_json("Priya asked for the p95 numbers by EOD.")


def test_complete_text_keeps_a_fenced_array(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_mock(body: dict, model: str) -> dict:
        del body
        return {
            "text": '```json\n[{"id":"a","title":"Reply"}]\n```',
            "model": model,
            "tokensIn": 2,
            "tokensOut": 3,
        }

    monkeypatch.setattr("ensemble_agent.models._mock_turn", fake_mock)
    result = asyncio.run(
        complete_text({"provider": "mock", "model": "gemini-3.5-flash-lite", "prompt": "triage", "json": True})
    )
    assert result["json"] == [{"id": "a", "title": "Reply"}]


def test_complete_text_keeps_an_object_inside_prose(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_mock(body: dict, model: str) -> dict:
        del body
        return {
            "text": 'Here you go {"todos":[{"id":"a"}]}',
            "model": model,
            "tokensIn": 2,
            "tokensOut": 3,
        }

    monkeypatch.setattr("ensemble_agent.models._mock_turn", fake_mock)
    result = asyncio.run(complete_text({"provider": "mock", "model": "mock", "prompt": "triage", "json": True}))
    assert result["json"] == {"todos": [{"id": "a"}]}


_FOUR = {
    "todos": [
        {"id": "art_priya", "title": "Reply to Priya"},
        {"id": "art_rahul", "title": "Reply to Rahul"},
        {"id": "art_sam", "title": "Reply to Sam"},
        {"id": "art_anika", "title": "Reply to Anika"},
    ]
}


def test_citation_and_empty_object_do_not_hide_the_todos() -> None:
    import json

    cited = 'as noted in [1], here:\n```json\n' + json.dumps(_FOUR) + "\n```"
    assert parse_model_json(cited, "triage") == _FOUR
    filled = "Fill in {} first, then: " + json.dumps(_FOUR)
    assert parse_model_json(filled, "triage") == _FOUR


def test_cut_off_reply_is_no_match() -> None:
    cutoff = '{"todos":[{"id":"art_priya","title":"Reply to Priya"},{"id":"art_rahul","ti'
    fenced = "```json\n" + cutoff
    for reply in (cutoff, fenced):
        with pytest.raises(RuntimeError, match="The model did not return JSON:"):
            parse_model_json(reply, "triage")


def test_unmatched_braces_stay_cheap() -> None:
    started = time.perf_counter()
    with pytest.raises(RuntimeError, match="The model did not return JSON:"):
        parse_model_json("{" * 40_000, "triage")
    assert time.perf_counter() - started < 1


def test_two_objects_back_to_back_are_no_match() -> None:
    reply = '{"todos":[{"id":"art_priya","title":"Reply"}]}{"todos":[{"id":"art_rahul","title":"Send"}]}'
    with pytest.raises(RuntimeError, match="The model did not return JSON:"):
        parse_model_json(reply, "triage")


def test_stray_quote_or_brace_before_the_object_still_parses() -> None:
    quoted = 'My 27" monitor sits on the desk {"label":"desk","inches":27}'
    assert parse_model_json(quoted) == {"label": "desk", "inches": 27}
    braced = 'See {this note first {"todos":[{"id":"a","title":"Reply"}]}'
    assert parse_model_json(braced, "triage") == {"todos": [{"id": "a", "title": "Reply"}]}


def test_stray_braces_in_prose_keep_the_object() -> None:
    reply = 'See the note {draft} before this: {"todos":[{"id":"a","title":"Reply"}]} trailing }'
    assert parse_model_json(reply, "triage") == {"todos": [{"id": "a", "title": "Reply"}]}


def test_plan_shape_skips_non_steps_and_keeps_a_steps_object() -> None:
    reply = 'as noted in [1], fill in {} first, then: {"steps":[{"id":"s1","title":"Read"}]}'
    assert parse_model_json(reply, "plan") == {"steps": [{"id": "s1", "title": "Read"}]}
    with pytest.raises(RuntimeError, match="The model did not return JSON:"):
        parse_model_json("as noted in [1], fill in {} first", "plan")


def test_complete_json_rejects_a_reply_without_steps(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_mock(body: dict, model: str) -> dict:
        assert body.get("jsonShape") == "plan"
        return {"text": "as noted in [1], fill in {} first", "model": model, "tokensIn": 1, "tokensOut": 1}

    monkeypatch.setattr("ensemble_agent.models._mock_turn", fake_mock)
    with pytest.raises(RuntimeError, match="The model did not return JSON:"):
        asyncio.run(complete_json("plan this", provider="mock", model="mock"))


def test_deep_bracket_nesting_is_no_match() -> None:
    nested = "[" * 12_000 + "]" * 12_000
    with pytest.raises(RuntimeError, match="The model did not return JSON:") as caught:
        parse_model_json(nested)
    assert not isinstance(caught.value, RecursionError)
