"""Readiness facts. Each one says what a real probe found, never what is assumed: a fact not probed yet
is `untested`, a failed probe stays `failed` until a later probe works."""
from __future__ import annotations

import time
from typing import Any


def fact(state: str, detail: str | None = None, fix: str | None = None, **extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"state": state}
    if detail:
        out["detail"] = detail
    if fix:
        out["fix"] = fix
    out.update({key: value for key, value in extra.items() if value is not None})
    return out


class Proven:
    """Facts only real use proves (a frame captured, an input accepted), with when."""

    def __init__(self) -> None:
        self._facts: dict[str, dict[str, Any]] = {}

    def worked(self, name: str, detail: str | None = None) -> None:
        self._facts[name] = fact("working", detail, at=int(time.time() * 1000))

    def failed(self, name: str, detail: str, fix: str | None = None) -> None:
        self._facts[name] = fact("failed", detail, fix, at=int(time.time() * 1000))

    def get(self, name: str, untested: str) -> dict[str, Any]:
        return self._facts.get(name) or fact("untested", untested)


PACKAGES = "sudo apt install python3-gi gir1.2-atspi-2.0 gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-good"


def session_fact(kind: str, desktop: str | None) -> dict[str, Any]:
    if kind == "wayland":
        return fact("working", f"Wayland ({desktop or 'unknown desktop'})", kind=kind)
    if kind == "x11":
        return fact("failed", "An X11 session: Ensemble controls GNOME on Wayland through the desktop portals.", "Sign in to the GNOME (Wayland) session.", kind=kind)
    return fact("failed", "No graphical session reaches this runtime.", "Run Ensemble inside your desktop session (sign in at the computer; `ensemble runner start` from a terminal there).", kind=kind)


def portal_fact(versions: dict[str, int | None]) -> dict[str, Any]:
    remote = versions.get("RemoteDesktop")
    cast = versions.get("ScreenCast")
    if remote is None or cast is None:
        return fact("failed", "The desktop portal has no RemoteDesktop or ScreenCast here.", "Install xdg-desktop-portal and the backend for your desktop (xdg-desktop-portal-gnome).", versions=versions)
    if remote < 2 or cast < 4:
        return fact("failed", f"The portal is too old to remember your answer (RemoteDesktop {remote}, ScreenCast {cast}).", "Update xdg-desktop-portal to 1.18 or later.", versions=versions)
    return fact("working", f"RemoteDesktop {remote}, ScreenCast {cast}", versions=versions)


def consent_fact(session_state: str, token_saved: bool, last_start: dict[str, Any] | None) -> dict[str, Any]:
    if session_state == "on":
        return fact("working", "Screen control is on now.")
    if session_state == "waiting":
        return fact("waiting", "The dialog asking to allow remote interaction is open on this computer's screen.", "Your owner answers it at the computer once; later sessions start without it.")
    if session_state == "denied":
        return fact("failed", "Your owner did not allow remote interaction.", "Ask your owner; the dialog appears again on the next use.")
    if token_saved:
        silent = bool(last_start and last_start.get("silent"))
        return fact("granted_earlier", "Allowed before; the next session starts without a dialog." if silent else "Allowed before.", at=(last_start or {}).get("at"))
    return fact("needed", "Nobody allowed remote interaction on this computer yet.", "The first use shows a dialog on the computer's screen; your owner allows it there once.")


def a11y_fact(apps: int | None, failure: str | None) -> dict[str, Any]:
    if failure:
        return fact("failed", failure, "Turn on the accessibility bus (it is on by default in GNOME); then sign out and in.")
    return fact("working", f"{apps} apps on the accessibility bus", apps=apps)


def recorder_fact(choice: dict[str, Any] | None) -> dict[str, Any]:
    if not choice:
        return fact("failed", "No video encoder works here.", "Install gstreamer1.0-plugins-good (VP8) or an H.264 encoder.")
    detail = "MP4 (H.264)" if choice["container"] == "mp4" else "WebM (VP8): no H.264 encoder here"
    return fact("working", detail, container=choice["container"], codec=choice["codec"], encoder=choice["name"])


def screen_fact(locked: bool | None, idle_ms: int | None) -> dict[str, Any]:
    if locked is None:
        return fact("untested", "This desktop does not say whether the screen is locked.", idle_ms=idle_ms)
    if locked:
        return fact("locked", "The screen is locked.", "Your owner unlocks it at the computer; Ensemble never types a password.", idle_ms=idle_ms)
    return fact("unlocked", None, idle_ms=idle_ms)
