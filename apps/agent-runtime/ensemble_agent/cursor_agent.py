"""Cursor cloud agents.

Cursor's API starts an agent on a repository. It does not answer a chat
completion, so the Hub chat never calls this. Assign-to-agent can call
`launch` once that button is wired. `models` is safe to call: it only lists
what the key is allowed to run.
"""

from __future__ import annotations

from typing import Any

import httpx

from ensemble_agent import credentials

API = "https://api.cursor.com/v0"


async def models(user_id: str | None) -> list[str]:
    cred = credentials.resolve(user_id, "cursor")
    if not cred.secret:
        raise RuntimeError("No Cursor key. Paste one in Settings → Models.")
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(f"{API}/models", auth=(cred.secret, ""))
    if not response.is_success:
        raise RuntimeError(f"Cursor refused the key ({response.status_code}).")
    return list(response.json().get("models", []))


CHEAPEST_AGENT = "composer-2.5"


async def launch(user_id: str | None, *, prompt: str, repository: str, model: str = CHEAPEST_AGENT, ref: str = "main") -> dict[str, Any]:
    """Start a cloud agent. Not called by chat or by the current Assign button."""
    cred = credentials.resolve(user_id, "cursor")
    if not cred.secret:
        raise RuntimeError("No Cursor key. Paste one in Settings → Models.")
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{API}/agents",
            auth=(cred.secret, ""),
            json={"prompt": {"text": prompt}, "model": model, "source": {"repository": repository, "ref": ref}},
        )
    if not response.is_success:
        raise RuntimeError(f"Cursor did not start an agent ({response.status_code}): {response.text[:300]}")
    return response.json()
