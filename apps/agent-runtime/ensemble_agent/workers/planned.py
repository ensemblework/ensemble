"""Seven workers routed by taskType (docs/05 §7)."""

from __future__ import annotations

from typing import Any

from ensemble_agent.orchestrator.planner import build_plan
from ensemble_agent.tools.catalog import AutonomyLevel

WORKER_TOOLS: dict[str, list[str]] = {
    "reply_email": ["graph.mail.read", "graph.mail.search", "gmail.mail.read", "gmail.mail.search", "web.fetch", "graph.files.read", "llm.draft", "graph.mail.send", "gmail.mail.send"],
    "reply_teams": ["graph.chat.read", "llm.draft", "graph.chat.post"],
    "open_pr": ["workspace.fs.read", "workspace.fs.write", "workspace.repo.run", "workspace.repo.commit", "workspace.repo.push_branch", "github.pr.create", "llm.draft"],
    "review_pr": ["github.pr.read", "llm.summarize"],
    "schedule": ["graph.calendar.read", "llm.draft", "graph.calendar.create_event"],
    "research": ["research.papers", "web.search", "web.fetch", "llm.draft"],
    "write_doc": ["llm.summarize", "llm.draft"],
}


def _allowed(task: dict[str, Any], names: list[str] | None) -> list[str] | None:
    """Drop forge and workspace tools the person's template removed.

    github.* needs Code. workspace.fs and workspace.repo need Code or Workspace.
    A missing modules field leaves the worker list alone; the hub still refuses the HTTP call.
    """
    if names is None or "modules" not in task:
        return names
    raw = str(task.get("modules") or "")
    on = {part.strip() for part in raw.split(",") if part.strip()}
    kept: list[str] = []
    for name in names:
        if name.startswith("github.") and "code" not in on:
            continue
        if name.startswith("workspace.") and "code" not in on and "workspace" not in on:
            continue
        kept.append(name)
    return kept


async def plan_for_worker(task: dict[str, Any], autonomy: AutonomyLevel = "assist", **kwargs: Any):
    task_type = str(task.get("taskType") or "other")
    allowed = _allowed(task, WORKER_TOOLS.get(task_type))
    return await build_plan(task, autonomy=autonomy, allowed_tools=allowed, **kwargs)
