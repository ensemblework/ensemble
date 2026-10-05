from __future__ import annotations

from typing import Any

import httpx

from ensemble_agent.config import get_settings


class RunReporter:
    def __init__(self, run_id: str, user_id: str) -> None:
        self.run_id = run_id
        self.user_id = user_id

    async def step(self, **payload: Any) -> None:
        settings = get_settings()
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{settings.hub_api}/api/internal/runs/{self.run_id}/steps",
                    headers={"x-ensemble-internal": settings.internal_token, "x-ensemble-user": self.user_id},
                    json=payload,
                )
        except Exception:
            return
