"""Installed apps (desktop entries), running apps (systemd user scopes), and starting an app so it
outlives the helper and the runner (a scope of its own, named as the XDG systemd convention says:
`app-<launcher>-<application id>-<random>.scope`)."""
from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess
from typing import Any, Iterable

UNIT_ESCAPE = re.compile(r"\\x([0-9a-fA-F]{2})")
# app-gnome-org.gnome.Calculator-12345.scope, app-cursor-3587639.scope, app-ensemble-org.gnome.Calculator-1a2b3c.scope
APP_SCOPE = re.compile(r"^app-(?:(?P<launcher>[A-Za-z0-9_]+)-)?(?P<app>.+?)-(?P<random>[0-9A-Za-z]+)\.scope$")
# app-gnome-org.gnome.Calculator@12345.service, app-org.gnome.Nautilus@abc.service
APP_SERVICE = re.compile(r"^app-(?:(?P<launcher>[A-Za-z0-9_]+)-)?(?P<app>.+?)(?:@(?P<random>[0-9A-Za-z]+))?\.service$")
# snap.firefox.firefox-f079e53f-6ec6-4a82-ac5d-e7f29b987375.scope
SNAP_SCOPE = re.compile(r"^snap\.(?P<snap>[a-z0-9-]+)\.(?P<app>[A-Za-z0-9-]+?)-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]+)\.scope$")
KNOWN_LAUNCHERS = {"gnome", "kde", "ensemble", "flatpak", "dbus", "xfce", "cinnamon", "mate", "lxqt"}
APP_ID = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,250}$")


def unescape_unit(text: str) -> str:
    return UNIT_ESCAPE.sub(lambda match: chr(int(match.group(1), 16)), text)


def escape_unit(text: str) -> str:
    """An application id as a unit name part: anything but letters, digits, `.`, `_` and `:` is \\xNN."""
    return "".join(char if (char.isascii() and (char.isalnum() or char in "._:")) else f"\\x{ord(char):02x}" for char in text)


def app_id_from_unit(unit: str) -> str | None:
    """The application id a systemd user unit runs (`org.gnome.Calculator`, `cursor`, `firefox_firefox`)."""
    snap = SNAP_SCOPE.match(unit)
    if snap:
        return f"{snap.group('snap')}_{snap.group('app')}"
    for pattern in (APP_SCOPE, APP_SERVICE):
        match = pattern.match(unit)
        if not match:
            continue
        launcher = match.group("launcher")
        app = match.group("app")
        if launcher and launcher not in KNOWN_LAUNCHERS:
            # `app-cursor-3587639.scope`: no launcher, the first part was the application id.
            app = f"{launcher}-{app}"
        app = unescape_unit(app)
        if app.startswith("dbus-") or not APP_ID.match(app):
            return None
        return app
    return None


def app_id_from_cgroup(text: str) -> str | None:
    """The application id in a /proc/<pid>/cgroup file (the innermost app or snap unit)."""
    for line in text.splitlines():
        _, _, path = line.partition("::")
        if not path:
            parts = line.split(":", 2)
            path = parts[2] if len(parts) == 3 else ""
        for part in reversed(path.split("/")):
            if part.startswith("app-") or part.startswith("snap."):
                found = app_id_from_unit(part)
                if found:
                    return found
    return None


def app_id_for_pid(pid: int) -> str | None:
    if not isinstance(pid, int) or pid <= 0:
        return None
    try:
        with open(f"/proc/{pid}/cgroup", "r", encoding="utf-8") as handle:
            return app_id_from_cgroup(handle.read(8192))
    except OSError:
        return None


def desktop_id(value: str) -> str:
    """`org.gnome.Calculator.desktop` and `org.gnome.Calculator` name the same app."""
    return value[:-8] if value.endswith(".desktop") else value


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()


def match_score(query: str, entry: dict[str, Any]) -> int:
    """How well a query names an entry: 3 its id, 2 its name, 1 a word of either; 0 not at all."""
    want = normalize(query)
    if not want:
        return 0
    ids = {normalize(desktop_id(entry.get("id", ""))), normalize(desktop_id(entry.get("id", "")).split(".")[-1])}
    names = {normalize(entry.get("name", "")), normalize(os.path.basename(entry.get("exec") or ""))}
    if want in ids:
        return 3
    if want in names:
        return 2
    haystack = " ".join(sorted(ids | names | {normalize(entry.get("generic") or "")}))
    return 1 if want in haystack else 0


def catalogue(query: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    """Installed apps people can open (desktop entries that show in the app grid), best match first."""
    from gi.repository import Gio

    entries: list[dict[str, Any]] = []
    for info in Gio.AppInfo.get_all():
        try:
            if not info.should_show():
                continue
            app_id = info.get_id() or ""
            entry = {
                "id": desktop_id(app_id),
                "name": (info.get_display_name() or info.get_name() or app_id)[:120],
                "exec": (info.get_executable() or "")[:200],
                "generic": (getattr(info, "get_generic_name", lambda: None)() or "")[:120],
            }
        except Exception:
            continue
        if entry["id"]:
            entries.append(entry)
    if query:
        scored = [(match_score(query, entry), entry) for entry in entries]
        entries = [entry for score, entry in sorted(scored, key=lambda pair: (-pair[0], pair[1]["name"].casefold())) if score > 0]
    else:
        entries.sort(key=lambda entry: entry["name"].casefold())
    return entries[:limit]


def find_installed(ref: str) -> tuple[Any | None, list[dict[str, Any]]]:
    """The installed app a reference names (id or exact name), else None and the nearest candidates."""
    from gi.repository import Gio

    wanted = desktop_id(ref.strip())
    if APP_ID.match(wanted):
        try:
            info = Gio.DesktopAppInfo.new(f"{wanted}.desktop")
        except TypeError:
            info = None
        if info is not None:
            return info, []
    matches = catalogue(ref, limit=8)
    exact = [entry for entry in matches if match_score(ref, entry) >= 2]
    if len(exact) == 1 or (exact and match_score(ref, exact[0]) == 3):
        try:
            info = Gio.DesktopAppInfo.new(f"{exact[0]['id']}.desktop")
        except TypeError:
            info = None
        if info is not None:
            return info, []
    return None, matches[:5]


def running_units(bus) -> list[dict[str, str]]:
    """Running app scopes and services of this user (apps with or without an accessibility tree)."""
    from gi.repository import GLib, Gio

    reply = bus.call_sync(
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "ListUnitsByPatterns",
        GLib.Variant("(asas)", (["active"], ["app-*.scope", "app-*.service", "snap.*.scope"])),
        None,
        Gio.DBusCallFlags.NONE,
        3000,
        None,
    )
    out = []
    for row in reply.unpack()[0]:
        unit = row[0]
        app = app_id_from_unit(unit)
        if app:
            out.append({"unit": unit, "app_id": app})
    return out


def launch_command(desktop_file: str, app_id: str, systemd_run: str | None = None, gio: str | None = None) -> list[str]:
    """The command that starts an app from its desktop file, in a scope of its own when systemd can."""
    gio = gio or shutil.which("gio") or "gio"
    run = systemd_run if systemd_run is not None else shutil.which("systemd-run")
    if run:
        unit = f"app-ensemble-{escape_unit(app_id)}-{secrets.token_hex(4)}"
        return [run, "--user", "--scope", "--collect", "--quiet", f"--unit={unit}", "--", gio, "launch", desktop_file]
    return [gio, "launch", desktop_file]


def start(command: list[str], env: dict[str, str], timeout_s: float = 15.0) -> int | None:
    """Runs the launcher in a session of its own; the app it starts is not our child. Its exit code."""
    try:
        process = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    except OSError:
        return None
    try:
        return process.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        return 0


def matches_running(app_id: str, names: Iterable[str], info_exec: str | None) -> bool:
    """Whether an accessible app (by its name) or a unit's app id is the app `app_id` names."""
    wanted = {normalize(app_id), normalize(app_id.split(".")[-1])}
    if info_exec:
        wanted.add(normalize(os.path.basename(info_exec)))
    return any(normalize(name) in wanted for name in names if name)
