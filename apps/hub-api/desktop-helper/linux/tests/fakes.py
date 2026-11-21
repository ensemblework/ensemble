"""Stand-ins for AT-SPI nodes, the desktop portal and the helper's state, so the helper's own code runs
in tests without a desktop."""
from __future__ import annotations

import time
from typing import Any

from desktop_helper import readiness
from desktop_helper.a11y import Atspi
from desktop_helper.server import Helper

SHOWING = Atspi.StateType.SHOWING
ACTIVE = Atspi.StateType.ACTIVE
FOCUSED = Atspi.StateType.FOCUSED


class StateSet:
    def __init__(self, states):
        self.states = set(states)

    def contains(self, state) -> bool:
        return state in self.states


class Node:
    """An accessible: its role, name, states, children, interfaces and (for documents) attributes."""

    def __init__(self, role: str, name: str = "", children=(), states=(SHOWING,), interfaces=(), attributes=None, toolkit: str = "", pid: int | None = None):
        self.role = role
        self.name = name
        self.children = list(children)
        self.states = set(states)
        self.interfaces = list(interfaces)
        self.attributes = dict(attributes or {})
        self.toolkit = toolkit
        self.pid = pid
        self.parent = None
        for child in self.children:
            child.parent = self

    def get_role(self):
        return Atspi.Role.DOCUMENT_WEB if self.role == "document web" else Atspi.Role.PANEL

    def get_role_name(self) -> str:
        return self.role

    def get_name(self) -> str:
        return self.name

    def get_state_set(self) -> StateSet:
        return StateSet(self.states)

    def get_child_count(self) -> int:
        return len(self.children)

    def get_child_at_index(self, index: int):
        return self.children[index]

    def get_interfaces(self) -> list[str]:
        return list(self.interfaces)

    def get_toolkit_name(self) -> str:
        return self.toolkit

    def get_process_id(self):
        return self.pid

    def get_parent(self):
        return self.parent


class Document:
    """`Atspi.Document` for fake nodes: their attributes."""

    @staticmethod
    def get_document_attribute_value(node, name):
        return node.attributes.get(name)

    @staticmethod
    def get_attribute_value(node, name):
        return node.attributes.get(name)

    @staticmethod
    def get_document_attributes(node):
        return dict(node.attributes)


def browser(name: str, toolkit: str, page: Node | None, title: str = "Page", active: bool = True, pid: int = 4242) -> Node:
    """A browser app with one window holding `page` a few levels down, as Chromium and WebKitGTK nest it."""
    inner = [Node("panel", children=[Node("panel", children=[page])])] if page is not None else [Node("panel", children=[Node("push button", "Reload")])]
    window = Node("frame", title, children=inner, states=(SHOWING, ACTIVE) if active else (SHOWING,))
    return Node("application", name, children=[window], toolkit=toolkit, pid=pid)


class Portal:
    """The desktop portal session as the helper's input code uses it: every call is recorded."""

    def __init__(self, clipboard: bool = True, clipboard_text: str | None = "owner's text"):
        self.state = "on"
        self.clipboard = clipboard
        self.calls: list[tuple] = []
        self.last_key_at = time.monotonic()
        self.clipboard_text = clipboard_text

    def pointer_to(self, stream, x, y):
        self.calls.append(("pointer_to", stream, round(x, 3), round(y, 3)))

    def pointer_button(self, button, pressed):
        self.calls.append(("button", button, pressed))

    def pointer_axis(self, axis, steps):
        self.calls.append(("axis", axis, steps))

    def keysym(self, sym, pressed):
        self.calls.append(("keysym", sym, pressed))
        self.last_key_at = time.monotonic()

    def clipboard_snapshot(self):
        self.calls.append(("snapshot",))
        return {"text": self.clipboard_text} if self.clipboard_text is not None else None

    def clipboard_offer(self, text):
        self.calls.append(("offer", text))

    def clipboard_restore(self, snapshot):
        self.calls.append(("restore", snapshot))

    def clipboard_clear(self):
        self.calls.append(("clear",))

    def typed(self) -> str:
        return "".join(chr(sym) for kind, sym, pressed in (call for call in self.calls if call[0] == "keysym") if pressed and sym < 0x100)


class A11y:
    """The accessibility side of typing: the window in front, insertion at the caret, a password field's text."""

    def __init__(self, insert: bool = False, fill: bool = False):
        self.insert = insert
        self.fill = fill
        self.key = (501, 0)
        self.inserted: list[str] = []
        self.filled: list[str] = []

    def active_key(self):
        return self.key

    def insert_at_focus(self, text: str) -> bool:
        if self.insert:
            self.inserted.append(text)
        return self.insert

    def set_focused_secret(self, text: str) -> bool:
        if self.fill:
            self.filled.append(text)
        return self.fill


def helper(portal: Portal, a11y: A11y | None = None, geometry: dict[int, dict[str, Any]] | None = None, idle=None) -> Helper:
    """A Helper with its portal, accessibility and idle time replaced; nothing else of it is set up."""
    out = Helper.__new__(Helper)
    out.portal = portal
    out.agent = None
    out.a11y = a11y or A11y()
    out.cancelled = set()
    out.proven = readiness.Proven()
    out.geometry = geometry or {42: {"node": 42, "x": 0, "y": 0, "width": 2560, "height": 1440, "frame_width": 2560, "frame_height": 1440}}
    out.sources = {node: _Source() for node in out.geometry}
    out._locked_idle = idle or (lambda: (False, int((time.monotonic() - portal.last_key_at) * 1000)))
    return out


class _Source:
    error = None
