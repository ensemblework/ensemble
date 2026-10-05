"""Action policy — the gates (docs/07 §2).

`decide` is the one place that answers *may the agent do this, now, unattended?*.
The catalog says how risky a tool is; this module combines that with the task's
autonomy level and the engineer's settings to return allow, require_approval or
deny.

Three properties matter more than the rule list itself:

- **It fails closed.** An unknown tool is denied, not allowed. A plan that names
  something the catalog has never heard of is a bug or a hallucination, and
  neither should reach a live mailbox.
- **It cannot be argued out of a deny.** Forbidden actions are refused at every
  autonomy level, including autonomous. There is no "the user asked nicely" path
  to deleting mail.
- **Every decision carries the rule that produced it**, so the ledger and the
  approval card can say *why* rather than just *no*.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Literal

from ensemble_agent.tools.catalog import (
    FORBIDDEN_TOOLS,
    AutonomyLevel,
    ToolSpec,
    get_tool,
    requires_approval,
)

Decision = Literal["allow", "require_approval", "deny"]

SENSITIVE_PATTERNS: dict[str, tuple[str, ...]] = {
    "money": (
        r"\bsalary\b",
        r"\bcompensation\b",
        r"\binvoice\b",
        r"\bpayment\b",
        r"\bbudget\b",
        r"\bpurchase order\b",
        r"\bwire transfer\b",
        r"\bbank\b",
        r"\bpricing\b",
    ),
    "legal": (
        r"\blegal\b",
        r"\bcontract\b",
        r"\bliabilit",
        r"\bindemnif",
        r"\blitigation\b",
        r"\bintellectual property\b",
    ),
    "hr": (
        r"\bperformance review\b",
        r"\btermination\b",
        r"\bresignation\b",
        r"\blayoff\b",
        r"\bpromotion\b",
        r"\bdisciplinary\b",
        r"\bgrievance\b",
        r"\bheadcount\b",
        r"\bhiring decision\b",
        r"\bconfidential hr\b",
    ),
}

_COMPILED: dict[str, tuple[re.Pattern[str], ...]] = {
    category: tuple(re.compile(pattern, re.IGNORECASE) for pattern in patterns)
    for category, patterns in SENSITIVE_PATTERNS.items()
}

#: Where to look for recipients in a step payload.
_RECIPIENT_KEYS = ("to", "cc", "bcc", "recipients", "attendees", "reviewers")
_TEXT_KEYS = ("subject", "body", "text", "message", "title", "description", "comment")

#: Teams thread ids look like email addresses (`19:…@thread.v2`).
_NON_MAIL_DOMAINS: frozenset[str] = frozenset(
    {"thread.v2", "thread.skype", "ung-gbl.spaces", "thread.tacv2"}
)
_EMAIL_RE = re.compile(r"(?P<local>[\w.+-]+)@(?P<domain>[\w.-]+\.[\w.-]+)")


@dataclass(frozen=True, slots=True)
class UserSettings:
    """The engineer's governance preferences."""

    tenant_domains: frozenset[str] = frozenset({"ensemble.local"})
    daily_high_risk_limit: int = 20
    sensitive_categories: frozenset[str] = frozenset({"money", "legal", "hr"})
    allow_external_recipients: bool = False

    @classmethod
    def from_env(cls) -> UserSettings:
        raw = os.environ.get("ENSEMBLE_TENANT_DOMAINS", "ensemble.local")
        domains = frozenset(part.strip().lower() for part in raw.split(",") if part.strip())
        limit = int(os.environ.get("ENSEMBLE_DAILY_HIGH_RISK_LIMIT", "20"))
        allow_external = os.environ.get("ENSEMBLE_ALLOW_EXTERNAL_RECIPIENTS", "").lower() in {"1", "true"}
        return cls(
            tenant_domains=domains or frozenset({"ensemble.local"}),
            daily_high_risk_limit=limit,
            allow_external_recipients=allow_external,
        )


@dataclass(frozen=True, slots=True)
class PolicyDecision:
    """The verdict, plus enough context for the ledger and the approval card."""

    decision: Decision
    rule: str
    reason: str
    detail: dict[str, Any] = field(default_factory=dict)

    def allowed(self) -> bool:
        return self.decision == "allow"

    def to_dict(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "rule": self.rule,
            "reason": self.reason,
            "detail": self.detail,
        }


def external_recipients(payload: Any, tenant_domains: frozenset[str]) -> list[str]:
    """Returns recipient addresses whose domain is outside the tenant."""
    if not isinstance(payload, dict):
        return []
    found: list[str] = []
    for key in _RECIPIENT_KEYS:
        value = payload.get(key)
        if value is None:
            continue
        candidates = value if isinstance(value, (list, tuple)) else [value]
        for candidate in candidates:
            address = _address_of(candidate)
            if not address:
                continue
            if not _is_external(address, tenant_domains):
                continue
            found.append(address)
    return sorted(set(found))


def _is_external(address: str, tenant_domains: frozenset[str]) -> bool:
    match = _EMAIL_RE.search(address)
    if match is None:
        return False
    if ":" in match.group("local") or ":" in address.split("@", 1)[0]:
        return False
    domain = match.group("domain").lower()
    if domain in _NON_MAIL_DOMAINS:
        return False
    return domain not in {item.lower() for item in tenant_domains}


def _address_of(candidate: Any) -> str | None:
    """Pulls an address out of a string, or out of Graph's nested shape."""
    if isinstance(candidate, str):
        return candidate
    if isinstance(candidate, dict):
        for key in ("address", "email", "emailAddress", "upn"):
            value = candidate.get(key)
            if isinstance(value, str):
                return value
            if isinstance(value, dict) and isinstance(value.get("address"), str):
                return value["address"]
    return None


def sensitive_categories(payload: Any, categories: frozenset[str]) -> list[str]:
    text = _text_of(payload)
    if not text:
        return []
    return [
        category
        for category in sorted(categories)
        if category in _COMPILED and any(pattern.search(text) for pattern in _COMPILED[category])
    ]


def _text_of(payload: Any) -> str:
    if isinstance(payload, str):
        return payload
    if not isinstance(payload, dict):
        return ""
    parts: list[str] = []
    for key in _TEXT_KEYS:
        value = payload.get(key)
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, dict) and isinstance(value.get("content"), str):
            parts.append(value["content"])
    return "\n".join(parts)


def decide(
    *,
    tool: str | None,
    payload: Any = None,
    autonomy: AutonomyLevel = "assist",
    settings: UserSettings | None = None,
    high_risk_writes_today: int = 0,
) -> PolicyDecision:
    """Decides whether one step may run unattended.

    Rules are evaluated strongest-first, so a deny can never be downgraded.
    """
    cfg = settings or UserSettings.from_env()
    if tool is None:
        return PolicyDecision("allow", "no_tool", "Reasoning step; nothing leaves the system.")
    if tool in FORBIDDEN_TOOLS:
        return PolicyDecision(
            "deny",
            "forbidden_tool",
            f"{tool} is never permitted — destructive or permission-changing actions are outside what the agent may do.",
            {"tool": tool},
        )
    spec: ToolSpec | None = get_tool(tool)
    if spec is None:
        return PolicyDecision(
            "deny",
            "unknown_tool",
            f"{tool} is not in the tool catalog, so its risk is unknown.",
            {"tool": tool},
        )
    if not spec.is_write:
        return PolicyDecision("allow", "read_only", f"{tool} only reads.", {"tool": tool, "risk": spec.risk})
    if not cfg.allow_external_recipients:
        outside = external_recipients(payload, cfg.tenant_domains)
        if outside:
            verb = "is" if len(outside) == 1 else "are"
            return PolicyDecision(
                "require_approval",
                "external_recipient",
                f"{_join(outside)} {verb} outside the tenant.",
                {"tool": tool, "recipients": outside},
            )
    hits = sensitive_categories(payload, cfg.sensitive_categories)
    if hits:
        return PolicyDecision(
            "require_approval",
            "sensitive_content",
            f"Mentions {_join(hits)} content, which always needs your eyes.",
            {"tool": tool, "categories": hits},
        )
    if spec.risk == "high" and autonomy == "autonomous" and high_risk_writes_today >= cfg.daily_high_risk_limit:
        return PolicyDecision(
            "require_approval",
            "rate_limited",
            f"Already {high_risk_writes_today} high-risk writes today (limit {cfg.daily_high_risk_limit}); pausing unattended sending.",
            {"tool": tool, "count": high_risk_writes_today, "limit": cfg.daily_high_risk_limit},
        )
    if requires_approval(tool, autonomy):
        return PolicyDecision(
            "require_approval",
            "autonomy_gate",
            f"{tool} is a {spec.risk}-risk write and autonomy is '{autonomy}'.",
            {"tool": tool, "risk": spec.risk, "autonomy": autonomy},
        )
    return PolicyDecision(
        "allow",
        "autonomy_gate",
        f"{tool} may proceed unattended at autonomy '{autonomy}'; it is still audited.",
        {
            "tool": tool,
            "risk": spec.risk,
            "autonomy": autonomy,
            "undoWindowSeconds": spec.undo_window_seconds,
        },
    )


def _join(values: list[str]) -> str:
    if len(values) == 1:
        return values[0]
    return ", ".join(values[:-1]) + f" and {values[-1]}"
