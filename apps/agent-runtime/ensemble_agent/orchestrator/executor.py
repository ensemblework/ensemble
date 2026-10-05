"""Executor (docs/05 §6) — walks a plan, stopping at every gate.

The loop itself is small; the guarantees around it are the point:

- **Resumable.** The cursor is persisted after each step, so a restart continues
  instead of re-sending an email that already went out.
- **Gated.** A write step that needs approval raises before the tool runs, never
  after. The approval carries the exact payload, and the *edited* payload is
  what executes.
- **Pausable.** The executor checks the pause flag before each step.
- **Bounded.** Two retries with backoff, then the step fails with a readable
  message and the task returns to the board — never silently dropped.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from ensemble_agent.audit.ledger import append_entry
from ensemble_agent.hub_client import RunReporter
from ensemble_agent.orchestrator.planner import Plan, PlannedStep
from ensemble_agent.tools.catalog import TOOLS, AutonomyLevel
from ensemble_agent.tools.guarded import ApprovalRequired, guarded_write

try:
    import structlog

    log = structlog.get_logger(__name__)
except Exception:  # pragma: no cover
    import logging

    log = logging.getLogger(__name__)

MAX_RETRIES = 2
BASE_BACKOFF_SECONDS = 2.0


class RunPaused(Exception):  # noqa: N818 — control flow, not a failure
    """Raised when the engineer paused the agent mid-run."""


@dataclass(slots=True)
class StepOutcome:
    step: PlannedStep
    status: str
    output: str | None = None
    error: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    attempts: int = 1
    reasoning: str = ""
    reasoning_source: str = "none"
    model: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    credits: float | None = 0.0
    ok: bool = True
    calls: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class ExecutionResult:
    outcomes: list[StepOutcome] = field(default_factory=list)
    awaiting_approval: dict[str, Any] | None = None
    paused: bool = False
    failed: bool = False
    error: str | None = None

    @property
    def completed(self) -> bool:
        return not self.failed and not self.paused and self.awaiting_approval is None


StepHandler = Callable[[PlannedStep, dict[str, Any]], Awaitable[tuple[str, list[dict[str, Any]]]]]
PreviewBuilder = Callable[[PlannedStep, dict[str, Any]], Awaitable[dict[str, Any]]]
RichHandler = Callable[[PlannedStep, dict[str, Any]], Awaitable[StepOutcome]]


def _approval_kind(tool: str) -> str:
    if tool.endswith(".send") or "mail.send" in tool:
        return "send_email"
    if tool.endswith(".post") or "chat.post" in tool:
        return "post_teams"
    if tool.endswith("pr.create"):
        return "open_pr"
    return "other"


def _redact_preview(payload: dict[str, Any]) -> dict[str, Any]:
    redacted = dict(payload)
    for key in ("token", "accessToken", "refreshToken", "password", "secret"):
        if key in redacted:
            redacted[key] = "[redacted]"
    return redacted


def _retry_delay(exc: Exception, attempt: int) -> float:
    """Backoff, honouring a server's Retry-After when it gives one."""
    retry_after = getattr(exc, "retry_after", None)
    if retry_after is None and getattr(exc, "status_code", None) == 429:
        retry_after = getattr(exc, "headers", {}).get("Retry-After") if hasattr(exc, "headers") else None
    if retry_after is not None:
        try:
            return max(float(retry_after), 0.5)
        except (TypeError, ValueError):
            pass
    return BASE_BACKOFF_SECONDS * (2**attempt)


class Executor:
    """Runs a plan, one step at a time."""

    def __init__(
        self,
        reporter: RunReporter,
        autonomy: AutonomyLevel = "assist",
        is_paused: Callable[[], Awaitable[bool]] | None = None,
        rich_handler: RichHandler | None = None,
    ) -> None:
        self.reporter = reporter
        self._autonomy = autonomy
        self._is_paused = is_paused
        self._rich_handler = rich_handler

    async def run(
        self,
        plan: Plan,
        job: dict[str, Any],
        *,
        handler: StepHandler,
        preview: PreviewBuilder | None = None,
        start_at: int = 0,
        approved_payload: dict[str, Any] | None = None,
    ) -> ExecutionResult:
        """Executes from `start_at`.

        `start_at` and `approved_payload` are how a parked run resumes: the
        orchestrator re-enters at the gated step with the payload the engineer
        actually approved.
        """
        result = ExecutionResult()
        for index, step in enumerate(plan.steps):
            if index < start_at:
                result.outcomes.append(StepOutcome(step=step, status="done"))
                continue
            if await self.paused():
                log.info("run_paused", step=step.id, index=index)
                await self.reporter.step(index=index, title=step.title, status="pending", output="Paused by you.")
                result.paused = True
                return result
            await self.reporter.step(index=index, title=step.title, status="running")
            try:
                outcome = await self._run_step(
                    index=index,
                    step=step,
                    job=job,
                    handler=handler,
                    preview=preview,
                    approved_payload=approved_payload if index == start_at else None,
                )
            except ApprovalRequired as gate:
                await self.reporter.step(index=index, title=step.title, status="needs_approval")
                result.awaiting_approval = {
                    "stepIndex": index,
                    "stepId": step.id,
                    "kind": gate.kind,
                    "preview": gate.preview,
                    "reason": gate.reason,
                    "title": step.title,
                }
                log.info("run_awaiting_approval", step=step.id, kind=gate.kind)
                return result
            except Exception as exc:
                await self.reporter.step(index=index, title=step.title, status="failed", error=str(exc))
                result.outcomes.append(StepOutcome(step=step, status="failed", error=str(exc)))
                result.failed = True
                result.error = str(exc)
                log.exception("step_failed", step=step.id)
                return result
            result.outcomes.append(outcome)
            await self.reporter.step(
                index=index,
                title=step.title,
                status=outcome.status,
                output=outcome.output,
                tool_calls=outcome.tool_calls,
                reasoning=outcome.reasoning,
                reasoning_source=outcome.reasoning_source,
                model=outcome.model,
                tokens_in=outcome.tokens_in,
                tokens_out=outcome.tokens_out,
                ai_credits=outcome.credits,
                error=outcome.error,
            )
            if outcome.status == "failed":
                result.failed = True
                result.error = outcome.error
                return result
            approved_payload = None
        return result

    async def paused(self) -> bool:
        if self._is_paused is None:
            return False
        try:
            return await self._is_paused()
        except Exception:
            return False

    async def _run_step(
        self,
        *,
        index: int,
        step: PlannedStep,
        job: dict[str, Any],
        handler: StepHandler,
        preview: PreviewBuilder | None,
        approved_payload: dict[str, Any] | None,
    ) -> StepOutcome:
        spec = TOOLS.get(step.tool or "")
        if spec is not None and spec.is_write:
            payload = approved_payload
            if payload is None and preview is not None:
                payload = await preview(step, job)
            payload = payload or {"summary": step.title}

            async def execute(_preview: dict[str, Any]) -> dict[str, Any]:
                output, calls = await self._perform_write(step, job, payload)
                return {"ok": True, "summary": output, "calls": calls}

            output_result = await guarded_write(
                user_id=str(job.get("userId") or "unknown"),
                kind=_approval_kind(step.tool or ""),  # type: ignore[arg-type]
                preview=payload,
                job={**job, "autonomy": self._autonomy, "stepId": step.id, "tool": step.tool},
                autonomy=self._autonomy,
                execute=execute,
                approved=approved_payload is not None,
            )
            calls = output_result.get("calls") if isinstance(output_result, dict) else None
            summary = output_result.get("summary") if isinstance(output_result, dict) else str(output_result)
            return StepOutcome(step=step, status="done", output=str(summary or ""), tool_calls=calls or [])

        rich = await self._with_retries_rich(step, job, handler)
        await append_entry(
            user_id=str(job.get("userId", "unknown")),
            actor="agent",
            action=f"step.{step.tool or 'think'}",
            task_id=job.get("taskId"),
            run_id=self.reporter.run_id,
            payload={"step": step.title, "index": index},
        )
        return rich

    async def _perform_write(
        self,
        step: PlannedStep,
        job: dict[str, Any],
        payload: dict[str, Any],
    ) -> tuple[str, list[dict[str, Any]]]:
        """Performs an approved write against the engineer's real accounts.

        The approved payload executes verbatim. Re-deriving it here would
        silently discard an edit the engineer made before approving.
        """
        from ensemble_agent.tools.execute import call_hub_tool

        tool = step.tool or ""
        result = await call_hub_tool(tool, payload, approved=True, run_id=self.reporter.run_id)
        summary = str(result.get("summary") or "")
        if not result.get("ok", False):
            raise RuntimeError(summary or f"{tool} failed")
        call = {
            "id": f"{step.id}-call",
            "server": tool.split(".")[0],
            "tool": tool,
            "risk": step.risk,
            "isWrite": True,
            "input": _redact_preview(payload),
            "output": {},
            "ok": True,
            "summary": summary,
        }
        if result.get("externalId"):
            call["externalId"] = result["externalId"]
        if result.get("url"):
            call["url"] = result["url"]
        return summary, [call]

    async def _with_retries_rich(
        self,
        step: PlannedStep,
        job: dict[str, Any],
        handler: StepHandler,
    ) -> StepOutcome:
        if self._rich_handler is None:
            output, tool_calls = await self._with_retries(step, job, handler)
            return StepOutcome(step=step, status="done", output=output, tool_calls=tool_calls)
        last: Exception | None = None
        for attempt in range(MAX_RETRIES + 1):
            try:
                outcome = await self._rich_handler(step, job)
                outcome.attempts = attempt + 1
                return outcome
            except ApprovalRequired:
                raise
            except Exception as exc:
                last = exc
                if attempt == MAX_RETRIES:
                    break
                delay = _retry_delay(exc, attempt)
                log.warning("step_retry", step=step.id, attempt=attempt + 1, delay=delay, error=str(exc))
                await asyncio.sleep(delay)
        raise last if last else RuntimeError("step failed with no error recorded")

    async def _with_retries(
        self,
        step: PlannedStep,
        job: dict[str, Any],
        handler: StepHandler,
    ) -> tuple[str, list[dict[str, Any]]]:
        last: Exception | None = None
        for attempt in range(MAX_RETRIES + 1):
            try:
                return await handler(step, job)
            except ApprovalRequired:
                raise
            except Exception as exc:
                last = exc
                if attempt == MAX_RETRIES:
                    break
                delay = _retry_delay(exc, attempt)
                log.warning("step_retry", step=step.id, attempt=attempt + 1, delay=delay, error=str(exc))
                await asyncio.sleep(delay)
        raise last if last else RuntimeError("step failed with no error recorded")
