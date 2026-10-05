from __future__ import annotations

import asyncio

import pytest

from ensemble_agent.models import complete_json
from ensemble_agent.orchestrator.planner import REQUIRES_WRITE_STEP, _parse_plan, _template_plan, build_plan
from ensemble_agent.tools.catalog import TOOLS, gate_for


def test_reply_email_template_has_a_write_step() -> None:
    plan = _template_plan("reply_email", "Reply to Alex", "assist")
    writes = [step for step in plan.steps if (spec := TOOLS.get(step.tool or "")) and spec.is_write]
    assert writes, "a reply_email plan cannot silently do nothing"


def test_planner_never_trusts_model_gate_on_writes() -> None:
    plan = _parse_plan(
        {
            "goal": "send mail",
            "successCriteria": ["sent"],
            "steps": [
                {
                    "id": "s1",
                    "title": "Send the reply",
                    "tool": "graph.mail.send",
                    "risk": "high",
                    "gate": "none",
                }
            ],
            "questionsForUser": [],
        },
        "assist",
    )
    assert plan.steps[0].gate == gate_for("graph.mail.send", "assist")
    assert plan.steps[0].gate != "none"


def test_requires_write_step_types_are_named() -> None:
    assert "reply_email" in REQUIRES_WRITE_STEP
    assert "open_pr" in REQUIRES_WRITE_STEP


def test_planner_falls_back_when_the_reply_has_no_steps(monkeypatch: pytest.MonkeyPatch) -> None:
    """A reply that is JSON but not a plan uses the template. It must not crash."""

    def fake_mock(body: dict, model: str) -> dict:
        del body
        return {"text": "as noted in [1], fill in {} first", "model": model, "tokensIn": 1, "tokensOut": 1}

    async def via_mock(prompt: str, *, model: str | None = None, role: str = "planner", provider: str | None = None, user_id: str | None = None):
        del provider
        return await complete_json(prompt, model=model, role=role, provider="mock", user_id=user_id)

    monkeypatch.setattr("ensemble_agent.models._mock_turn", fake_mock)
    monkeypatch.setattr("ensemble_agent.models.complete_json", via_mock)
    plan = asyncio.run(build_plan({"title": "Reply to Alex", "taskType": "reply_email", "description": "Please reply"}))
    assert plan.from_model is False
    assert [step.title for step in plan.steps] == [
        "Read the thread and gather the facts",
        "Draft the reply in your tone",
        "Send the reply",
    ]
