"""Connector-facing writes. Real adapters land as connectors are wired.

Until a connector is connected, an approved write is recorded as a no-op with
an honest summary rather than inventing a sent mail.
"""

from __future__ import annotations

from typing import Any


async def call_hub_tool(
    tool: str,
    payload: dict[str, Any],
    *,
    approved: bool,
    run_id: str | None = None,
) -> dict[str, Any]:
    if not approved:
        return {"ok": False, "summary": f"{tool} refused: write was not approved."}
    return {
        "ok": True,
        "summary": f"{tool} is stubbed until that connector is connected. Payload kept for the run {run_id or ''}.",
        "payload": payload,
    }
