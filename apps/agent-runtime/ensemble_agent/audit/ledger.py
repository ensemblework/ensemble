"""Append-only audit writer used by the runtime.

The Hub's Prisma ledger is the source of truth. This client posts a row through
hub-api so Python never opens its own Prisma client.
"""

from __future__ import annotations

from typing import Any

import httpx

from ensemble_agent.config import get_settings


async def append_entry(
    *,
    user_id: str,
    actor: str,
    action: str,
    task_id: str | None = None,
    run_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    settings = get_settings()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{settings.hub_api}/api/internal/ledger",
                headers={"x-ensemble-internal": settings.internal_token, "x-ensemble-user": user_id},
                json={
                    "actor": actor if actor in {"agent", "me", "system"} else "agent",
                    "action": action,
                    "taskId": task_id,
                    "runId": run_id,
                    "payload": payload or {},
                },
            )
    except Exception:
        # Ledger write must not block a legitimate first send (docs/07 idempotency).
        return
