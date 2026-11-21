"""The helper's methods and its main loop. Requests are handled one at a time, in order; while one waits
(for a portal answer, a settled screen) the GLib main context keeps running, so portal signals and
GStreamer messages are still heard. A cancel notification for the running request is read at once."""
from __future__ import annotations

import base64
import os
import queue
import signal
import sys
import threading
import time
from typing import Any, Callable

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

from . import PROTOCOL, VERSION  # noqa: E402
from . import apps as appmod  # noqa: E402
from . import readiness  # noqa: E402
from .a11y import A11y, clean  # noqa: E402
from .keys import KeyError_, char_keysym, parse_combo, split_text  # noqa: E402
from .mapping import MAX_LONG_EDGE, clamp_point, clamp_region, fit, logical_to_native, path  # noqa: E402
from .media import FrameSource, Recording, check_media, encode, encoder, pump, wait_until, write_private  # noqa: E402
from .portal import PortalSession, TokenStore, interface_versions  # noqa: E402
from .rpc import Deadline, Request, RpcError, error, error_response, notification, param, parse_line, response  # noqa: E402
from .sessionenv import complete, manager_environment_reader, session_type  # noqa: E402

APP_ID = "com.ensemblework.Ensemble"
# The portal registers an app id only when its entry's program is on the portal's own PATH, which `sh` always is.
DESKTOP_FILE = f"""[Desktop Entry]
Type=Application
Name=Ensemble
Comment=Lets your Ensemble agents see and use this desktop when you allow it
Exec=sh -c ensemble
Terminal=true
NoDisplay=true
"""
BUTTONS = {"left": 0x110, "right": 0x111, "middle": 0x112}
DEFAULT_DEADLINE_MS = 30_000
INPUT_METHODS = {"input.pointer", "input.drag", "input.scroll", "input.keys", "input.text", "a11y.do", "apps.launch", "apps.focus"}


class Writer:
    def __init__(self, stream):
        self._stream = stream
        self._lock = threading.Lock()

    def __call__(self, line: str) -> None:
        with self._lock:
            self._stream.write(line)
            self._stream.flush()


def log(message: str) -> None:
    sys.stderr.write(f"desktop-helper: {message}\n")
    sys.stderr.flush()


def ensure_desktop_file(home: str) -> str | None:
    """Ensemble's desktop entry, so portal dialogs name Ensemble; written only when there is none."""
    folder = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share"), "applications")
    path = os.path.join(folder, f"{APP_ID}.desktop")
    if os.path.exists(path):
        return path
    try:
        os.makedirs(folder, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        try:
            os.fchmod(fd, 0o644)
            os.write(fd, DESKTOP_FILE.encode("utf-8"))
        finally:
            os.close(fd)
        return path
    except OSError as failure:
        log(f"desktop entry not written: {type(failure).__name__}")
        return None


class Helper:
    def __init__(self, state_dir: str, write: Callable[[str], None], test_source: str | None = None, agent=None):
        self.state_dir = state_dir
        os.makedirs(state_dir, mode=0o700, exist_ok=True)
        self.write = write
        self.test_source = test_source
        # The agent screen (agent_screen.AgentScreen): this helper then works only there, on its private bus.
        self.agent = agent
        try:
            self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        except GLib.Error:
            self.bus = None
        if agent is not None:
            self.env = agent.app_env()
        else:
            self.env = complete(os.environ, manager_environment_reader(self.bus) if self.bus else None)
        self.tokens = TokenStore(os.path.join(state_dir, "portal-restore-token"))
        self.portal: PortalSession | None = None
        self.sources: dict[int, FrameSource] = {}
        self.geometry: dict[int, dict[str, Any]] = {}
        self.kept: dict[int, Any] = {}
        self.a11y = A11y()
        self.recordings: dict[str, Recording] = {}
        self.proven = readiness.Proven()
        self.epoch = 0
        self.last_start: dict[str, Any] | None = None
        self.cancelled: set[Any] = set()
        self.current: Any = None
        self.requests: "queue.Queue[Request]" = queue.Queue()
        self.busy = False
        self.loop = GLib.MainLoop()
        self.desktop_file: str | None = None
        self.methods: dict[str, Callable[[dict[str, Any], Deadline, Any], Any]] = {
            "hello": self.hello,
            "ping": lambda _p, _d, _i: {"pong": True, "at": int(time.time() * 1000)},
            "status": self.status,
            "session.start": self.session_start,
            "session.stop": self.session_stop,
            "displays": self.displays,
            "frame.capture": self.frame_capture,
            "frame.state": self.frame_state,
            "frame.settle": self.frame_settle,
            "input.pointer": self.input_pointer,
            "input.drag": self.input_drag,
            "input.scroll": self.input_scroll,
            "input.keys": self.input_keys,
            "input.text": self.input_text,
            "a11y.apps": self.a11y_apps,
            "a11y.focus": self.a11y_focus,
            "a11y.tree": self.a11y_tree,
            "a11y.do": self.a11y_do,
            "apps.catalog": self.apps_catalog,
            "apps.launch": self.apps_launch,
            "apps.focus": self.apps_focus,
            "idle": self.idle,
            "notify": self.notify,
            "record.start": self.record_start,
            "record.stop": self.record_stop,
            "record.discard": self.record_discard,
            "media.check": self.media_check,
        }

    # ── loop ────────────────────────────────────────────────────────────────

    def emit(self, kind: str, **fields: Any) -> None:
        self.write(notification("event", {"kind": kind, **fields}))

    def reader(self, stream) -> None:
        for raw in iter(stream.readline, b""):
            if not raw.strip():
                continue
            try:
                request = parse_line(raw.rstrip(b"\n"))
            except RpcError as failure:
                self.write(error_response(None, failure))
                continue
            if request.is_notification:
                if request.method == "cancel":
                    self.cancelled.add(request.params.get("id"))
                continue
            self.requests.put(request)
            GLib.idle_add(self.pump_requests)
        GLib.idle_add(self.shutdown)

    def pump_requests(self) -> bool:
        if self.busy:
            return False
        try:
            request = self.requests.get_nowait()
        except queue.Empty:
            return False
        self.busy = True
        self.current = request.id
        try:
            self.write(self.handle(request))
        finally:
            self.busy = False
            self.current = None
            self.cancelled.discard(request.id)
            if not self.requests.empty():
                GLib.idle_add(self.pump_requests)
        return False

    def handle(self, request: Request) -> str:
        method = self.methods.get(request.method)
        if method is None:
            return error_response(request.id, error("method_not_found", f"Unknown method {request.method[:64]}."))
        try:
            deadline = Deadline.from_params(request.params, DEFAULT_DEADLINE_MS)
            if request.id in self.cancelled:
                raise error("cancelled", "The request was cancelled before it started.")
            return response(request.id, method(request.params, deadline, request.id))
        except RpcError as failure:
            return error_response(request.id, failure)
        except Exception as failure:
            log(f"{request.method} failed: {type(failure).__name__}")
            ran = "maybe" if request.method in INPUT_METHODS else "no"
            return error_response(request.id, error("internal", f"The helper failed: {type(failure).__name__}.", ran=ran))

    def check(self, deadline: Deadline, request_id: Any, ran: str) -> None:
        if request_id in self.cancelled:
            raise error("cancelled", "The request was cancelled.", ran=ran)
        deadline.check(ran)

    def run(self) -> None:
        threading.Thread(target=self.reader, args=(sys.stdin.buffer,), daemon=True, name="stdin").start()
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, self.shutdown)
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, self.shutdown)
        self.loop.run()

    def shutdown(self) -> bool:
        if self.busy:
            GLib.timeout_add(100, self.shutdown)
            return False
        for recording in list(self.recordings.values()):
            if recording.active:
                recording.finish(5.0)
        self._stop_streams()
        if self.portal is not None:
            self.portal.close()
        if self.agent is not None:
            self.agent.stop()
        self.loop.quit()
        return False

    # ── facts ───────────────────────────────────────────────────────────────

    def hello(self, _params, _deadline, _id) -> dict[str, Any]:
        from gi.repository import Gst

        from .media import init

        init()
        return {
            "protocol": PROTOCOL,
            "version": VERSION,
            "platform": "linux",
            "desktop": self.env.get("XDG_CURRENT_DESKTOP"),
            "session": session_type(self.env),
            "python": sys.version.split()[0],
            "gstreamer": Gst.version_string(),
            "methods": sorted(self.methods),
            "test_source": bool(self.test_source),
            "screen": "agent" if self.agent is not None else "owner",
            **({"agent": {"display": self.agent.paths["display"], "size": list(self.agent.size), "version": self.agent.version}} if self.agent is not None else {}),
        }

    def _locked_idle(self) -> tuple[bool | None, int | None]:
        locked = idle_ms = None
        if self.bus is None:
            return None, None
        try:
            reply = self.bus.call_sync("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver", "GetActive", None, GLib.VariantType("(b)"), Gio.DBusCallFlags.NONE, 2000, None)
            locked = bool(reply.unpack()[0])
        except GLib.Error:
            pass
        try:
            reply = self.bus.call_sync("org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor", "GetIdletime", None, GLib.VariantType("(t)"), Gio.DBusCallFlags.NONE, 2000, None)
            idle_ms = int(reply.unpack()[0])
        except GLib.Error:
            pass
        return locked, idle_ms

    def status(self, params, _deadline, _id) -> dict[str, Any]:
        if self.agent is not None:
            return self._agent_status()
        kind = session_type(self.env)
        versions = interface_versions(self.bus) if self.bus else {}
        apps = failure = None
        try:
            apps = len(self.a11y.apps())
        except RpcError as problem:
            failure = problem.message
        locked, idle_ms = self._locked_idle()
        session_state = self.portal.state if self.portal else ("on" if self.sources and self.test_source else "off")
        choice = encoder(log)
        facts = {
            "session": readiness.session_fact(kind, self.env.get("XDG_CURRENT_DESKTOP")),
            "portal": readiness.portal_fact(versions) if self.bus else readiness.fact("failed", "No session bus reaches this runtime.", "Run Ensemble inside your desktop session."),
            "consent": readiness.consent_fact(session_state, self.tokens.load() is not None, self.last_start),
            "capture": self.proven.get("capture", "No screen frame has been captured yet (it needs screen control on)."),
            "input": self.proven.get("input", "No input has been sent yet (it needs screen control on)."),
            "a11y": readiness.a11y_fact(apps, failure),
            "recorder": readiness.recorder_fact(choice),
            "screen": readiness.screen_fact(locked, idle_ms),
        }
        return {
            "facts": facts,
            "session": {"state": session_state, "epoch": self.epoch, **({"streams": [self.geometry[node] for node in sorted(self.geometry)]} if self.geometry else {})},
            "registered": bool(self.portal and self.portal.registered),
            "recordings": [{"id": key, "active": rec.active, "wall_ms": rec.wall_ms()} for key, rec in self.recordings.items()],
        }

    def _agent_status(self) -> dict[str, Any]:
        apps = failure = None
        try:
            apps = len(self.a11y.apps())
        except RpcError as problem:
            failure = problem.message
        session_state = self.portal.state if self.portal else "off"
        alive = self.agent.alive()
        facts = {
            "session": readiness.fact("working" if alive else "failed", f"The agent screen: headless {self.agent.version or 'GNOME Shell'}, {self.agent.size[0]}x{self.agent.size[1]}, private to the agent." if alive else "The agent screen's GNOME Shell stopped.", None if alive else "It starts again on the next use."),
            "consent": readiness.fact("not_needed", "The agent screen is the agent's own: it needs no consent and nobody sees it unless they watch it."),
            "capture": self.proven.get("capture", "No frame of the agent screen has been captured yet."),
            "input": self.proven.get("input", "No input has been sent to the agent screen yet."),
            "a11y": readiness.a11y_fact(apps, failure),
            "recorder": readiness.recorder_fact(encoder(log)),
        }
        return {
            "facts": facts,
            "session": {"state": "on" if session_state == "on" else session_state, "epoch": self.epoch, **({"streams": [self.geometry[node] for node in sorted(self.geometry)]} if self.geometry else {})},
            "registered": True,
            "recordings": [{"id": key, "active": rec.active, "wall_ms": rec.wall_ms()} for key, rec in self.recordings.items()],
        }

    def idle(self, _params, _deadline, _id) -> dict[str, Any]:
        if self.agent is not None:
            return {"locked": False, "idle_ms": None}
        locked, idle_ms = self._locked_idle()
        return {"locked": locked, "idle_ms": idle_ms}

    def notify(self, params, _deadline, _id) -> dict[str, Any]:
        """A notice on the owner's screen (the desktop's notification service)."""
        if self.agent is not None:
            raise error("unsupported_here", "Notices are for the owner's screen; nobody reads the agent screen's.")
        title = clean(param(params, "title", str, required=True), 80)
        body = clean(param(params, "body", str, ""), 300)
        if self.bus is None:
            return {"shown": False}
        hints = {"urgency": GLib.Variant("y", 2), "desktop-entry": GLib.Variant("s", APP_ID)}
        try:
            reply = self.bus.call_sync(
                "org.freedesktop.Notifications",
                "/org/freedesktop/Notifications",
                "org.freedesktop.Notifications",
                "Notify",
                GLib.Variant("(susssasa{sv}i)", ("Ensemble", 0, "", title, body, [], hints, 120_000)),
                GLib.VariantType("(u)"),
                Gio.DBusCallFlags.NONE,
                3000,
                None,
            )
        except GLib.Error as failure:
            log(f"notify failed: {failure.message[:120]}")
            return {"shown": False}
        return {"shown": True, "id": int(reply.unpack()[0])}

    # ── session ─────────────────────────────────────────────────────────────

    def session_start(self, params, deadline: Deadline, _id) -> dict[str, Any]:
        if self.sources:
            return self._session_info()
        if self.test_source:
            return self._open_test_source()
        if self.agent is not None:
            from .mutter import MutterSession, wait_for_names

            if not self.agent.alive():
                raise error("unsupported_here", "The agent screen's GNOME Shell stopped; it starts again with the next helper.")
            if not wait_for_names(self.bus, ["org.gnome.Mutter.ScreenCast", "org.gnome.Mutter.RemoteDesktop", "org.gnome.Mutter.DisplayConfig"], min(15.0, max(1.0, deadline.remaining() - 2.0))):
                raise error("unsupported_here", "The agent screen's compositor offers no screen cast here.")
            if self.portal is None or self.portal.state != "on":
                self.portal = MutterSession(self.bus, log, self._on_closed)
            info = self.portal.start(min(8.0, max(1.0, deadline.remaining() - 2.0)))
            return self._open_streams(info)
        if self.bus is None:
            raise error("unsupported_here", "No session bus reaches this runtime.")
        if self.portal is not None and self.portal.state == "waiting":
            return {"state": "waiting_owner_at_computer"}
        if self.portal is None or self.portal.state in ("denied", "failed", "off"):
            if self.desktop_file is None:
                self.desktop_file = ensure_desktop_file(os.path.expanduser("~"))
            if self.portal is not None:
                self.portal.close()
            self.portal = PortalSession(APP_ID, self.tokens, log, self._on_closed, self._on_late_start)
        wait_s = min(max(1.0, float(param(params, "wait_ms", (int, float), 4000)) / 1000.0), max(1.0, deadline.remaining() - 2.0))
        info = self.portal.start(wait_s, want_clipboard=bool(param(params, "clipboard", bool, True)))
        if info.get("state") == "waiting_owner_at_computer":
            self.emit("consent.waiting")
            return info
        return self._open_streams(info)

    def _session_info(self) -> dict[str, Any]:
        info = self.portal.info() if self.portal else {"state": "on", "clipboard": False, "silent": True}
        return {**info, "state": "on", "epoch": self.epoch, "streams": [self.geometry[node] for node in sorted(self.geometry)]}

    def _open_test_source(self) -> dict[str, Any]:
        source = FrameSource(self.test_source, log)
        if not source.start(5.0):
            source.stop()
            raise error("capture_failed", "The test source gave no frame.")
        frame = source.frame()
        self.sources = {0: source}
        self.epoch += 1
        self.geometry = {0: {"node": 0, "x": 0, "y": 0, "width": frame.width, "height": frame.height, "frame_width": frame.width, "frame_height": frame.height, "name": "TEST", "primary": True}}
        self.last_start = {"at": int(time.time() * 1000), "silent": True}
        return self._session_info()

    def _monitor_names(self) -> list[dict[str, Any]]:
        """Connector names and the primary flag of logical monitors (read-only DisplayConfig)."""
        if self.bus is None:
            return []
        try:
            reply = self.bus.call_sync("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig", "org.gnome.Mutter.DisplayConfig", "GetCurrentState", None, None, Gio.DBusCallFlags.NONE, 3000, None)
        except GLib.Error:
            return []
        _serial, _monitors, logical, _props = reply.unpack()
        return [{"x": x, "y": y, "scale": scale, "primary": bool(primary), "names": [monitor[0] for monitor in monitors]} for (x, y, scale, _transform, primary, monitors, _lprops) in logical]

    def _open_streams(self, info: dict[str, Any]) -> dict[str, Any]:
        assert self.portal is not None
        fd = self.portal.pipewire_fd()
        remote = f"fd={fd} " if fd is not None else ""
        names = self._monitor_names()
        self._stop_streams()
        sources: dict[int, FrameSource] = {}
        geometry: dict[int, dict[str, Any]] = {}
        try:
            for stream in self.portal.streams:
                source = FrameSource(f"pipewiresrc {remote}path={stream.node} do-timestamp=true keepalive-time=250 always-copy=true ! video/x-raw", log)
                if not source.start(5.0):
                    detail = source.error or "no frame came"
                    source.stop()
                    self.proven.failed("capture", f"The screen stream gave no frame ({detail}).")
                    raise error("capture_failed", f"The screen stream gave no frame ({detail}).", retryable=True)
                frame = source.frame()
                match = next((row for row in names if row["x"] == stream.x and row["y"] == stream.y), None)
                sources[stream.node] = source
                geometry[stream.node] = {
                    **stream.to_dict(),
                    "frame_width": frame.width,
                    "frame_height": frame.height,
                    "name": (match["names"][0] if match and match["names"] else None),
                    "primary": bool(match and match["primary"]),
                    "scale": match["scale"] if match else None,
                }
        except Exception:
            for source in sources.values():
                source.stop()
            raise
        finally:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
        if geometry and not any(row["primary"] for row in geometry.values()):
            first = min(geometry)
            geometry[first]["primary"] = True
        self.sources = sources
        self.geometry = geometry
        self.epoch += 1
        self.proven.worked("capture", f"{len(sources)} screen stream(s)")
        self.last_start = {"at": int(time.time() * 1000), "silent": bool(info.get("silent"))}
        return self._session_info()

    def _on_late_start(self, info: dict[str, Any] | None, failure: str | None) -> None:
        if info is None:
            self.emit("session.failed", reason=failure or "unsupported_here")
            return
        try:
            opened = self._open_streams(info)
        except RpcError as problem:
            self.emit("session.failed", reason=problem.kind)
            return
        self.emit("session.started", epoch=opened["epoch"], streams=opened["streams"], silent=False)

    def _on_closed(self, reason: str) -> None:
        for key, recording in list(self.recordings.items()):
            if recording.active:
                recording.stopped_reason = "session_closed"
                recording.finish(5.0)
        self._stop_streams()
        # Stopped from the system's own controls: the standing permission goes too, so the next start asks the owner again.
        if reason == "closed":
            self.tokens.clear()
        self.emit("session.closed", reason="closed_by_owner" if reason == "closed" else reason)

    def _stop_streams(self) -> None:
        for source in self.sources.values():
            try:
                source.stop()
            except Exception:
                pass
        self.sources = {}
        self.geometry = {}
        self.kept = {}

    def session_stop(self, _params, _deadline, _id) -> dict[str, Any]:
        for recording in list(self.recordings.values()):
            if recording.active:
                recording.stopped_reason = "session_stopped"
                recording.finish(5.0)
        self._stop_streams()
        if self.portal is not None:
            self.portal.close()
        return {"state": "off"}

    def displays(self, _params, _deadline, _id) -> dict[str, Any]:
        if not self.sources:
            raise error("no_session", "Screen control is not on.")
        return {"epoch": self.epoch, "streams": [self.geometry[node] for node in sorted(self.geometry)]}

    def _source(self, params) -> tuple[int, FrameSource, dict[str, Any]]:
        if not self.sources:
            raise error("no_session", "Screen control is not on.")
        node = int(param(params, "display", (int, float), min(self.sources)))
        source = self.sources.get(node)
        if source is None:
            raise error("bad_display", f"There is no screen {node}.")
        if source.error:
            raise error("capture_failed", f"The screen stream stopped ({source.error}).", retryable=True)
        return node, source, self.geometry[node]

    # ── frames ──────────────────────────────────────────────────────────────

    def frame_capture(self, params, deadline: Deadline, request_id) -> dict[str, Any]:
        node, source, geo = self._source(params)
        settle = params.get("settle") if isinstance(params.get("settle"), dict) else None
        settled, waited = None, 0.0
        if settle:
            budget = max(0.0, min(float(settle.get("timeout_ms", 1500)), deadline.remaining() * 1000.0 - 500.0))
            settled, waited, frame = source.settle(float(settle.get("min_ms", 0)), budget)
        if params.get("from_kept") and node in self.kept:
            frame = self.kept[node]
        else:
            frame = source.frame()
        if frame is None:
            self.proven.failed("capture", "The screen stream has no frame.")
            raise error("capture_failed", "The screen stream has no frame yet.", retryable=True)
        self.check(deadline, request_id, "no")
        crop = params.get("crop")
        region = (0.0, 0.0, float(geo["width"]), float(geo["height"]))
        native = None
        if crop is not None:
            if not (isinstance(crop, list) and len(crop) == 4 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in crop)):
                raise error("invalid_params", "crop is [x, y, width, height] in logical pixels.")
            region = clamp_region(tuple(crop), geo["width"], geo["height"])
            native = logical_to_native(region, (geo["width"], geo["height"]), (frame.width, frame.height))
        source_w, source_h = (native[2], native[3]) if native else (frame.width, frame.height)
        long_edge = int(param(params, "max_long_edge", (int, float), MAX_LONG_EDGE))
        size = fit(source_w, source_h, long_edge) if long_edge > 0 else (source_w, source_h)
        fmt = "png" if params.get("format") == "png" else "jpeg"
        data = encode(frame, native, size, fmt, int(param(params, "quality", (int, float), 80)))
        if params.get("keep"):
            self.kept[node] = frame
        out: dict[str, Any] = {
            "display": node,
            "epoch": self.epoch,
            "image": {"width": size[0], "height": size[1], "mime": "image/png" if fmt == "png" else "image/jpeg", "bytes": len(data)},
            "frame": {"width": frame.width, "height": frame.height},
            "region": list(region),
            "hash": frame.hash,
            "seq": frame.seq,
            "settled": settled,
            "waited_ms": int(waited),
            "at": int(time.time() * 1000),
        }
        target = params.get("save_path")
        if isinstance(target, str) and target:
            if not os.path.isabs(target):
                raise error("invalid_params", "save_path must be absolute.")
            write_private(target, data)
            out["image"]["path"] = target
        if params.get("inline", not target):
            out["image"]["base64"] = base64.b64encode(data).decode("ascii")
        self.proven.worked("capture", f"{frame.width}x{frame.height}")
        return out

    def frame_state(self, params, _deadline, _id) -> dict[str, Any]:
        node, source, _ = self._source(params)
        frame = source.frame()
        if frame is None:
            raise error("capture_failed", "The screen stream has no frame yet.", retryable=True)
        return {"display": node, "seq": frame.seq, "hash": frame.hash}

    def frame_settle(self, params, deadline: Deadline, _id) -> dict[str, Any]:
        node, source, _ = self._source(params)
        budget = max(0.0, min(float(param(params, "timeout_ms", (int, float), 1500)), deadline.remaining() * 1000.0 - 300.0))
        settled, waited, frame = source.settle(float(param(params, "min_ms", (int, float), 100)), budget)
        return {"display": node, "settled": settled, "waited_ms": int(waited), "hash": frame.hash if frame else None, "seq": frame.seq if frame else None}

    # ── input ───────────────────────────────────────────────────────────────

    def _portal_on(self) -> PortalSession:
        if self.portal is None or self.portal.state != "on":
            raise error("no_session", "Screen control is not on.")
        return self.portal

    def _point(self, geo: dict[str, Any], x: Any, y: Any) -> tuple[float, float, bool]:
        if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            raise error("invalid_params", "x and y are numbers (logical pixels of the screen).")
        return clamp_point(float(x), float(y), geo["width"], geo["height"])

    def _proven_input(self, work: Callable[[], Any]) -> Any:
        try:
            result = work()
        except RpcError as failure:
            if failure.kind == "input_failed":
                self.proven.failed("input", failure.message)
            raise
        self.proven.worked("input")
        return result

    def input_pointer(self, params, deadline: Deadline, request_id) -> dict[str, Any]:
        portal = self._portal_on()
        node, _source, geo = self._source(params)
        x, y, clamped = self._point(geo, params.get("x"), params.get("y"))
        action = param(params, "action", str, "click")
        button = BUTTONS.get(param(params, "button", str, "left"))
        if button is None:
            raise error("invalid_params", "button is left, right or middle.")
        count = max(1, min(3, int(param(params, "count", (int, float), 1))))
        self.check(deadline, request_id, "no")

        def work():
            portal.pointer_to(node, x, y)
            if action == "move":
                return
            pump(0.03)
            if action == "down":
                portal.pointer_button(button, True)
                return
            if action == "up":
                portal.pointer_button(button, False)
                return
            for index in range(count):
                portal.pointer_button(button, True)
                pump(0.04)
                portal.pointer_button(button, False)
                if index + 1 < count:
                    pump(0.08)

        self._proven_input(work)
        return {"sent": True, "x": x, "y": y, "clamped": clamped}

    def input_drag(self, params, deadline: Deadline, request_id) -> dict[str, Any]:
        portal = self._portal_on()
        node, _source, geo = self._source(params)
        start = params.get("from")
        end = params.get("to")
        if not (isinstance(start, list) and isinstance(end, list) and len(start) == 2 and len(end) == 2):
            raise error("invalid_params", "from and to are [x, y] in logical pixels.")
        sx, sy, _ = self._point(geo, start[0], start[1])
        ex, ey, _ = self._point(geo, end[0], end[1])
        button = BUTTONS.get(param(params, "button", str, "left"), BUTTONS["left"])
        steps = max(2, min(60, int(param(params, "steps", (int, float), 15))))
        self.check(deadline, request_id, "no")
        pressed = {"down": False}

        def work():
            portal.pointer_to(node, sx, sy)
            pump(0.05)
            portal.pointer_button(button, True)
            pressed["down"] = True
            for px, py in path((sx, sy), (ex, ey), steps)[1:]:
                if request_id in self.cancelled or deadline.expired():
                    break
                portal.pointer_to(node, px, py)
                pump(0.016)
            pump(0.05)
            portal.pointer_button(button, False)
            pressed["down"] = False

        try:
            self._proven_input(work)
        finally:
            if pressed["down"]:
                try:
                    portal.pointer_button(button, False)
                except RpcError:
                    pass
        return {"sent": True}

    def input_scroll(self, params, deadline: Deadline, request_id) -> dict[str, Any]:
        portal = self._portal_on()
        node, _source, geo = self._source(params)
        direction = param(params, "direction", str, "down")
        amount = max(1, min(30, int(param(params, "amount", (int, float), 3))))
        axis, sign = {"down": (0, 1), "up": (0, -1), "right": (1, 1), "left": (1, -1)}.get(direction, (None, 0))
        if axis is None:
            raise error("invalid_params", "direction is up, down, left or right.")
        point = None
        if params.get("x") is not None and params.get("y") is not None:
            point = self._point(geo, params.get("x"), params.get("y"))
        self.check(deadline, request_id, "no")

        def work():
            if point:
                portal.pointer_to(node, point[0], point[1])
                pump(0.03)
            for _ in range(amount):
                portal.pointer_axis(axis, sign)
                pump(0.02)

        self._proven_input(work)
        return {"sent": True}

    def _press_keys(self, portal: PortalSession, syms: list[int]) -> None:
        pressed: list[int] = []
        try:
            for sym in syms:
                portal.keysym(sym, True)
                pressed.append(sym)
                pump(0.01)
        finally:
            for sym in reversed(pressed):
                try:
                    portal.keysym(sym, False)
                except RpcError:
                    pass
                pump(0.005)

    def input_keys(self, params, deadline: Deadline, request_id) -> dict[str, Any]:
        portal = self._portal_on()
        keys = param(params, "keys", str, required=True)
        repeat = max(1, min(30, int(param(params, "repeat", (int, float), 1))))
        try:
            syms = parse_combo(keys)
        except KeyError_ as failure:
            raise error("invalid_params", str(failure))
        self.check(deadline, request_id, "no")
        sent = 0

        def work():
            nonlocal sent
            for index in range(repeat):
                if index and (request_id in self.cancelled or deadline.expired()):
                    break
                self._press_keys(portal, syms)
                sent += 1
                pump(0.04)

        self._proven_input(work)
        return {"sent": True, "times": sent}

    def input_text(self, params, deadline: Deadline, request_id) -> dict[str, Any]:
        text = param(params, "text", str, required=True)
        if len(text) > 20000:
            raise error("invalid_params", "At most 20000 characters at once.")
        portal = self._portal_on()
        self.check(deadline, request_id, "no")
        counts = {"keysym": 0, "atspi": 0, "clipboard": 0, "untyped": 0}
        started = False

        def work():
            nonlocal started
            for kind, run in split_text(text):
                if request_id in self.cancelled or deadline.expired():
                    raise error("timeout" if deadline.expired() else "cancelled", "Typing stopped before the end.", ran="yes" if started else "no", extra={"typed": counts})
                if kind == "keys":
                    for char in run:
                        if request_id in self.cancelled or deadline.expired():
                            raise error("timeout" if deadline.expired() else "cancelled", "Typing stopped before the end.", ran="yes" if started else "no", extra={"typed": counts})
                        sym = char_keysym(char)
                        portal.keysym(sym, True)
                        started = True
                        portal.keysym(sym, False)
                        counts["keysym"] += 1
                        pump(0.008)
                    continue
                if self.a11y.insert_at_focus(run):
                    counts["atspi"] += len(run)
                    started = True
                    continue
                if portal.clipboard:
                    portal.clipboard_offer(run)
                    pump(0.05)
                    self._press_keys(portal, parse_combo("ctrl+v"))
                    started = True
                    pump(0.4)
                    portal.clipboard_clear()
                    counts["clipboard"] += len(run)
                    continue
                counts["untyped"] += len(run)

        self._proven_input(work)
        return {"sent": True, "typed": counts}

    # ── accessibility ───────────────────────────────────────────────────────

    def a11y_apps(self, _params, _deadline, _id) -> dict[str, Any]:
        apps = self.a11y.apps()
        units = []
        if self.bus is not None:
            try:
                units = appmod.running_units(self.bus)
            except GLib.Error:
                units = []
        return {"apps": apps, "units": units}

    def a11y_focus(self, params, _deadline, _id) -> dict[str, Any]:
        out = self.a11y.focus(with_text=bool(params.get("text", True)))
        if params.get("documents", True):
            out["documents"] = self.a11y.documents()
        return out

    def a11y_tree(self, params, deadline: Deadline, _id) -> dict[str, Any]:
        ref = params.get("app")
        if not isinstance(ref, (str, int)) or isinstance(ref, bool) or (isinstance(ref, str) and not ref.strip()):
            raise error("invalid_params", "app is a name, an application id or a process id.")
        window = params.get("window")
        return self.a11y.tree(ref, window if isinstance(window, int) and not isinstance(window, bool) else None, int(param(params, "max_elements", (int, float), 300)), min(2.5, max(0.3, deadline.remaining() - 0.5)))

    def a11y_do(self, params, deadline: Deadline, request_id) -> dict[str, Any]:
        tree_id = param(params, "tree_id", str, required=True)
        element = param(params, "element", str, required=True)
        action = param(params, "action", str, "press")
        self.check(deadline, request_id, "no")
        return self.a11y.act(tree_id, element, action, name=params.get("name") if isinstance(params.get("name"), str) else None, text=params.get("text") if isinstance(params.get("text"), str) else None)

    # ── apps ────────────────────────────────────────────────────────────────

    def apps_catalog(self, params, _deadline, _id) -> dict[str, Any]:
        query = params.get("query") if isinstance(params.get("query"), str) else None
        return {"apps": appmod.catalogue(query, int(param(params, "limit", (int, float), 200)))}

    def _running_for(self, app_id: str, exec_name: str | None):
        for info in self.a11y.apps():
            if info["app_id"] == app_id or appmod.matches_running(app_id, [info["name"]], exec_name):
                return info
        return None

    def apps_launch(self, params, deadline: Deadline, request_id) -> dict[str, Any]:
        ref = param(params, "id", str, required=True)
        info, candidates = appmod.find_installed(ref)
        if info is None:
            raise error("target_not_found", f"No installed app is called {clean(ref, 60)}.", extra={"candidates": candidates})
        app_id = appmod.desktop_id(info.get_id() or ref)
        exec_name = info.get_executable()
        path_ = info.get_filename()
        stages = {"accepted": False, "process": False, "window": False, "inspectable": False, "focused": False}
        started = time.monotonic()
        already = self._running_for(app_id, exec_name)
        if already and already["windows"]:
            stages.update(accepted=True, process=True, window=True)
        else:
            self.check(deadline, request_id, "no")
            if self.agent is not None:
                from .agent_screen import UNIT_PREFIX, app_launch_prefix, unit_of

                command = appmod.launch_command(path_, app_id, prefix=app_launch_prefix(self.agent.paths["runtime"]), unit_prefix=UNIT_PREFIX)
                self.agent.track(unit_of(command))
            else:
                command = appmod.launch_command(path_, app_id)
            code = appmod.start(command, self.env, timeout_s=min(15.0, max(1.0, deadline.remaining() - 1.0)))
            if code is None or code != 0:
                raise error("launch_failed", f"{clean(info.get_display_name() or app_id, 60)} could not be started.", ran="maybe")
            stages["accepted"] = True
        wait_s = min(float(param(params, "wait_ms", (int, float), 8000)) / 1000.0, max(0.5, deadline.remaining() - 1.0))
        found: dict[str, Any] | None = None

        def ready() -> bool:
            nonlocal found
            if request_id in self.cancelled:
                return True
            found = self._running_for(app_id, exec_name)
            return bool(found and found["windows"])

        wait_until(ready, wait_s, 0.2)
        if found:
            stages["process"] = True
            stages["window"] = bool(found["windows"])
        if found and found["windows"]:
            try:
                tree = self.a11y.tree(found["pid"] or found["name"], None, 30, 1.0)
                stages["inspectable"] = len(tree["elements"]) > 0
            except RpcError:
                stages["inspectable"] = False
            stages["focused"] = any(window["active"] for window in found["windows"])
        if not stages["process"] and self.bus is not None:
            try:
                stages["process"] = any(unit["app_id"] == app_id for unit in appmod.running_units(self.bus))
            except GLib.Error:
                pass
        return {"app": {"id": app_id, "name": clean(info.get_display_name() or app_id), "running": found}, "stages": stages, "waited_ms": int((time.monotonic() - started) * 1000)}

    def apps_focus(self, params, deadline: Deadline, request_id) -> dict[str, Any]:
        ref = params.get("app")
        if not isinstance(ref, (str, int)) or isinstance(ref, bool):
            raise error("invalid_params", "app is a name, an application id or a process id.")
        app, info = self.a11y.find_app(ref)
        if app is None:
            raise error("target_not_found", f"No running app with an accessibility tree is called {clean(str(ref), 60)}.")
        if self.a11y.window_active(app):
            return {"focused": True, "via": "already", "app": info}
        wait_s = min(float(param(params, "wait_ms", (int, float), 2000)) / 1000.0, max(0.3, deadline.remaining() - 1.0))
        if self.a11y.grab_window(app) and wait_until(lambda: self.a11y.window_active(app), min(1.0, wait_s), 0.1):
            return {"focused": True, "via": "atspi", "app": info}
        if not params.get("allow_input") or self.portal is None or self.portal.state != "on":
            return {"focused": False, "via": None, "app": info}
        name = clean(params.get("search") if isinstance(params.get("search"), str) else info["name"], 60)
        self.check(deadline, request_id, "no")

        def work() -> bool:
            self._press_keys(self.portal, parse_combo("super"))
            # The name is typed only into the shell's own search: never into a window that kept the keyboard.
            if not wait_until(lambda: self.a11y.active()["shell"], 1.5, 0.1):
                return False
            for char in name:
                if char.isascii() and char.isprintable():
                    sym = char_keysym(char)
                    self.portal.keysym(sym, True)
                    self.portal.keysym(sym, False)
                    pump(0.01)
            pump(0.7)
            if not self.a11y.active()["shell"]:
                return False
            self._press_keys(self.portal, parse_combo("Return"))
            return True

        if not self._proven_input(work):
            return {"focused": False, "via": None, "app": info}
        focused = wait_until(lambda: self.a11y.window_active(app), wait_s, 0.1)
        return {"focused": focused, "via": "search" if focused else None, "app": info}

    # ── recording ───────────────────────────────────────────────────────────

    def record_start(self, params, deadline: Deadline, request_id) -> dict[str, Any]:
        node, source, _geo = self._source(params)
        if any(recording.active for recording in self.recordings.values()):
            raise error("recording_active", "A recording is already running.")
        target = param(params, "path", str, required=True)
        if not os.path.isabs(target) or os.path.exists(target):
            raise error("invalid_params", "path must be absolute and new.")
        choice = encoder(log)
        if choice is None:
            raise error("unsupported_here", "No video encoder works here.")
        self.check(deadline, request_id, "no")
        # Made here, only this user's, before the muxer writes into it.
        try:
            os.close(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
        except OSError as failure:
            raise error("invalid_params", f"The recording's file could not be made ({type(failure).__name__}).")
        recording = Recording(source, target, choice, int(param(params, "fps", (int, float), 30)), int(param(params, "max_width", (int, float), 1920)), log)
        try:
            recording.start()
        except BaseException:
            try:
                os.unlink(target)
            except OSError:
                pass
            raise
        key = f"r{int(time.time() * 1000):x}"
        self.recordings = {name: rec for name, rec in self.recordings.items() if rec.active}
        self.recordings[key] = recording
        max_ms = int(param(params, "max_ms", (int, float), 120_000))

        def limit() -> bool:
            if recording.active:
                recording.stopped_reason = "max_duration"
                recording.finish(15.0)
                self.emit("record.stopped", id=key, reason="max_duration")
            return False

        GLib.timeout_add(max(1000, max_ms), limit)
        return {"id": key, "display": node, "container": choice["container"], "codec": choice["codec"], "mime": "video/mp4" if choice["container"] == "mp4" else "video/webm", "size": list(recording.out_size)}

    def record_stop(self, params, deadline: Deadline, _id) -> dict[str, Any]:
        key = param(params, "id", str, required=True)
        recording = self.recordings.get(key)
        if recording is None:
            raise error("no_recording", "There is no such recording.")
        finished = recording.finish(min(20.0, max(2.0, deadline.remaining() - 1.0)))
        if not finished:
            raise error("recording_failed", recording.error or "The recording did not finish.")
        size = os.path.getsize(recording.path) if os.path.exists(recording.path) else 0
        return {"id": key, "path": recording.path, "size": size, "wall_ms": recording.wall_ms(), "frames_in": recording.frames_in, "reason": recording.stopped_reason or "stopped", "container": recording.choice["container"], "codec": recording.choice["codec"]}

    def record_discard(self, params, _deadline, _id) -> dict[str, Any]:
        key = param(params, "id", str, required=True)
        recording = self.recordings.pop(key, None)
        if recording is None:
            raise error("no_recording", "There is no such recording.")
        recording.finish(5.0)
        try:
            os.unlink(recording.path)
        except OSError:
            pass
        return {"discarded": True}

    def media_check(self, params, deadline: Deadline, _id) -> dict[str, Any]:
        target = param(params, "path", str, required=True)
        poster = params.get("poster_path") if isinstance(params.get("poster_path"), str) else None
        preview = params.get("preview_path") if isinstance(params.get("preview_path"), str) else None
        for name in (target, poster, preview):
            if name is not None and not os.path.isabs(name):
                raise error("invalid_params", "Paths must be absolute.")
        return check_media(target, poster, preview, max(5.0, deadline.remaining() - 1.0), log)
