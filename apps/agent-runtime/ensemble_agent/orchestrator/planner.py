"""Planner (docs/05 §5) — task + context + skills → a structured plan.

The plan is the contract between thinking and doing. Two properties matter more
than plan quality itself:

- every write step names its gate, so the executor can never perform an
  unapproved side effect by omission;
- a missing fact becomes a question, not a guess — the plan returns
  `questionsForUser` and the task parks in blocked(needs_info) rather than
  inventing a deadline or a recipient.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from ensemble_agent.models import ModelAuthError
from ensemble_agent.tools.catalog import TOOLS, AutonomyLevel, catalog_for_prompt, gate_for

try:
    import structlog

    log = structlog.get_logger(__name__)
except Exception:  # pragma: no cover
    import logging

    log = logging.getLogger(__name__)

PROMPT_VERSION = "planner@2026-09-16"
MAX_STEPS = 8
Gate = Literal["none", "policy", "approval"]

#: Task types whose entire purpose is to produce something that leaves the
#: system. A plan for one of these with no write step has not done the job.
REQUIRES_WRITE_STEP = frozenset({"reply_email", "reply_teams", "open_pr", "update_workitem", "schedule"})

PLANNER_PROMPT = """You plan work for an engineer's personal agent.

<<IDENTITY>>

Task: <<TITLE>>
Detail: <<DESCRIPTION>>
Autonomy for this task: <<AUTONOMY>>

Context already gathered:
<<CONTEXT>>

Answers the engineer has already given you:
<<ANSWERS>>

Suggested personal skills: <<SKILLS>>

Tools you may use:
<<TOOLS>>

Return ONLY JSON:
{
  "goal": "one sentence",
  "successCriteria": ["checkable outcome"],
  "steps": [
    {
      "id": "s1",
      "title": "...",
      "tool": "<tool name or null>",
      "risk": "low|medium|high",
      "gate": "none|policy|approval",
      "skill": "<skill id or null>",
      "query": "short topical search terms for a read step, or null"
    }
  ],
  "questionsForUser": [
    {"question": "...", "options": [{"id": "o1", "label": "..."}], "allowFreeText": true}
  ]
}

Rules:
- At most <<MAX_STEPS>> steps.
- For research.papers set a concise topical query, not the task title.
- Every step that writes anything must name its tool AND its gate.
- Never invent a fact. If something required is missing from the context above, add it to questionsForUser and leave it out of the steps.
- If the answers section already covers what you were missing, treat it as fact and return an empty questionsForUser. Do not ask the same thing twice.
- Only ask about facts that block a step. If you can plan the work, plan it.
- Draft steps come before send steps. The last write step is always the one that leaves the system.
"""


@dataclass(slots=True)
class PlannedStep:
    id: str
    title: str
    tool: str | None = None
    risk: str = "low"
    gate: Gate = "none"
    skill: str | None = None
    query: str | None = None
    since_year: int | None = None
    until_year: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "tool": self.tool,
            "risk": self.risk,
            "gate": self.gate,
            "skill": self.skill,
            "query": self.query,
            "sinceYear": self.since_year,
            "untilYear": self.until_year,
        }


@dataclass(slots=True)
class UserQuestion:
    """A fact the agent needs before it can continue."""

    question: str
    options: list[dict[str, str]] = field(default_factory=list)
    allow_free_text: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "options": self.options,
            "allowFreeText": self.allow_free_text,
        }


@dataclass(slots=True)
class Plan:
    goal: str
    success_criteria: list[str] = field(default_factory=list)
    steps: list[PlannedStep] = field(default_factory=list)
    questions: list[UserQuestion] = field(default_factory=list)
    prompt_version: str = PROMPT_VERSION
    from_model: bool = False
    planner_model: str | None = None
    planner_credits: float | None = 0.0

    @property
    def blocked(self) -> bool:
        """A plan that needs an answer first must not start executing."""
        return bool(self.questions)

    def to_dict(self) -> dict[str, Any]:
        return {
            "goal": self.goal,
            "successCriteria": self.success_criteria,
            "steps": [step.to_dict() for step in self.steps],
            "questionsForUser": [question.to_dict() for question in self.questions],
            "promptVersion": self.prompt_version,
            "fromModel": self.from_model,
            "plannerModel": self.planner_model,
            "plannerCredits": self.planner_credits,
        }


@dataclass(slots=True)
class PlanningCost:
    model: str | None = None
    credits: float | None = 0.0

    def charge(self, completion_model: str, amount: float | None) -> None:
        self.model = completion_model
        if self.credits is not None and amount is not None:
            self.credits = self.credits + amount
        else:
            self.credits = None


def _charged(plan: Plan, cost: PlanningCost) -> Plan:
    plan.planner_model = cost.model
    plan.planner_credits = cost.credits
    return plan


def _template_plan(task_type: str, title: str, autonomy: AutonomyLevel) -> Plan:
    """The built-in plan for a task type (docs/05 §7)."""
    templates: dict[str, list[tuple[str, str | None, str | None]]] = {
        "reply_email": [
            ("Read the thread and gather the facts", "graph.mail.read", None),
            ("Draft the reply in your tone", "llm.draft", "email-reply.default"),
            ("Send the reply", "graph.mail.send", None),
        ],
        "reply_teams": [
            ("Read the chat", "graph.chat.read", None),
            ("Draft the reply in your tone", "llm.draft", "teams-reply.default"),
            ("Post the message", "graph.chat.post", None),
        ],
        "open_pr": [
            ("Apply the change", "workspace.fs.write", "coding-prefs.default"),
            ("Run the tests", "workspace.repo.run", None),
            ("Commit", "workspace.repo.commit", "commit-message.default"),
            ("Push the branch", "workspace.repo.push_branch", None),
            ("Open the pull request", "github.pr.create", "pr-description.default"),
        ],
        "review_pr": [
            ("Read the pull request and its comments", "github.pr.read", None),
            ("Summarise what is being asked of you", "llm.summarize", None),
        ],
        "write_doc": [
            ("Gather the relevant context", "llm.summarize", None),
            ("Draft the document", "llm.draft", None),
        ],
        "schedule": [
            ("Read the calendar", "graph.calendar.read", None),
            ("Propose a slot", "llm.draft", "day-planning.default"),
            ("Create the event", "graph.calendar.create_event", None),
        ],
        "research": [
            ("Retrieve published sources for the research question", "research.papers", None),
            ("Summarise the findings", "llm.draft", None),
        ],
    }
    steps_spec = templates.get(
        task_type,
        [
            ("Gather the related context", "llm.summarize", None),
            ("Draft the work", "llm.draft", None),
        ],
    )
    steps: list[PlannedStep] = []
    for title_text, tool, skill in steps_spec[:MAX_STEPS]:
        spec = TOOLS.get(tool or "")
        steps.append(
            PlannedStep(
                id=str(uuid.uuid4()),
                title=title_text,
                tool=tool,
                risk=spec.risk if spec else "low",
                gate=gate_for(tool, autonomy) if tool else "none",
                skill=skill,
            )
        )
    return Plan(goal=title, success_criteria=[f"{title} is done and recorded on the board."], steps=steps)


def skill_names(skills: list[Any]) -> list[str]:
    names: list[str] = []
    for skill in skills:
        if isinstance(skill, str):
            names.append(skill)
        elif isinstance(skill, dict):
            names.append(str(skill.get("name") or skill.get("id") or "skill"))
    return names


def _parse_plan(payload: dict[str, Any], autonomy: AutonomyLevel) -> Plan:
    steps: list[PlannedStep] = []
    for raw in (payload.get("steps") or [])[:MAX_STEPS]:
        if not isinstance(raw, dict):
            continue
        tool = raw.get("tool")
        tool_name = str(tool) if tool else None
        spec = TOOLS.get(tool_name or "")
        declared_gate = raw.get("gate")
        gate: Gate = gate_for(tool_name, autonomy) if tool_name else "none"
        if declared_gate in {"none", "policy", "approval"} and tool_name and spec and not spec.is_write:
            gate = "none"
        elif tool_name:
            # Never trust a hallucinated "gate": "none" on a write.
            gate = gate_for(tool_name, autonomy)
        steps.append(
            PlannedStep(
                id=str(raw.get("id") or uuid.uuid4()),
                title=str(raw.get("title") or "step"),
                tool=tool_name,
                risk=str(raw.get("risk") or (spec.risk if spec else "low")),
                gate=gate,
                skill=str(raw["skill"]) if raw.get("skill") else None,
                query=str(raw["query"]) if raw.get("query") else None,
            )
        )
    questions: list[UserQuestion] = []
    for raw in payload.get("questionsForUser") or []:
        if not isinstance(raw, dict) or not raw.get("question"):
            continue
        options = raw.get("options") if isinstance(raw.get("options"), list) else []
        questions.append(
            UserQuestion(
                question=str(raw["question"]),
                options=[item for item in options if isinstance(item, dict)],
                allow_free_text=bool(raw.get("allowFreeText", True)),
            )
        )
    return Plan(
        goal=str(payload.get("goal") or ""),
        success_criteria=[str(item) for item in payload.get("successCriteria") or []],
        steps=steps,
        questions=questions,
        from_model=True,
    )


async def _model_plan(
    *,
    task: dict[str, Any],
    autonomy: AutonomyLevel,
    identity: str,
    context_summary: str,
    skills: list[Any],
    answers: list[str] | None = None,
    model: str | None = None,
    cost: PlanningCost | None = None,
    allowed_tools: list[str] | None = None,
) -> Plan | None:
    from ensemble_agent.models import complete_json

    answers_text = "\n".join(f"- {item}" for item in answers) if answers else "(none yet — this is the first attempt)"
    prompt = (
        PLANNER_PROMPT.replace("<<IDENTITY>>", identity or "(identity unavailable)")
        .replace("<<TITLE>>", str(task.get("title") or ""))
        .replace("<<DESCRIPTION>>", str(task.get("description") or ""))
        .replace("<<AUTONOMY>>", autonomy)
        .replace("<<CONTEXT>>", context_summary or "(no context gathered)")
        .replace("<<ANSWERS>>", answers_text)
        .replace("<<SKILLS>>", ", ".join(skill_names(skills)) or "(none)")
        .replace("<<TOOLS>>", catalog_for_prompt(allowed_tools))
        .replace("<<MAX_STEPS>>", str(MAX_STEPS))
    )
    if allowed_tools is not None:
        prompt += "\nOnly use tools from the list above. This worker is single-purpose."
    try:
        payload, used_model, credits = await complete_json(prompt, model=model, role="planner")
    except ModelAuthError:
        return None
    except Exception as exc:
        log.warning("planner_model_failed", error=str(exc))
        return None
    if cost is not None:
        cost.charge(used_model, credits)
    if not isinstance(payload, dict):
        return None
    return _parse_plan(payload, autonomy)


async def build_plan(
    task: dict[str, Any],
    autonomy: AutonomyLevel = "assist",
    identity: str = "",
    context_summary: str = "",
    skills: list[Any] | None = None,
    answers: list[str] | None = None,
    model: str | None = None,
    allowed_tools: list[str] | None = None,
) -> Plan:
    """Builds a plan, preferring the model and falling back to a template.

    `model` is the task's complexity tier resolved to a concrete model. Planning
    runs on the same model the work will, because deciding how is at least as
    demanding as doing it.
    """
    task_type = str(task.get("taskType") or "other")
    fallback_type = "research" if allowed_tools is not None else task_type
    title = str(task.get("title") or "Untitled task")
    cost = PlanningCost()
    plan = await _model_plan(
        task=task,
        autonomy=autonomy,
        identity=identity,
        context_summary=context_summary,
        skills=skills or [],
        answers=answers or [],
        model=model,
        cost=cost,
        allowed_tools=allowed_tools,
    )
    if plan is not None:
        plan.planner_model = cost.model
        plan.planner_credits = cost.credits
        if answers and plan.questions:
            log.info("planner_dropping_repeat_questions", count=len(plan.questions))
            plan.questions = []
        if plan.blocked:
            return plan
        if allowed_tools is not None and any(step.tool not in allowed_tools for step in plan.steps if step.tool):
            log.warning("planner_tool_outside_worker_scope", task_type=task_type)
            return _charged(_template_plan(fallback_type, title, autonomy), cost)
        if (
            allowed_tools is None
            and task_type in REQUIRES_WRITE_STEP
            and not any((spec := TOOLS.get(step.tool or "")) and spec.is_write for step in plan.steps)
        ):
            log.warning("planner_plan_has_no_write_step", task_type=task_type)
            return _charged(_template_plan(fallback_type, title, autonomy), cost)
        return plan
    log.info("planner_using_template", task_type=task_type)
    return _charged(_template_plan(task_type, title, autonomy), cost)
