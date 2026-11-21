"""The xdg-desktop-portal session that lets Ensemble see the screen and send input: RemoteDesktop with
keyboard and pointer, ScreenCast of every monitor with the cursor drawn in, persisted until the owner
revokes it. The owner approves it once on the computer; the restore token makes later sessions start
without a dialog. Tokens work once, so each new one is saved before anything else happens.

Only the public portal is used: Mutter's own RemoteDesktop and ScreenCast D-Bus APIs skip the owner's
consent and are never called."""
from __future__ import annotations

import os
import re
import secrets
import select
import time
from typing import Any, Callable

from gi.repository import Gio, GLib

from .media import wait_until
from .rpc import error

BUS_NAME = "org.freedesktop.portal.Desktop"
OBJECT_PATH = "/org/freedesktop/portal/desktop"
REMOTE_DESKTOP = "org.freedesktop.portal.RemoteDesktop"
SCREEN_CAST = "org.freedesktop.portal.ScreenCast"
CLIPBOARD = "org.freedesktop.portal.Clipboard"
REQUEST = "org.freedesktop.portal.Request"
SESSION = "org.freedesktop.portal.Session"
REGISTRY = "org.freedesktop.host.portal.Registry"

KEYBOARD = 1
POINTER = 2
MONITOR = 1
CURSOR_EMBEDDED = 2
PERSIST_UNTIL_REVOKED = 2
TOKEN = re.compile(r"^[A-Za-z0-9._:-]{1,256}$")
TEXT_MIMES = ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING", "TEXT"]
# The owner's clipboard text kept to give back after typing through the clipboard: at most this much.
KEEP_CLIPBOARD_BYTES = 1 << 20


def read_all(fd: int, limit: int, timeout_s: float) -> bytes | None:
    """Everything a pipe gives until it closes, or None when it is larger than `limit` or too slow; closes it."""
    chunks: list[bytes] = []
    size = 0
    end = time.monotonic() + timeout_s
    try:
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return None
            ready, _, _ = select.select([fd], [], [], left)
            if not ready:
                return None
            chunk = os.read(fd, 65536)
            if not chunk:
                return b"".join(chunks)
            size += len(chunk)
            if size > limit:
                return None
            chunks.append(chunk)
    finally:
        os.close(fd)


class TokenStore:
    """The portal's restore token, in a file only this user reads, replaced atomically."""

    def __init__(self, path: str):
        self.path = path

    def load(self) -> str | None:
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                value = handle.read(512).strip()
        except OSError:
            return None
        return value if TOKEN.match(value) else None

    def save(self, token: str) -> None:
        if not TOKEN.match(token):
            return
        folder = os.path.dirname(self.path)
        os.makedirs(folder, mode=0o700, exist_ok=True)
        temporary = f"{self.path}.{os.getpid()}.{secrets.token_hex(4)}"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, token.encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, self.path)
        try:
            dir_fd = os.open(folder, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass

    def clear(self) -> None:
        try:
            os.unlink(self.path)
        except OSError:
            pass


class Stream:
    __slots__ = ("node", "x", "y", "width", "height", "source_type", "mapping_id", "stream_id")

    def __init__(self, node: int, props: dict[str, Any]):
        self.node = int(node)
        position = props.get("position") or (0, 0)
        size = props.get("size") or (0, 0)
        self.x, self.y = int(position[0]), int(position[1])
        self.width, self.height = int(size[0]), int(size[1])
        self.source_type = int(props.get("source_type", MONITOR) or MONITOR)
        self.mapping_id = props.get("mapping_id")
        self.stream_id = props.get("id")

    def to_dict(self) -> dict[str, Any]:
        return {"node": self.node, "x": self.x, "y": self.y, "width": self.width, "height": self.height, "mapping_id": self.mapping_id}


def private_connection():
    """A connection of our own to the session bus: the Registry must be told the app id before any other
    portal call on that connection."""
    address = Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, None)
    return Gio.DBusConnection.new_for_address_sync(
        address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        None,
        None,
    )


class PortalSession:
    def __init__(self, app_id: str, tokens: TokenStore, log: Callable[[str], None], on_closed: Callable[[str], None], on_late_start: Callable[[dict[str, Any] | None, str | None], None]):
        self.bus = private_connection()
        self.tokens = tokens
        self._log = log
        self._on_closed = on_closed
        self._on_late_start = on_late_start
        self.sender = self.bus.get_unique_name()[1:].replace(".", "_")
        self.registered = self._register(app_id)
        self.handle: str | None = None
        self.state = "off"
        self.streams: list[Stream] = []
        self.clipboard = False
        self.devices = 0
        self.silent = False
        self.started_at: float | None = None
        self._closed_sub: int | None = None
        self._closing = False
        self._clip_text: bytes | None = None
        self._clip_sub: int | None = None
        self._owner_sub: int | None = None
        self._selection_mimes: list[str] = []
        self._selection_ours = False

    def _register(self, app_id: str) -> bool:
        try:
            self.bus.call_sync(BUS_NAME, OBJECT_PATH, REGISTRY, "Register", GLib.Variant("(sa{sv})", (app_id, {})), None, Gio.DBusCallFlags.NONE, 5000, None)
            return True
        except GLib.Error as failure:
            self._log(f"portal registry: {failure.message[:120]}")
            return False

    def _new_token(self) -> str:
        return "ens" + secrets.token_hex(8)

    def _request(self, interface: str, method: str, build: Callable[[str], GLib.Variant], wait_s: float, late: Callable[[int, dict[str, Any]], None] | None = None):
        """Calls a portal method that answers through a Request object; None when it has not answered in `wait_s`."""
        token = self._new_token()
        path = f"/org/freedesktop/portal/desktop/request/{self.sender}/{token}"
        box: dict[str, Any] = {}

        def on_response(_conn, _sender, _path, _iface, _signal, params, *_rest):
            code, results = params.unpack()
            box["code"] = int(code)
            box["results"] = results
            self.bus.signal_unsubscribe(box["sub"])
            if box.get("late") and late is not None:
                late(box["code"], results)

        box["sub"] = self.bus.signal_subscribe(None, REQUEST, "Response", path, None, Gio.DBusSignalFlags.NONE, on_response)
        try:
            self.bus.call_sync(BUS_NAME, OBJECT_PATH, interface, method, build(token), GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE, 15000, None)
        except GLib.Error as failure:
            self.bus.signal_unsubscribe(box["sub"])
            raise error("unsupported_here", f"The desktop portal refused {method} ({failure.message[:200]}).")
        if wait_until(lambda: "code" in box, wait_s):
            return box["code"], box["results"]
        box["late"] = True
        return None

    def _expect(self, answer, method: str) -> dict[str, Any]:
        if answer is None:
            raise error("unsupported_here", f"The desktop portal did not answer {method}.", retryable=True)
        code, results = answer
        if code == 1:
            raise error("consent_denied", "The owner did not allow screen control on this computer.")
        if code != 0:
            raise error("unsupported_here", f"The desktop portal could not {method}.")
        return results

    def start(self, wait_s: float, want_clipboard: bool = True) -> dict[str, Any]:
        if self.state == "on":
            return self.info()
        if self.state == "waiting":
            return {"state": "waiting_owner_at_computer"}
        session_token = self._new_token()
        results = self._expect(
            self._request(REMOTE_DESKTOP, "CreateSession", lambda t: GLib.Variant("(a{sv})", ({"handle_token": GLib.Variant("s", t), "session_handle_token": GLib.Variant("s", session_token)},)), 10.0),
            "create a session",
        )
        self.handle = str(results.get("session_handle") or "")
        if not self.handle:
            raise error("unsupported_here", "The desktop portal made no session.")
        self._closed_sub = self.bus.signal_subscribe(None, SESSION, "Closed", self.handle, None, Gio.DBusSignalFlags.NONE, self._closed)
        restore = self.tokens.load()

        def devices(token: str) -> GLib.Variant:
            options = {"handle_token": GLib.Variant("s", token), "types": GLib.Variant("u", KEYBOARD | POINTER), "persist_mode": GLib.Variant("u", PERSIST_UNTIL_REVOKED)}
            if restore:
                options["restore_token"] = GLib.Variant("s", restore)
            return GLib.Variant("(oa{sv})", (self.handle, options))

        self._expect(self._request(REMOTE_DESKTOP, "SelectDevices", devices, 10.0), "select the keyboard and pointer")
        self._expect(
            self._request(
                SCREEN_CAST,
                "SelectSources",
                lambda t: GLib.Variant("(oa{sv})", (self.handle, {"handle_token": GLib.Variant("s", t), "types": GLib.Variant("u", MONITOR), "multiple": GLib.Variant("b", True), "cursor_mode": GLib.Variant("u", CURSOR_EMBEDDED)})),
                10.0,
            ),
            "select the screens",
        )
        if want_clipboard:
            try:
                self.bus.call_sync(BUS_NAME, OBJECT_PATH, CLIPBOARD, "RequestClipboard", GLib.Variant("(oa{sv})", (self.handle, {})), None, Gio.DBusCallFlags.NONE, 5000, None)
            except GLib.Error as failure:
                self._log(f"clipboard not requested: {failure.message[:120]}")
        asked_at = time.monotonic()
        answer = self._request(
            REMOTE_DESKTOP,
            "Start",
            lambda t: GLib.Variant("(osa{sv})", (self.handle, "", {"handle_token": GLib.Variant("s", t)})),
            wait_s,
            late=self._late,
        )
        if answer is None:
            self.state = "waiting"
            return {"state": "waiting_owner_at_computer", "restore": bool(restore)}
        self.silent = time.monotonic() - asked_at < wait_s
        return self._started(*answer)

    def _late(self, code: int, results: dict[str, Any]) -> None:
        self.silent = False
        try:
            info = self._started(code, results)
        except Exception as failure:
            self._on_late_start(None, getattr(failure, "kind", "unsupported_here"))
            return
        self._on_late_start(info, None)

    def _started(self, code: int, results: dict[str, Any]) -> dict[str, Any]:
        if code != 0:
            self.state = "denied" if code == 1 else "failed"
            self.close()
            if code == 1:
                raise error("consent_denied", "The owner did not allow screen control on this computer.")
            raise error("unsupported_here", "The desktop portal could not start screen control.")
        token = results.get("restore_token")
        if isinstance(token, str) and token:
            self.tokens.save(token)
        self.devices = int(results.get("devices") or 0)
        self.streams = [Stream(node, props) for node, props in (results.get("streams") or [])]
        self.clipboard = bool(results.get("clipboard_enabled"))
        self.state = "on"
        self.started_at = time.time()
        if self.clipboard:
            self._clip_sub = self.bus.signal_subscribe(None, CLIPBOARD, "SelectionTransfer", OBJECT_PATH, None, Gio.DBusSignalFlags.NONE, self._selection_transfer)
            self._owner_sub = self.bus.signal_subscribe(None, CLIPBOARD, "SelectionOwnerChanged", OBJECT_PATH, None, Gio.DBusSignalFlags.NONE, self._selection_owner_changed)
        return self.info()

    def info(self) -> dict[str, Any]:
        return {
            "state": "on" if self.state == "on" else self.state,
            "streams": [stream.to_dict() for stream in self.streams],
            "clipboard": self.clipboard,
            "keyboard": bool(self.devices & KEYBOARD),
            "pointer": bool(self.devices & POINTER),
            "silent": self.silent,
            "registered": self.registered,
        }

    def _closed(self, *_args) -> None:
        was_ours = self._closing
        self._teardown()
        self._on_closed("closed_by_helper" if was_ours else "closed")

    def _teardown(self) -> None:
        if self._closed_sub is not None:
            self.bus.signal_unsubscribe(self._closed_sub)
            self._closed_sub = None
        if self._clip_sub is not None:
            self.bus.signal_unsubscribe(self._clip_sub)
            self._clip_sub = None
        if self._owner_sub is not None:
            self.bus.signal_unsubscribe(self._owner_sub)
            self._owner_sub = None
        self._clip_text = None
        self._selection_mimes = []
        self._selection_ours = False
        self.state = "off"
        self.handle = None
        self.streams = []

    def close(self) -> None:
        handle = self.handle
        self._closing = True
        if handle:
            try:
                self.bus.call_sync(BUS_NAME, handle, SESSION, "Close", None, None, Gio.DBusCallFlags.NONE, 5000, None)
            except GLib.Error:
                pass
        self._teardown()
        self._closing = False

    def pipewire_fd(self) -> int:
        if self.state != "on" or not self.handle:
            raise error("no_session", "Screen control is not on.")
        try:
            reply, fds = self.bus.call_with_unix_fd_list_sync(BUS_NAME, OBJECT_PATH, SCREEN_CAST, "OpenPipeWireRemote", GLib.Variant("(oa{sv})", (self.handle, {})), GLib.VariantType("(h)"), Gio.DBusCallFlags.NONE, 10000, None, None)
        except GLib.Error as failure:
            raise error("capture_failed", f"The screen stream could not be opened ({failure.message[:200]}).")
        return fds.get(reply.unpack()[0])

    def _notify(self, method: str, signature: str, *args: Any) -> None:
        if self.state != "on" or not self.handle:
            raise error("no_session", "Screen control is not on.")
        try:
            self.bus.call_sync(BUS_NAME, OBJECT_PATH, REMOTE_DESKTOP, method, GLib.Variant(signature, (self.handle, {}, *args)), None, Gio.DBusCallFlags.NONE, 5000, None)
        except GLib.Error as failure:
            raise error("input_failed", f"The desktop portal refused the input ({failure.message[:200]}).", ran="maybe")

    def pointer_to(self, stream: int, x: float, y: float) -> None:
        self._notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)", stream, float(x), float(y))

    def pointer_button(self, button: int, pressed: bool) -> None:
        self._notify("NotifyPointerButton", "(oa{sv}iu)", int(button), 1 if pressed else 0)

    def pointer_axis(self, axis: int, steps: int) -> None:
        self._notify("NotifyPointerAxisDiscrete", "(oa{sv}ui)", int(axis), int(steps))

    def keysym(self, keysym: int, pressed: bool) -> None:
        self._notify("NotifyKeyboardKeysym", "(oa{sv}iu)", int(keysym), 1 if pressed else 0)

    def _selection_owner_changed(self, _conn, _sender, _path, _iface, _signal, params, *_rest) -> None:
        session, options = params.unpack()
        if session != self.handle:
            return
        self._selection_ours = bool(options.get("session_is_owner"))
        self._selection_mimes = [str(mime) for mime in (options.get("mime_types") or [])]
        if not self._selection_ours:
            # Someone copied something new: the owner's earlier text kept here is not needed any more.
            self._clip_text = None

    def clipboard_snapshot(self) -> dict[str, Any] | None:
        """The clipboard's text before typing through it, to give back after; None when it was empty or
        Ensemble's own, `{"lost": True}` when it holds something else (an image) that cannot be given back."""
        if not self.clipboard or not self.handle:
            return None
        # Owner changes still queued are taken in first: the snapshot is of what is on the clipboard now.
        context = GLib.MainContext.default()
        for _ in range(100):
            if not context.iteration(False):
                break
        if self._selection_ours or not self._selection_mimes:
            return None
        mime = next((mime for mime in TEXT_MIMES if mime in self._selection_mimes), None)
        if mime is None:
            return {"lost": True}
        try:
            reply, fds = self.bus.call_with_unix_fd_list_sync(BUS_NAME, OBJECT_PATH, CLIPBOARD, "SelectionRead", GLib.Variant("(os)", (self.handle, mime)), GLib.VariantType("(h)"), Gio.DBusCallFlags.NONE, 5000, None, None)
            data = read_all(fds.get(reply.unpack()[0]), KEEP_CLIPBOARD_BYTES, 1.0)
        except (GLib.Error, OSError):
            data = None
        return {"data": data} if data is not None else {"lost": True}

    def clipboard_restore(self, kept: dict[str, Any] | None) -> None:
        """Gives back what `clipboard_snapshot` kept, else leaves the clipboard empty."""
        data = kept.get("data") if kept else None
        if data is None:
            self.clipboard_clear()
            return
        try:
            self._offer(data)
        except Exception:
            self.clipboard_clear()

    def clipboard_offer(self, text: str) -> None:
        self._offer(text.encode("utf-8"))

    def _offer(self, data: bytes) -> None:
        if not self.clipboard or not self.handle:
            raise error("unsupported_here", "The clipboard is not shared in this session.")
        self._clip_text = data
        mime = GLib.Variant("as", TEXT_MIMES)
        try:
            self.bus.call_sync(BUS_NAME, OBJECT_PATH, CLIPBOARD, "SetSelection", GLib.Variant("(oa{sv})", (self.handle, {"mime_types": mime})), None, Gio.DBusCallFlags.NONE, 5000, None)
        except GLib.Error as failure:
            raise error("input_failed", f"The clipboard could not be set ({failure.message[:200]}).")

    def clipboard_clear(self) -> None:
        self._clip_text = None
        if self.clipboard and self.handle:
            try:
                self.bus.call_sync(BUS_NAME, OBJECT_PATH, CLIPBOARD, "SetSelection", GLib.Variant("(oa{sv})", (self.handle, {"mime_types": GLib.Variant("as", [])})), None, Gio.DBusCallFlags.NONE, 5000, None)
            except GLib.Error:
                pass

    def _selection_transfer(self, _conn, _sender, _path, _iface, _signal, params, *_rest) -> None:
        session, _mime, serial = params.unpack()
        if session != self.handle:
            return
        data = self._clip_text
        ok = False
        try:
            reply, fds = self.bus.call_with_unix_fd_list_sync(BUS_NAME, OBJECT_PATH, CLIPBOARD, "SelectionWrite", GLib.Variant("(ou)", (self.handle, serial)), GLib.VariantType("(h)"), Gio.DBusCallFlags.NONE, 5000, None, None)
            fd = fds.get(reply.unpack()[0])
            try:
                if data:
                    view = memoryview(data)
                    while view:
                        view = view[os.write(fd, view):]
                ok = data is not None
            finally:
                os.close(fd)
        except (GLib.Error, OSError):
            ok = False
        try:
            self.bus.call_sync(BUS_NAME, OBJECT_PATH, CLIPBOARD, "SelectionWriteDone", GLib.Variant("(oub)", (self.handle, serial, ok)), None, Gio.DBusCallFlags.NONE, 5000, None)
        except GLib.Error:
            pass


def interface_versions(bus) -> dict[str, int | None]:
    """The portal interfaces this desktop offers and their versions (no dialog: properties only)."""
    out: dict[str, int | None] = {}
    for name in (REMOTE_DESKTOP, SCREEN_CAST, CLIPBOARD, "org.freedesktop.portal.Screenshot", "org.freedesktop.portal.Inhibit", "org.freedesktop.portal.GlobalShortcuts", REGISTRY):
        try:
            reply = bus.call_sync(BUS_NAME, OBJECT_PATH, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (name, "version")), GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 3000, None)
            out[name.rsplit(".", 1)[-1]] = int(reply.unpack()[0])
        except GLib.Error:
            out[name.rsplit(".", 1)[-1]] = None
    return out
