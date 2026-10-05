"""The single chokepoint for every write that leaves the system.

Sending mail, opening a PR, posting to Teams all go through guarded_write.
It enforces the autonomy policy, raises ApprovalRequired when a human must
decide, and appends an audit-ledger row for every attempt — approved or not.

Bypassing this module is a governance bug: no worker may call a write tool
directly (docs/01, docs/07).
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Literal

from ensemble_agent.audit.ledger import append_entry
from ensemble_agent.policy import PolicyDecision, decide
from ensemble_agent.tools.catalog import AutonomyLevel, get_tool

WriteKind = Literal["send_email", "open_pr", "post_teams", "other"]

KIND_TO_TOOL: dict[str, str] = {
    "send_email": "graph.mail.send",
    "post_teams": "graph.chat.post",
    "open_pr": "github.pr.create",
    "other": "llm.draft",
}


class PolicyDeniedError(Exception):
    def __init__(self, decision: PolicyDecision) -> None:
        super().__init__(decision.reason)
        self.decision = decision


class ApprovalRequired(Exception):  # noqa: N818 — control flow, not a failure
    def __init__(self, kind: WriteKind, preview: dict[str, Any], reason: str) -> None:
        super().__init__(reason)
        self.kind = kind
        self.preview = preview
        self.reason = reason


def idempotency_key(job: dict[str, Any], tool: str | None = None) -> str:
    parts = [
        str(job.get("taskId") or "no-task"),
        str(job.get("stepId") or job.get("runId") or "no-step"),
        str(job.get("attempt", 0)),
        str(job.get("tool") or tool or "no-tool"),
    ]
    return ";".join(parts)


async def guarded_write(
    *,
    user_id: str,
    kind: WriteKind,
    preview: dict[str, Any],
    job: dict[str, Any],
    autonomy: AutonomyLevel = "assist",
    execute: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
    approved: bool = False,
) -> dict[str, Any]:
    tool = str(job.get("tool") or KIND_TO_TOOL.get(kind) or KIND_TO_TOOL["other"])
    if get_tool(tool) is None and kind in KIND_TO_TOOL:
        tool = KIND_TO_TOOL[kind]
    decision = decide(tool=tool, payload=preview, autonomy=autonomy)
    await append_entry(
        user_id=user_id,
        actor="agent",
        action=f"write.{kind}",
        task_id=job.get("taskId"),
        run_id=job.get("runId"),
        payload={"decision": decision.to_dict(), "key": idempotency_key(job, tool)},
    )
    if decision.decision == "deny":
        raise PolicyDeniedError(decision)
    if decision.decision == "require_approval" and not approved and not job.get("approvalId"):
        raise ApprovalRequired(kind, preview, decision.reason)
    if execute is None:
        return {"status": "stubbed", "key": idempotency_key(job, tool)}
    return await execute(preview)
