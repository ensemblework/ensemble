"""The accessibility tree (AT-SPI): apps and their windows, one app's elements with ids, and actions on
them. On Wayland every extent is relative to its window (GNOME does not tell a client where windows
are), so element boxes are window-relative and never screen positions."""
from __future__ import annotations

import time
import warnings
from collections import OrderedDict
from typing import Any
from urllib.parse import urlsplit

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib  # noqa: E402

from .apps import app_id_for_pid, normalize  # noqa: E402
from .rpc import error  # noqa: E402

WINDOW_ROLES = {"frame", "window", "dialog", "alert", "file chooser", "color chooser", "font chooser"}
INTERACTIVE_ROLES = {
    "push button", "toggle button", "check box", "radio button", "menu item", "check menu item", "radio menu item",
    "link", "entry", "password text", "text", "combo box", "list item", "tree item", "page tab", "slider",
    "spin button", "switch", "menu", "table cell", "icon", "button", "search box", "editbar",
}
CONTEXT_ROLES = {"label", "heading", "static", "paragraph", "status bar", "notification", "alert", "caption", "title bar"}
STATES = {
    Atspi.StateType.FOCUSED: "focused",
    Atspi.StateType.CHECKED: "checked",
    Atspi.StateType.SELECTED: "selected",
    Atspi.StateType.EXPANDED: "expanded",
    Atspi.StateType.EDITABLE: "editable",
    Atspi.StateType.PRESSED: "pressed",
    Atspi.StateType.ACTIVE: "active",
    Atspi.StateType.INDETERMINATE: "mixed",
    Atspi.StateType.READ_ONLY: "read only",
    Atspi.StateType.MULTI_LINE: "multi line",
}
BROWSERS = {"firefox", "chromium", "google chrome", "chrome", "brave", "brave browser", "microsoft edge", "epiphany", "web", "vivaldi", "opera", "librewolf", "zen", "floorp"}
PRESS_ACTIONS = ("press", "click", "activate", "jump", "toggle", "open", "select")
MAX_NAME = 120
MAX_VALUE = 200
TREES_KEPT = 4


def clean(text: Any, limit: int = MAX_NAME) -> str:
    """One line of at most `limit` characters: names can hold whole messages and newlines."""
    if not isinstance(text, str):
        return ""
    return " ".join(text.split())[:limit]


def _states(node) -> tuple[Any, list[str]]:
    try:
        state_set = node.get_state_set()
    except GLib.Error:
        return None, []
    return state_set, [label for state, label in STATES.items() if state_set.contains(state)]


def _alive(node) -> bool:
    try:
        state_set = node.get_state_set()
        return not state_set.contains(Atspi.StateType.DEFUNCT)
    except GLib.Error:
        return False


IFACES = {"action": "Action", "text": "Text", "editable_text": "EditableText", "component": "Component", "value": "Value", "document": "Document"}


def _iface(node, name: str):
    """The node itself when it implements the interface (methods are then called through the interface
    class: `Atspi.Text.get_text(node, ...)`, because `node.get_text` is Accessible's own getter)."""
    try:
        return node if IFACES[name] in (node.get_interfaces() or []) else None
    except GLib.Error:
        return None


def _text(node, limit: int) -> str:
    count = Atspi.Text.get_character_count(node)
    return Atspi.Text.get_text(node, 0, min(count, limit)) if count > 0 else ""


def _caret(node) -> int:
    try:
        return Atspi.Text.get_caret_offset(node)
    except GLib.Error:
        return -1


def _actions(node) -> list[str]:
    names = []
    for index in range(min(Atspi.Action.get_n_actions(node), 8)):
        names.append(Atspi.Action.get_action_name(node, index) or "")
    return names


def _extents(node) -> list[int]:
    rect = Atspi.Component.get_extents(node, Atspi.CoordType.WINDOW)
    return [rect.x, rect.y, rect.width, rect.height]


def _doc_url(node) -> str | None:
    if _iface(node, "document") is None:
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        for getter in ("get_document_attribute_value", "get_attribute_value"):
            fn = getattr(Atspi.Document, getter, None)
            if fn is None:
                continue
            try:
                value = fn(node, "DocURL")
            except (GLib.Error, TypeError):
                continue
            if value:
                return value
    return None


class A11y:
    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._trees: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._next = 0

    def desktop(self):
        try:
            desk = Atspi.get_desktop(0)
        except GLib.Error as failure:
            raise error("a11y_unavailable", f"The accessibility bus did not answer ({failure.message}).")
        if desk is None:
            raise error("a11y_unavailable", "The accessibility bus did not answer.")
        return desk

    def _apps(self):
        desk = self.desktop()
        count = desk.get_child_count()
        for index in range(min(count, 200)):
            app = desk.get_child_at_index(index)
            if app is not None:
                yield app

    def _windows(self, app) -> list[tuple[int, Any]]:
        out = []
        try:
            count = app.get_child_count()
        except GLib.Error:
            return out
        for index in range(min(count, 50)):
            try:
                child = app.get_child_at_index(index)
                if child is not None and child.get_role_name() in WINDOW_ROLES:
                    out.append((index, child))
            except GLib.Error:
                continue
        return out

    def describe_app(self, app) -> dict[str, Any]:
        pid = None
        try:
            pid = app.get_process_id()
        except GLib.Error:
            pass
        windows = []
        for index, window in self._windows(app):
            state_set, labels = _states(window)
            windows.append({
                "index": index,
                "title": clean(window.get_name()),
                "role": window.get_role_name(),
                "active": "active" in labels,
                "showing": bool(state_set and state_set.contains(Atspi.StateType.SHOWING)),
                "iconified": bool(state_set and state_set.contains(Atspi.StateType.ICONIFIED)),
            })
        return {
            "name": clean(app.get_name()),
            "toolkit": clean(app.get_toolkit_name() if hasattr(app, "get_toolkit_name") else "", 40),
            "pid": pid,
            "app_id": app_id_for_pid(pid) if pid else None,
            "windows": windows,
        }

    def apps(self) -> list[dict[str, Any]]:
        out = []
        for app in self._apps():
            try:
                out.append(self.describe_app(app))
            except GLib.Error:
                continue
        return out

    def find_app(self, ref: str | int):
        """An accessible app by pid, application id or name (case and punctuation ignored)."""
        wanted = normalize(str(ref))
        candidates = []
        for app in self._apps():
            try:
                info = self.describe_app(app)
            except GLib.Error:
                continue
            if isinstance(ref, int) or str(ref).isdigit():
                if info["pid"] == int(ref):
                    return app, info
                continue
            names = {normalize(info["name"]), normalize(info["app_id"] or ""), normalize((info["app_id"] or "").split(".")[-1])}
            if wanted in names:
                candidates.append((0 if info["windows"] else 1, app, info))
        if candidates:
            candidates.sort(key=lambda row: row[0])
            return candidates[0][1], candidates[0][2]
        return None, None

    def active(self) -> dict[str, Any]:
        """The window with the keyboard (an app's ACTIVE window); the shell when only it is active."""
        shell = None
        for app in self._apps():
            try:
                name = app.get_name()
                for index, window in self._windows(app):
                    state_set, _ = _states(window)
                    if not state_set or not state_set.contains(Atspi.StateType.ACTIVE):
                        continue
                    if name == "gnome-shell":
                        shell = (app, index, window)
                        continue
                    return {"app": app, "index": index, "window": window, "shell": False}
            except GLib.Error:
                continue
        if shell:
            return {"app": shell[0], "index": shell[1], "window": shell[2], "shell": True}
        return {"app": None, "index": None, "window": None, "shell": False}

    def _find_focused(self, window, budget: int = 3000):
        stack = [window]
        seen = 0
        while stack and seen < budget:
            node = stack.pop()
            seen += 1
            try:
                state_set = node.get_state_set()
                if node is not window and state_set.contains(Atspi.StateType.FOCUSED):
                    return node
                if node is not window and not state_set.contains(Atspi.StateType.SHOWING):
                    continue
                count = node.get_child_count()
            except GLib.Error:
                continue
            for index in range(min(count, 300) - 1, -1, -1):
                try:
                    child = node.get_child_at_index(index)
                except GLib.Error:
                    continue
                if child is not None:
                    stack.append(child)
        return None

    def _shell_prompt(self, window, budget: int = 600) -> dict[str, Any] | None:
        """A dialog of the shell asking for a password (polkit, a keyring): only the owner types there."""
        stack = [(window, None)]
        seen = 0
        while stack and seen < budget:
            node, dialog = stack.pop()
            seen += 1
            try:
                role = node.get_role_name()
                state_set = node.get_state_set()
                if node is not window and not state_set.contains(Atspi.StateType.SHOWING):
                    continue
                if role in ("dialog", "alert"):
                    dialog = node
                if role == "password text" and dialog is not None:
                    return {"title": clean(dialog.get_name())}
                count = node.get_child_count()
            except GLib.Error:
                continue
            for index in range(min(count, 100)):
                try:
                    child = node.get_child_at_index(index)
                except GLib.Error:
                    continue
                if child is not None:
                    stack.append((child, dialog))
        return None

    def documents(self, budget: int = 400) -> list[dict[str, Any]]:
        """The pages browsers show now (a tab in front in each window), with their addresses."""
        found = []
        for app in self._apps():
            try:
                name = normalize(app.get_name())
                toolkit = (app.get_toolkit_name() or "").lower()
            except GLib.Error:
                continue
            if name not in BROWSERS and toolkit != "gecko":
                continue
            for _, window in self._windows(app):
                state_set, labels = _states(window)
                if state_set is not None and state_set.contains(Atspi.StateType.ICONIFIED):
                    continue
                stack = [(window, 0)]
                seen = 0
                while stack and seen < budget:
                    node, depth = stack.pop()
                    seen += 1
                    try:
                        role = node.get_role()
                        if role == Atspi.Role.DOCUMENT_WEB:
                            if node.get_state_set().contains(Atspi.StateType.SHOWING):
                                url = _doc_url(node)
                                found.append({"app": clean(app.get_name()), "url": url or None, "window": clean(window.get_name()), "active": "active" in labels})
                            continue
                        if depth > 20:
                            continue
                        count = node.get_child_count()
                    except GLib.Error:
                        continue
                    for index in range(min(count, 80)):
                        try:
                            child = node.get_child_at_index(index)
                        except GLib.Error:
                            continue
                        if child is not None:
                            stack.append((child, depth + 1))
        return found

    def focus(self, with_text: bool = True) -> dict[str, Any]:
        current = self.active()
        app = current["app"]
        if app is None:
            return {"app": None, "window": None, "focused": None, "shell": False, "prompt": None}
        info = self.describe_app(app)
        window = current["window"]
        out: dict[str, Any] = {
            "app": {key: info[key] for key in ("name", "toolkit", "pid", "app_id")},
            "window": {"index": current["index"], "title": clean(window.get_name()), "role": window.get_role_name()},
            "shell": current["shell"],
            "prompt": self._shell_prompt(window) if current["shell"] else None,
            "focused": None,
        }
        node = self._find_focused(window)
        if node is not None:
            role = node.get_role_name()
            _, labels = _states(node)
            focused: dict[str, Any] = {"role": role, "name": clean(node.get_name()), "editable": "editable" in labels or role in ("entry", "password text")}
            if with_text and _iface(node, "text") is not None and role != "password text":
                try:
                    focused["text"] = _text(node, 4000)
                    focused["caret"] = _caret(node)
                except GLib.Error:
                    pass
            out["focused"] = focused
        return out

    def _node_of(self, tree_id: str, element: str):
        tree = self._trees.get(tree_id)
        if tree is None:
            raise error("element_gone", "That observation's elements are no longer known: look again.")
        node = tree["nodes"].get(element)
        if node is None:
            raise error("element_gone", f"There is no element {element} in that observation.")
        if not _alive(node):
            raise error("element_gone", f"Element {element} is gone from the app: look again.")
        return node

    def tree(self, ref: str | int, window_index: int | None = None, max_elements: int = 300, time_budget_s: float = 2.5) -> dict[str, Any]:
        app, info = self.find_app(ref)
        if app is None:
            raise error("target_not_found", f"No running app with an accessibility tree is called {clean(str(ref), 60)}.")
        windows = self._windows(app)
        if not windows:
            raise error("not_inspectable", f"{info['name']} has no window with an accessibility tree.", extra={"app": info})
        chosen = None
        if window_index is not None:
            chosen = next(((index, win) for index, win in windows if index == window_index), None)
        if chosen is None:
            chosen = next(((index, win) for index, win in windows if _states(win)[1].count("active")), windows[0])
        index, window = chosen
        started = self._clock()
        max_elements = max(10, min(int(max_elements), 800))
        candidates: list[tuple[bool, Any, dict[str, Any]]] = []
        stack = [(window, 0)]
        visited = 0
        truncated = False
        while stack:
            if visited >= 6000 or self._clock() - started > time_budget_s or len(candidates) >= max_elements * 3:
                truncated = True
                break
            node, depth = stack.pop()
            visited += 1
            try:
                state_set = node.get_state_set()
                if node is not window and not state_set.contains(Atspi.StateType.SHOWING):
                    continue
                role = node.get_role_name()
                entry = self._element(node, role, state_set)
                if entry is not None:
                    candidates.append((entry.pop("_interactive"), node, entry))
                count = node.get_child_count() if depth < 60 else 0
            except GLib.Error:
                continue
            if count > 400:
                truncated = True
            for child_index in range(min(count, 400) - 1, -1, -1):
                try:
                    child = node.get_child_at_index(child_index)
                except GLib.Error:
                    continue
                if child is not None:
                    stack.append((child, depth + 1))
        interactive = [row for row in candidates if row[0]]
        context = [row for row in candidates if not row[0]]
        keep = set(id(row[1]) for row in interactive[:max_elements])
        room = max_elements - len(keep)
        keep.update(id(row[1]) for row in context[:max(0, room)])
        if len(candidates) > len(keep):
            truncated = True
        self._next += 1
        tree_id = f"t{self._next}"
        nodes: dict[str, Any] = {}
        elements = []
        for _, node, entry in candidates:
            if id(node) not in keep:
                continue
            element_id = f"e{len(elements) + 1}"
            nodes[element_id] = node
            elements.append({"id": element_id, **entry})
        self._trees[tree_id] = {"nodes": nodes, "app": info}
        while len(self._trees) > TREES_KEPT:
            self._trees.popitem(last=False)
        extents = None
        if _iface(window, "component") is not None:
            try:
                extents = _extents(window)
            except GLib.Error:
                pass
        _, window_states = _states(window)
        return {
            "tree_id": tree_id,
            "app": info,
            "window": {"index": index, "title": clean(window.get_name()), "role": window.get_role_name(), "active": "active" in window_states, "extents": extents},
            "elements": elements,
            "truncated": truncated,
            "visited": visited,
        }

    def _element(self, node, role: str, state_set) -> dict[str, Any] | None:
        name = clean(node.get_name())
        actions: list[str] = []
        if _iface(node, "action") is not None:
            try:
                actions = [label for label in _actions(node) if label][:6]
            except GLib.Error:
                pass
        editable = state_set.contains(Atspi.StateType.EDITABLE)
        interactive = bool(actions) or editable or role in INTERACTIVE_ROLES
        if not interactive and not (name and role in CONTEXT_ROLES):
            return None
        labels = [label for state, label in STATES.items() if state_set.contains(state)]
        if not state_set.contains(Atspi.StateType.ENABLED) and not state_set.contains(Atspi.StateType.SENSITIVE) and interactive:
            labels.append("disabled")
        entry: dict[str, Any] = {"role": role, "name": name, "states": labels, "actions": actions, "_interactive": interactive}
        if role != "password text":
            if (editable or role in ("entry", "text", "search box", "editbar", "label", "static")) and _iface(node, "text") is not None:
                try:
                    value = clean(_text(node, MAX_VALUE * 2), MAX_VALUE)
                    if value and value != name:
                        entry["value"] = value
                except GLib.Error:
                    pass
            if role in ("slider", "spin button", "progress bar", "scroll bar") and _iface(node, "value") is not None:
                try:
                    entry["value"] = Atspi.Value.get_current_value(node)
                except GLib.Error:
                    pass
        if _iface(node, "component") is not None:
            try:
                entry["box"] = _extents(node)
            except GLib.Error:
                pass
        return entry

    def act(self, tree_id: str, element: str, action: str, *, name: str | None = None, text: str | None = None) -> dict[str, Any]:
        node = self._node_of(tree_id, element)
        role = node.get_role_name()
        _, before = _states(node)
        if action in ("press", "action"):
            names = _actions(node) if _iface(node, "action") is not None else []
            if not names:
                if _iface(node, "component") is not None and Atspi.Component.grab_focus(node):
                    return {"done": True, "via": "atspi:focus", "detail": "It has no action; it was focused instead.", "states_before": before, "states_after": _states(node)[1]}
                raise error("input_failed", f"Element {element} ({role}) has no action to press.")
            order = [name] if name else list(PRESS_ACTIONS)
            index = next((names.index(label) for label in order if label in names), 0 if not name else None)
            if index is None:
                raise error("input_failed", f"Element {element} has no action {clean(name, 40)}; it has {', '.join(names[:6])}.")
            try:
                done = Atspi.Action.do_action(node, index)
            except GLib.Error as failure:
                raise error("input_failed", f"The app refused the action ({clean(failure.message, 200)}).", ran="maybe")
            return {"done": bool(done), "via": f"atspi:{names[index]}", "states_before": before, "states_after": _states(node)[1] if _alive(node) else []}
        if action == "focus":
            if _iface(node, "component") is None:
                raise error("input_failed", f"Element {element} cannot take the focus.")
            return {"done": bool(Atspi.Component.grab_focus(node)), "via": "atspi:focus", "states_before": before, "states_after": _states(node)[1]}
        if action in ("set_text", "insert_text"):
            if _iface(node, "editable_text") is None:
                raise error("input_failed", f"Element {element} ({role}) is not editable text.")
            value = text or ""
            has_text = _iface(node, "text") is not None
            try:
                if action == "set_text":
                    done = Atspi.EditableText.set_text_contents(node, value)
                else:
                    caret = _caret(node) if has_text else -1
                    position = caret if caret >= 0 else (Atspi.Text.get_character_count(node) if has_text else 0)
                    done = Atspi.EditableText.insert_text(node, position, value, len(value.encode("utf-8")))
            except GLib.Error as failure:
                raise error("input_failed", f"The app refused the text ({clean(failure.message, 200)}).", ran="maybe")
            verified = None
            if role != "password text" and has_text:
                try:
                    now = _text(node, max(4000, len(value) * 2))
                    verified = (now == value) if action == "set_text" else (value in now)
                except GLib.Error:
                    verified = None
            return {"done": bool(done), "via": f"atspi:{action}", "verified": verified}
        raise error("invalid_params", f"Unknown element action {clean(action, 40)}.")

    def insert_at_focus(self, text: str) -> bool:
        """Text into the focused editable element at its caret; False when nothing editable has the focus."""
        current = self.active()
        if current["window"] is None:
            return False
        node = self._find_focused(current["window"])
        if node is None or node.get_role_name() == "password text" or _iface(node, "editable_text") is None:
            return False
        try:
            has_text = _iface(node, "text") is not None
            caret = _caret(node) if has_text else -1
            position = caret if caret >= 0 else (Atspi.Text.get_character_count(node) if has_text else 0)
            return bool(Atspi.EditableText.insert_text(node, position, text, len(text.encode("utf-8"))))
        except GLib.Error:
            return False

    def window_active(self, app) -> bool:
        for _, window in self._windows(app):
            state_set, _ = _states(window)
            if state_set is not None and state_set.contains(Atspi.StateType.ACTIVE):
                return True
        return False

    def grab_window(self, app) -> bool:
        for _, window in self._windows(app):
            if _iface(window, "component") is None:
                continue
            try:
                if Atspi.Component.grab_focus(window):
                    return True
            except GLib.Error:
                continue
        return False


def host(url: str | None) -> str | None:
    if not url or "://" not in url:
        return None
    try:
        return urlsplit(url).hostname
    except ValueError:
        return None
