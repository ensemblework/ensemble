from __future__ import annotations

from ensemble_agent.policy import decide
from ensemble_agent.tools.catalog import TOOLS, gate_for, requires_approval


def test_unknown_tool_is_denied() -> None:
    decision = decide(tool="not.a.tool")
    assert decision.decision == "deny"
    assert decision.rule == "unknown_tool"


def test_send_mail_needs_approval_under_assist() -> None:
    assert requires_approval("graph.mail.send", "assist") is True
    assert gate_for("graph.mail.send", "assist") == "approval"
    decision = decide(tool="graph.mail.send", payload={"to": "a@ensemble.local", "body": "hi"}, autonomy="assist")
    assert decision.decision == "require_approval"


def test_send_mail_autonomous_allows_internal() -> None:
    decision = decide(tool="graph.mail.send", payload={"to": "a@ensemble.local", "body": "hi"}, autonomy="autonomous")
    assert decision.decision == "allow"


def test_external_recipient_always_approval() -> None:
    decision = decide(
        tool="graph.mail.send",
        payload={"to": "ceo@elsewhere.com", "body": "hi"},
        autonomy="autonomous",
    )
    assert decision.decision == "require_approval"
    assert decision.rule == "external_recipient"


def test_sensitive_content() -> None:
    decision = decide(
        tool="graph.mail.send",
        payload={"to": "a@ensemble.local", "body": "here is your salary figure"},
        autonomy="autonomous",
    )
    assert decision.rule == "sensitive_content"


def test_forbidden_never_approvable() -> None:
    decision = decide(tool="graph.mail.delete", autonomy="autonomous")
    assert decision.decision == "deny"
    assert decision.rule == "forbidden_tool"


def test_catalog_has_writes() -> None:
    assert "graph.mail.send" in TOOLS
    assert TOOLS["graph.mail.send"].is_write
    assert TOOLS["gmail.mail.send"].gate == "approval"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
