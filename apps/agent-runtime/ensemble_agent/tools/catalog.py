"""Tool catalog (docs/05 §5, §7, §8).

One registry of every tool a worker may call, each with a risk level and the
gate it triggers. It is the single source of truth for three things that must
never drift apart:

- what the planner is allowed to put in a plan,
- what the executor must stop and ask about,
- what the policy layer records in the ledger.

Keeping them in one table is what makes "no worker calls a write tool without
an Approval" checkable rather than aspirational.

`graph.*` is the Outlook / Teams adapter. `gmail.*` is the Gmail adapter. Same
risk and gates — two connectors, one policy.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

AutonomyLevel = Literal["assist", "supervised", "autonomous"]
Risk = Literal["low", "medium", "high"]
Gate = Literal["none", "policy", "approval"]


class ToolServer(StrEnum):
    """MCP server (or local module) that owns the tool."""

    GRAPH = "graph"
    GMAIL = "gmail"
    GITHUB = "github"
    WORKSPACE = "workspace"
    WEB = "web"
    LLM = "llm"
    RESEARCH = "research"


@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: str
    server: ToolServer
    description: str
    risk: Risk = "low"
    is_write: bool = False
    #: Strongest gate this tool can require, before autonomy is considered.
    gate: Gate = "none"
    #: True when the effect can be walked back (close a PR, delete a draft).
    reversible: bool = True
    #: Seconds during which autonomous mode can still undo it (docs/05 §8).
    undo_window_seconds: int = 0


def t(
    name: str,
    server: ToolServer,
    description: str,
    *,
    risk: Risk = "low",
    is_write: bool = False,
    gate: Gate = "none",
    reversible: bool = True,
    undo_window_seconds: int = 0,
) -> tuple[str, ToolSpec]:
    return name, ToolSpec(
        name=name,
        server=server,
        description=description,
        risk=risk,
        is_write=is_write,
        gate=gate,
        reversible=reversible,
        undo_window_seconds=undo_window_seconds,
    )


#: Every tool the orchestrator knows about.
#: Reads are ungated. Writes carry the gate that matches how hard they are to
#: take back: sending mail cannot be undone at all, so it is always "approval";
#: a draft can be deleted, so it is "policy" and only needs a human at assist.
TOOLS: dict[str, ToolSpec] = dict(
    [
        # ── mail (Outlook adapter) ──────────────────────────────────────────
        t("graph.mail.read", ToolServer.GRAPH, "Read a mail thread."),
        t("graph.mail.search", ToolServer.GRAPH, "Search my mailbox."),
        t(
            "graph.mail.draft",
            ToolServer.GRAPH,
            "Save a reply as a draft.",
            is_write=True,
            reversible=True,
            gate="policy",
        ),
        t(
            "graph.mail.send",
            ToolServer.GRAPH,
            "Send mail as me. Once it is in someone's inbox there is no taking it back.",
            risk="high",
            is_write=True,
            gate="approval",
            reversible=False,
        ),
        # ── mail (Gmail adapter) ────────────────────────────────────────────
        t("gmail.mail.read", ToolServer.GMAIL, "Read a Gmail thread."),
        t("gmail.mail.search", ToolServer.GMAIL, "Search Gmail."),
        t(
            "gmail.mail.draft",
            ToolServer.GMAIL,
            "Save a Gmail draft.",
            is_write=True,
            reversible=True,
            gate="policy",
        ),
        t(
            "gmail.mail.send",
            ToolServer.GMAIL,
            "Send Gmail as me. Irreversible.",
            risk="high",
            is_write=True,
            gate="approval",
            reversible=False,
        ),
        # ── chat / calendar ─────────────────────────────────────────────────
        t("graph.chat.read", ToolServer.GRAPH, "Read a Teams chat or channel thread."),
        t(
            "graph.chat.post",
            ToolServer.GRAPH,
            "Post a Teams message as me. Teams allows deletion for a short period.",
            risk="high",
            is_write=True,
            gate="approval",
            reversible=True,
            undo_window_seconds=300,
        ),
        t("graph.calendar.read", ToolServer.GRAPH, "Read my calendar."),
        t(
            "graph.calendar.create_event",
            ToolServer.GRAPH,
            "Create a calendar event or focus block.",
            risk="medium",
            is_write=True,
            gate="approval",
        ),
        t("graph.files.read", ToolServer.GRAPH, "Read a file or doc the mail referred to."),
        # ── GitHub ──────────────────────────────────────────────────────────
        t("github.pr.read", ToolServer.GITHUB, "Read a pull request and its comments."),
        t("github.issue.read", ToolServer.GITHUB, "Read a GitHub issue."),
        t("github.repo.read", ToolServer.GITHUB, "Read repository metadata."),
        t(
            "github.pr.comment",
            ToolServer.GITHUB,
            "Comment on a pull request.",
            risk="medium",
            is_write=True,
            gate="approval",
        ),
        t(
            "github.pr.create",
            ToolServer.GITHUB,
            "Open a pull request as me.",
            risk="high",
            is_write=True,
            gate="approval",
            reversible=True,
            undo_window_seconds=300,
        ),
        # ── workspace ───────────────────────────────────────────────────────
        t("workspace.fs.read", ToolServer.WORKSPACE, "Read a file inside the jails workspace."),
        t(
            "workspace.fs.write",
            ToolServer.WORKSPACE,
            "Write a file inside the jailed workspace.",
            is_write=True,
            gate="policy",
        ),
        t("workspace.repo.run", ToolServer.WORKSPACE, "Run tests or a command in the workspace."),
        t(
            "workspace.repo.commit",
            ToolServer.WORKSPACE,
            "Commit staged changes using the commit-message skill.",
            risk="low",
            is_write=True,
            gate="policy",
        ),
        t(
            "workspace.repo.push_branch",
            ToolServer.WORKSPACE,
            "Push the working branch to the remote.",
            risk="medium",
            is_write=True,
            gate="policy",
        ),
        # ── other ───────────────────────────────────────────────────────────
        t(
            "research.papers",
            ToolServer.RESEARCH,
            "Search real published work by topic. Returns verified titles, authors, venues, years and DOIs. Use this before writing anything that cites literature.",
        ),
        t("web.fetch", ToolServer.WEB, "Fetch a URL and return cleaned text."),
        t("web.search", ToolServer.WEB, "Search the public web."),
        t("llm.draft", ToolServer.LLM, "Draft text using the context and a skill."),
        t("llm.summarize", ToolServer.LLM, "Summarise context."),
    ]
)

FORBIDDEN_TOOLS: frozenset[str] = frozenset(
    {
        "graph.mail.delete",
        "graph.chat.delete",
        "gmail.mail.delete",
        "github.branch.delete",
        "github.repo.delete",
    }
)


def get_tool(name: str) -> ToolSpec | None:
    return TOOLS.get(name)


def read_only_tools() -> list[ToolSpec]:
    return [item for item in TOOLS.values() if not item.is_write]


def write_tools() -> list[ToolSpec]:
    return [item for item in TOOLS.values() if item.is_write]


def requires_approval(tool_name: str, autonomy: AutonomyLevel) -> bool:
    """Whether this call needs a human decision at this autonomy level.

    Mirrors the matrix in docs/05 §8:

                    reads   drafts   low-risk writes   high-risk writes
    assist          auto    auto     approval          approval
    supervised      auto    auto     auto + ledger     approval
    autonomous      auto    auto     auto              auto
    """
    spec = TOOLS.get(tool_name)
    if spec is None:
        # An unknown tool is treated as the most dangerous thing it could be.
        return True
    if not spec.is_write:
        return False
    if autonomy == "autonomous":
        return False
    if autonomy == "assist":
        return True
    # supervised: only stop for the things a human cannot easily undo.
    return spec.gate == "approval"


def gate_for(tool_name: str, autonomy: AutonomyLevel) -> Gate:
    spec = TOOLS.get(tool_name)
    if spec is None:
        return "approval"
    if not spec.is_write:
        return "none"
    return "approval" if requires_approval(tool_name, autonomy) else "policy"


def catalog_for_prompt(allowed: list[str] | None = None) -> str:
    """Renders the catalog for the planner prompt.

    The planner has to name a real tool and its gate for every write step, so
    it needs to see the risk levels rather than guess them.
    """
    if allowed is None:
        specs = list(TOOLS.values())
    else:
        specs = [TOOLS[name] for name in allowed if name in TOOLS]
    lines: list[str] = []
    for spec in sorted(specs, key=lambda item: (item.server, item.name)):
        flags = f"risk={spec.risk}"
        if spec.is_write:
            flags += f", write, gate={spec.gate}"
            if not spec.reversible:
                flags += ", IRREVERSIBLE"
        lines.append(f"- {spec.name} ({flags}) — {spec.description}")
    return "\n".join(lines)
