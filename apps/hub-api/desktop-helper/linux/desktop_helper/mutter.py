"""Frames and input of the agent screen through its own compositor's screen cast and remote desktop
(`org.gnome.Mutter.ScreenCast`, `org.gnome.Mutter.RemoteDesktop`) on the agent session's private bus. This
is the agent's own headless compositor, never the owner's screen: no consent dialog is involved. It offers
what server.py uses of a portal session: streams, input, start and close."""
from __future__ import annotations

import time
from typing import Any, Callable

from gi.repository import Gio, GLib

from .media import pump, wait_until
from .portal import Stream
from .rpc import error

RD = ("org.gnome.Mutter.RemoteDesktop", "/org/gnome/Mutter/RemoteDesktop", "org.gnome.Mutter.RemoteDesktop")
SC = ("org.gnome.Mutter.ScreenCast", "/org/gnome/Mutter/ScreenCast", "org.gnome.Mutter.ScreenCast")
DISPLAY_CONFIG = ("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig", "org.gnome.Mutter.DisplayConfig")
RD_SESSION = "org.gnome.Mutter.RemoteDesktop.Session"
SC_SESSION = "org.gnome.Mutter.ScreenCast.Session"
SC_STREAM = "org.gnome.Mutter.ScreenCast.Stream"
CURSOR_EMBEDDED = 1
SHIFT = 0xFFE1


class MutterSession:
    def __init__(self, bus, log: Callable[[str], None], on_closed: Callable[[str], None]):
        self.bus = bus
        self._log = log
        self._on_closed = on_closed
        self.state = "off"
        self.streams: list[Stream] = []
        self.stream_paths: dict[int, str] = {}
        self.clipboard = False
        self.registered = True
        self.silent = True
        self.rd: str | None = None
        self.sc: str | None = None
        self._subs: list[int] = []

    def _call(self, name: str, path: str, interface: str, method: str, args: GLib.Variant | None = None, reply: str | None = None, timeout_ms: int = 5000):
        try:
            return self.bus.call_sync(name, path, interface, method, args, GLib.VariantType(reply) if reply else None, Gio.DBusCallFlags.NONE, timeout_ms, None)
        except GLib.Error as failure:
            raise error("unsupported_here", f"The agent screen's compositor refused {method} ({failure.message[:160]}).", retryable=True)

    def _connectors(self) -> list[str]:
        reply = self._call(*DISPLAY_CONFIG, "GetCurrentState", None, None)
        _serial, monitors, _logical, _props = reply.unpack()
        return [monitor[0][0] for monitor in monitors]

    def start(self, wait_s: float = 5.0, want_clipboard: bool = False) -> dict[str, Any]:
        if self.state == "on":
            return self.info()
        connectors = self._connectors()
        if not connectors:
            raise error("capture_failed", "The agent screen has no monitor.")
        self.rd = self._call(*RD, "CreateSession", None, "(o)").unpack()[0]
        session_id = self._call(RD[0], self.rd, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (RD_SESSION, "SessionId")), "(v)").unpack()[0]
        self.sc = self._call(*SC, "CreateSession", GLib.Variant("(a{sv})", ({"remote-desktop-session-id": GLib.Variant("s", session_id)},)), "(o)").unpack()[0]
        nodes: dict[str, int] = {}
        paths = []
        for connector in connectors:
            stream = self._call(SC[0], self.sc, SC_SESSION, "RecordMonitor", GLib.Variant("(sa{sv})", (connector, {"cursor-mode": GLib.Variant("u", CURSOR_EMBEDDED)})), "(o)").unpack()[0]
            paths.append(stream)

            def added(_conn, _sender, path, _iface, _signal, params, *_rest):
                nodes[path] = int(params.unpack()[0])

            self._subs.append(self.bus.signal_subscribe(None, SC_STREAM, "PipeWireStreamAdded", stream, None, Gio.DBusSignalFlags.NONE, added))
        self._subs.append(self.bus.signal_subscribe(None, RD_SESSION, "Closed", self.rd, None, Gio.DBusSignalFlags.NONE, self._closed))
        self._call(RD[0], self.rd, RD_SESSION, "Start")
        if not wait_until(lambda: len(nodes) == len(paths), wait_s, 0.05):
            self.close()
            raise error("capture_failed", "The agent screen's compositor gave no screen stream.", retryable=True)
        streams = []
        for path in paths:
            params = self._call(SC[0], path, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (SC_STREAM, "Parameters")), "(v)").unpack()[0]
            node = nodes[path]
            streams.append(Stream(node, {"position": params.get("position", (0, 0)), "size": params.get("size", (0, 0))}))
            self.stream_paths[node] = path
        self.streams = streams
        self.state = "on"
        # The compositor makes its virtual devices on their first event: a harmless first move and Shift, so no real step is lost.
        first = streams[0]
        try:
            self.pointer_to(first.node, first.width / 2, first.height / 2)
            self.keysym(SHIFT, True)
            self.keysym(SHIFT, False)
        except Exception:
            pass
        pump(0.2)
        return self.info()

    def info(self) -> dict[str, Any]:
        return {"state": "on" if self.state == "on" else self.state, "streams": [stream.to_dict() for stream in self.streams], "clipboard": False, "keyboard": True, "pointer": True, "silent": True, "registered": True}

    def pipewire_fd(self) -> None:
        """No file descriptor: the stream is on this user's PipeWire, read directly."""
        return None

    def _closed(self, *_args) -> None:
        self._teardown()
        self._on_closed("closed")

    def _teardown(self) -> None:
        for sub in self._subs:
            self.bus.signal_unsubscribe(sub)
        self._subs = []
        self.state = "off"
        self.streams = []
        self.stream_paths = {}
        self.rd = None
        self.sc = None

    def close(self) -> None:
        rd = self.rd
        if rd:
            try:
                self.bus.call_sync(RD[0], rd, RD_SESSION, "Stop", None, None, Gio.DBusCallFlags.NONE, 3000, None)
            except GLib.Error:
                pass
        self._teardown()

    def _notify(self, method: str, signature: str, *args: Any) -> None:
        if self.state != "on" or not self.rd:
            raise error("no_session", "The agent screen is not on.")
        try:
            self.bus.call_sync(RD[0], self.rd, RD_SESSION, method, GLib.Variant(signature, args), None, Gio.DBusCallFlags.NONE, 3000, None)
        except GLib.Error as failure:
            raise error("input_failed", f"The agent screen did not take the input ({failure.message[:160]}).", ran="maybe")

    def pointer_to(self, stream: int, x: float, y: float) -> None:
        path = self.stream_paths.get(stream)
        if path is None:
            raise error("bad_display", f"There is no screen {stream} on the agent screen.")
        self._notify("NotifyPointerMotionAbsolute", "(sdd)", path, float(x), float(y))

    def pointer_button(self, button: int, pressed: bool) -> None:
        self._notify("NotifyPointerButton", "(ib)", int(button), bool(pressed))

    def pointer_axis(self, axis: int, steps: int) -> None:
        self._notify("NotifyPointerAxisDiscrete", "(ui)", int(axis), int(steps))

    def keysym(self, keysym: int, pressed: bool) -> None:
        self._notify("NotifyKeyboardKeysym", "(ub)", int(keysym), bool(pressed))

    def clipboard_offer(self, _text: str) -> None:
        raise error("unsupported_here", "The agent screen has no clipboard for typing.")

    def clipboard_clear(self) -> None:
        return None


def wait_for_names(bus, names: list[str], timeout_s: float) -> bool:
    """Whether the compositor's interfaces are on the bus (GNOME Shell takes them as it starts)."""

    def owned() -> bool:
        for name in names:
            try:
                bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", GLib.Variant("(s)", (name,)), GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, 1000, None)
            except GLib.Error:
                return False
        return True

    end = time.monotonic() + timeout_s
    while time.monotonic() < end:
        if owned():
            return True
        pump(0.1)
    return owned()
