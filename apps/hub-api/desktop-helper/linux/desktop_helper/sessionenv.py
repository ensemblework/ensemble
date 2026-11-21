"""The graphical session the helper works in. A runner started by a systemd user unit before the owner
logged in has no display variables; the user manager learns them at login (GNOME imports them), so the
missing ones are read from there. Values are used, never printed or logged."""
from __future__ import annotations

import os
from typing import Callable, Iterable, Mapping

SESSION_KEYS = ("WAYLAND_DISPLAY", "DISPLAY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION", "XAUTHORITY")


def parse_assignments(lines: Iterable[str], wanted: Iterable[str] = SESSION_KEYS) -> dict[str, str]:
    """`KEY=VALUE` strings (the systemd manager's Environment property), only the wanted keys."""
    keep = set(wanted)
    found: dict[str, str] = {}
    for line in lines:
        if not isinstance(line, str) or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in keep and value and "\n" not in value and "\0" not in value:
            found[key] = value
    return found


def complete(env: Mapping[str, str], manager_environment: Callable[[], list[str]] | None) -> dict[str, str]:
    """`env` with the session keys it lacks taken from the user manager (when it can be asked)."""
    out = dict(env)
    missing = [key for key in SESSION_KEYS if not out.get(key)]
    if not missing or manager_environment is None:
        return out
    try:
        extra = parse_assignments(manager_environment(), missing)
    except Exception:
        return out
    out.update(extra)
    return out


def runtime_dir(env: Mapping[str, str]) -> str:
    value = env.get("XDG_RUNTIME_DIR")
    return value if value else f"/run/user/{os.getuid()}"


def session_type(env: Mapping[str, str]) -> str:
    """wayland, x11, tty or unknown, checked against the sockets that should exist."""
    declared = (env.get("XDG_SESSION_TYPE") or "").lower()
    wayland = env.get("WAYLAND_DISPLAY")
    if wayland:
        socket = wayland if os.path.isabs(wayland) else os.path.join(runtime_dir(env), wayland)
        if os.path.exists(socket):
            return "wayland"
    if env.get("DISPLAY") and declared != "wayland":
        return "x11"
    if declared in ("tty", "x11", "wayland"):
        return declared if declared != "wayland" else "unknown"
    return "unknown"


def manager_environment_reader(bus) -> Callable[[], list[str]]:
    """A reader of the systemd user manager's Environment property over `bus` (a Gio.DBusConnection)."""

    def read() -> list[str]:
        from gi.repository import GLib, Gio

        reply = bus.call_sync(
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.DBus.Properties",
            "Get",
            GLib.Variant("(ss)", ("org.freedesktop.systemd1.Manager", "Environment")),
            GLib.VariantType("(v)"),
            Gio.DBusCallFlags.NONE,
            3000,
            None,
        )
        value = reply.unpack()[0]
        return [item for item in value if isinstance(item, str)]

    return read
